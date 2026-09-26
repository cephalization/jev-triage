import Bottleneck from "bottleneck";
import { Octokit } from "octokit";
import { newId, sql } from "../db.ts";
import { env } from "../env.ts";
import { syncPulls } from "./pulls.ts";

/**
 * GitHub → Postgres sync: open issues only, as fast as the API allows.
 *
 * Every sync lists the repository's open issues sorted by `updated` descending. The page
 * count is known up front (GitHub's open_issues_count includes pull requests, and so does the
 * listing), so pages are fetched several at a time and written as they arrive, each page in
 * its own transaction, so the most recently touched issues land (and get classified) within
 * a second or two. The whole open list is looked at each time, which is how closures are
 * noticed: an issue stored as open that no longer appears has closed since.
 *
 *  - closed issues are never fetched; rows that close stay as history;
 *  - there is no cap: every open issue is kept;
 *  - pull requests (see pulls.ts) are walked at the same time.
 *
 * Tuned for speed; only GitHub's rate limits hold it back. Recalibrate the constants here if
 * secondary limits show up.
 *
 * Progress lives on the repo row (`sync_phase`, `sync_fetched`, ...) and streams to clients.
 */

/** Issues per page: the API's maximum. */
const PAGE = 100;
/** Pages requested at once. GitHub's secondary limits start far above this. */
const PAGE_CONCURRENCY = 6;

type ThrottleOptions = { method: string; url: string };

const inFlight = new Map<string, Promise<SyncResult>>();

export interface SyncResult {
  repoId: string;
  pages: number;
  issues: number;
  skippedPulls: number;
  phase: string;
}

export type SyncHooks = {
  /** Called after each stored page so classification can start immediately. */
  onPage?: (repoId: string, stored: number) => void;
};

/** No GitHub call may hang a sync: past this, the request fails and the sync reports it. */
const GITHUB_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The throttling plugin rates GraphQL like writes: one request per second, one at a time.
 * Every GraphQL call here is a read (this app never writes to GitHub), so it gets a limiter
 * without that floor; the plugin's own limits for REST reads and retries stay.
 */
const graphqlLimiter = new Bottleneck.Group({
  id: "typeful-graphql",
  maxConcurrent: 2,
  minTime: 0,
});

export function makeOctokit() {
  return new Octokit({
    auth: env.githubToken ?? undefined,
    baseUrl: env.githubSyncApiUrl,
    request: {
      fetch: (url: string | URL | Request, init?: RequestInit) => {
        const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        return fetch(url, { ...init, signal });
      },
    },
    throttle: {
      write: graphqlLimiter,
      onRateLimit: (
        retryAfter: number,
        options: ThrottleOptions,
        _o: unknown,
        retryCount: number,
      ) => {
        console.warn(
          `[sync] rate limited on ${options.method} ${options.url}; retry in ${retryAfter}s`,
        );
        return retryCount < 2;
      },
      onSecondaryRateLimit: (
        retryAfter: number,
        options: ThrottleOptions,
        _o: unknown,
        retryCount: number,
      ) => {
        console.warn(`[sync] secondary rate limit on ${options.url}; retry in ${retryAfter}s`);
        return retryCount < 2;
      },
    },
  });
}

export function isSyncing(repoId: string): boolean {
  return inFlight.has(repoId);
}

/** Starts (or joins) a sync. Resolves when the whole run, including history, is done. */
export function syncRepo(
  owner: string,
  name: string,
  hooks: SyncHooks = {},
  opts: { paused?: boolean } = {},
): Promise<SyncResult> {
  const id = `${owner}/${name}`;
  const existing = inFlight.get(id);
  if (existing) return existing;
  const p = runSync(owner, name, hooks, opts).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

type IssueItem = {
  node_id: string;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  user?: { login: string } | null;
  author_association: string;
  labels: Array<
    | string
    | {
        id?: number;
        node_id?: string;
        name?: string;
        color?: string | null;
        description?: string | null;
      }
  >;
  comments: number;
  reactions?: { total_count: number };
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  html_url: string;
  pull_request?: unknown;
};

async function progress(repoId: string, fields: Record<string, unknown>) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return;
  await sql`update repo set ${sql(fields, ...cols)} where id = ${repoId}`;
}

async function runSync(
  owner: string,
  name: string,
  hooks: SyncHooks,
  opts: { paused?: boolean },
): Promise<SyncResult> {
  const repoId = `${owner}/${name}`;
  const octokit = makeOctokit();
  const runId = newId();
  const started = Date.now();
  let pages = 0;
  let stored = 0;
  let skippedPulls = 0;
  let finalPhase = "done";

  const { data: meta } = await octokit.rest.repos.get({ owner, repo: name });
  await sql`
    insert into repo (id, owner, name, description, default_branch, open_issues, sync_status, sync_error, paused,
      sync_phase, sync_fetched, sync_pages, sync_started_at, sync_message)
    values (${repoId}, ${owner}, ${name}, ${meta.description ?? null}, ${meta.default_branch}, ${meta.open_issues_count}, 'running', null,
      ${opts.paused ?? false}, 'issues', 0, 0, now(), 'fetching open issues')
    on conflict (id) do update set description = excluded.description, default_branch = excluded.default_branch,
      open_issues = excluded.open_issues, sync_status = 'running', sync_error = null, sync_phase = 'issues',
      sync_fetched = 0, sync_pages = 0, sync_started_at = now(), sync_message = 'fetching open issues'`;
  await sql`insert into worker_state (repo_id) values (${repoId}) on conflict do nothing`;
  await sql`insert into run (id, repo_id, kind, status) values (${runId}, ${repoId}, 'sync', 'running')`;

  try {
    await syncLabels(octokit, owner, name, repoId);
    // The issue pages and the pull walks share one status line and one page counter.
    const status = { issues: "", pulls: "" };
    let pullPages = 0;
    const report = (fields: Record<string, unknown>) =>
      progress(repoId, {
        ...fields,
        sync_pages: pages + pullPages,
        sync_message: [status.issues, status.pulls].filter(Boolean).join(" · "),
      });
    const syncPullsToo = async () => {
      if (!env.githubToken) {
        status.pulls = "pull requests need GITHUB_TOKEN; skipped";
        await report({});
        return;
      }
      try {
        const r = await syncPulls(
          octokit,
          owner,
          name,
          repoId,
          ({ sync_phase: _phase, sync_pages, sync_message, ...rest }) => {
            if (typeof sync_pages === "number") pullPages = sync_pages;
            if (typeof sync_message === "string") status.pulls = sync_message;
            return report(rest);
          },
          { onPage: hooks.onPage },
        );
        console.log(
          `[sync] ${repoId} pulls: ${r.open} open, ${r.history} history, ${r.pages} pages`,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[sync] ${repoId} pulls failed: ${message}`);
        status.pulls = `pull requests failed: ${message}`;
        await report({});
      }
    };
    const pulls = syncPullsToo();

    const seen = new Set<string>();
    // Pages are fetched concurrently and written in arrival order through one chain, so the
    // label and issue upserts of different pages never contend.
    let writes: Promise<void> = Promise.resolve();
    const expectedPages = Math.ceil(meta.open_issues_count / PAGE);
    const fetchPage = async (page: number): Promise<number> => {
      const { data, headers } = await octokit.rest.issues.listForRepo({
        owner,
        repo: name,
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: PAGE,
        page,
      });
      const items = data as IssueItem[];
      const toStore: IssueItem[] = [];
      for (const raw of items) {
        if (raw.pull_request) {
          skippedPulls += 1;
          continue;
        }
        seen.add(raw.node_id);
        toStore.push(raw);
      }
      const remaining = Number(headers["x-ratelimit-remaining"] ?? "0");
      writes = writes.then(async () => {
        pages += 1;
        if (toStore.length > 0) {
          await upsertPage(repoId, toStore);
          stored += toStore.length;
          hooks.onPage?.(repoId, toStore.length);
        }
        status.issues = `fetching open issues · page ${pages} of ${Math.max(expectedPages, pages)}`;
        await report({
          sync_phase: "issues",
          sync_fetched: stored,
          sync_rate_remaining: remaining,
          last_synced_at: new Date(),
        });
        console.log(
          `[sync] ${repoId} issues page ${page}: stored ${toStore.length} (rate ${remaining})`,
        );
      });
      return items.length;
    };
    await inParallel(expectedPages, PAGE_CONCURRENCY, fetchPage);
    // Issues opened since the count was read push the oldest onto pages past the estimate.
    for (let page = expectedPages + 1; (await fetchPage(page)) === PAGE; page += 1);
    await writes;

    // Anything stored as open and not seen again has closed since.
    const closed =
      await sql`update issue set state = 'closed', closed_at = coalesce(closed_at, now())
      where repo_id = ${repoId} and state = 'open' and id <> all(${sql.array([...seen])})`;
    if (closed.count > 0)
      console.log(`[sync] ${repoId}: ${closed.count} issues closed since the last sync`);
    status.issues = "issues up to date";
    await report({});
    await pulls;

    await sql`update repo set sync_status = 'idle', sync_error = null, last_synced_at = now(),
      sync_pages = ${pages + pullPages}, sync_phase = ${finalPhase}, sync_message = 'up to date'
      where id = ${repoId}`;
    await sql`update run set finished_at = now(), status = 'ok', issues = ${stored}, latency_ms = ${Date.now() - started} where id = ${runId}`;
    return { repoId, pages, issues: stored, skippedPulls, phase: finalPhase };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sql`update repo set sync_status = 'error', sync_error = ${message}, sync_phase = 'error', sync_message = ${message} where id = ${repoId}`;
    await sql`update run set finished_at = now(), status = 'error', error = ${message}, issues = ${stored}, latency_ms = ${Date.now() - started} where id = ${runId}`;
    throw e;
  }
}

async function syncLabels(octokit: Octokit, owner: string, name: string, repoId: string) {
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    owner,
    repo: name,
    per_page: 100,
  });
  if (labels.length === 0) return;
  await sql`
    insert into label ${sql(
      labels.map((l) => ({
        id: l.node_id,
        repo_id: repoId,
        name: l.name,
        color: l.color ?? "",
        description: l.description ?? null,
      })),
      "id",
      "repo_id",
      "name",
      "color",
      "description",
    )}
    on conflict (id) do update set name = excluded.name, color = excluded.color, description = excluded.description`;
}

/** Runs `fn(1..n)` with at most `limit` calls in flight; the first failure rejects the whole thing. */
async function inParallel(n: number, limit: number, fn: (i: number) => Promise<unknown>) {
  let next = 1;
  const worker = async () => {
    while (next <= n) {
      const i = next;
      next += 1;
      await fn(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, n) }, worker));
}

async function upsertPage(repoId: string, items: IssueItem[]) {
  const labelRows = new Map<
    string,
    { id: string; repo_id: string; name: string; color: string; description: string | null }
  >();
  const issueRows = items.map((i) => {
    const names: string[] = [];
    for (const l of i.labels) {
      if (typeof l === "string") {
        names.push(l);
        continue;
      }
      if (l.node_id && l.name) {
        names.push(l.name);
        labelRows.set(l.node_id, {
          id: l.node_id,
          repo_id: repoId,
          name: l.name,
          color: l.color ?? "",
          description: l.description ?? null,
        });
      }
    }
    return {
      id: i.node_id,
      repo_id: repoId,
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      state: i.state,
      author: i.user?.login ?? "",
      author_association: i.author_association ?? "",
      labels_json: sql.json(names),
      comments: i.comments,
      reactions: i.reactions?.total_count ?? 0,
      created_at: i.created_at,
      updated_at: i.updated_at,
      closed_at: i.closed_at ?? null,
      url: i.html_url,
    };
  });
  const links: Array<{ issue_id: string; label_id: string }> = [];
  for (const i of items) {
    for (const l of i.labels) {
      if (typeof l !== "string" && l.node_id)
        links.push({ issue_id: i.node_id, label_id: l.node_id });
    }
  }

  await sql.begin(async (tx) => {
    if (labelRows.size > 0) {
      await tx`insert into label ${tx([...labelRows.values()], "id", "repo_id", "name", "color", "description")}
        on conflict (id) do update set name = excluded.name, color = excluded.color`;
    }
    await tx`insert into issue ${tx(
      issueRows,
      "id",
      "repo_id",
      "number",
      "title",
      "body",
      "state",
      "author",
      "author_association",
      "labels_json",
      "comments",
      "reactions",
      "created_at",
      "updated_at",
      "closed_at",
      "url",
    )}
      on conflict (id) do update set title = excluded.title, body = excluded.body, state = excluded.state,
        author = excluded.author, author_association = excluded.author_association, labels_json = excluded.labels_json,
        comments = excluded.comments, reactions = excluded.reactions, updated_at = excluded.updated_at,
        closed_at = excluded.closed_at, url = excluded.url`;
    const ids = issueRows.map((r) => r.id);
    await tx`delete from issue_label where issue_id in ${tx(ids)}`;
    if (links.length > 0) {
      await tx`insert into issue_label ${tx(links, "issue_id", "label_id")} on conflict do nothing`;
    }
  });
}
