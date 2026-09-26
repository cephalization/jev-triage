import { Octokit } from "octokit";
import { newId, sql } from "../db.ts";
import { env } from "../env.ts";
import { syncPulls } from "./pulls.ts";

/**
 * GitHub → Postgres sync: open issues only, newest first.
 *
 * Every sync walks `issues.listForRepo` for open issues sorted by `updated` descending, one
 * page per transaction, so the most recently touched issues land (and get classified) within
 * a second or two. The whole open list is looked at each time (a page holds 100), which is how
 * closures are noticed: an issue stored as open that no longer appears has closed since.
 *
 *  - `repo.sync_limit` caps how many open issues are kept; the most recently updated win, and
 *    the walk stops at the cap because nothing older could be stored;
 *  - closed issues are never fetched; rows that close stay as history;
 *  - pull requests (see pulls.ts) follow the issue walk.
 *
 * Progress lives on the repo row (`sync_phase`, `sync_fetched`, ...) and streams to clients.
 */

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
  opts: { paused?: boolean; limit?: number } = {},
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
  opts: { paused?: boolean; limit?: number },
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
    insert into repo (id, owner, name, description, default_branch, open_issues, sync_status, sync_error, paused, sync_limit,
      sync_phase, sync_fetched, sync_pages, sync_started_at, sync_message)
    values (${repoId}, ${owner}, ${name}, ${meta.description ?? null}, ${meta.default_branch}, ${meta.open_issues_count}, 'running', null,
      ${opts.paused ?? false}, ${opts.limit ?? 100}, 'issues', 0, 0, now(), 'fetching open issues')
    on conflict (id) do update set description = excluded.description, default_branch = excluded.default_branch,
      open_issues = excluded.open_issues, sync_status = 'running', sync_error = null, sync_phase = 'issues',
      sync_fetched = 0, sync_pages = 0, sync_started_at = now(), sync_message = 'fetching open issues'`;
  await sql`insert into worker_state (repo_id) values (${repoId}) on conflict do nothing`;
  await sql`insert into run (id, repo_id, kind, status) values (${runId}, ${repoId}, 'sync', 'running')`;

  try {
    const [repo] = await sql<{ sync_limit: number }[]>`
      select sync_limit from repo where id = ${repoId}`;
    const limit = repo!.sync_limit;

    await syncLabels(octokit, owner, name, repoId);
    const existing = new Set(
      (await sql<{ id: string }[]>`select id from issue where repo_id = ${repoId}`).map(
        (r) => r.id,
      ),
    );
    // The cap counts open issues; closed rows stay as history and cost nothing to keep.
    const [openRow] = await sql<{ open: number }[]>`
      select count(*)::int as open from issue where repo_id = ${repoId} and state = 'open'`;
    let total = openRow?.open ?? 0;
    let capped = false;
    let pullsDone = false;
    const pullsOnce = async () => {
      if (pullsDone) return;
      pullsDone = true;
      if (!env.githubToken) {
        await progress(repoId, { sync_message: "pull requests need GITHUB_TOKEN; skipped" });
        return;
      }
      try {
        const r = await syncPulls(octokit, owner, name, repoId, (f) => progress(repoId, f), {
          onPage: hooks.onPage,
        });
        console.log(
          `[sync] ${repoId} pulls: ${r.open} open, ${r.history} history, ${r.pages} pages`,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[sync] ${repoId} pulls failed: ${message}`);
        await progress(repoId, { sync_message: `pull requests failed: ${message}` });
      }
    };

    const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
      owner,
      repo: name,
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });

    const seen = new Set<string>();
    let oldestSeen: string | null = null;
    let complete = true;
    for await (const page of iterator) {
      pages += 1;
      const remaining = Number(page.headers["x-ratelimit-remaining"] ?? "1000");
      const reset = Number(page.headers["x-ratelimit-reset"] ?? "0") * 1000;
      const toStore: IssueItem[] = [];
      for (const raw of page.data as IssueItem[]) {
        oldestSeen = raw.updated_at;
        if (raw.pull_request) {
          skippedPulls += 1;
          continue;
        }
        seen.add(raw.node_id);
        const known = existing.has(raw.node_id);
        if (!known && total >= limit) {
          // The cap only limits new issues; updates to stored issues always apply.
          capped = true;
          continue;
        }
        toStore.push(raw);
        if (!known) {
          existing.add(raw.node_id);
          total += 1;
        }
      }

      if (toStore.length > 0) {
        await upsertPage(repoId, toStore);
        stored += toStore.length;
        hooks.onPage?.(repoId, toStore.length);
      }
      await progress(repoId, {
        sync_phase: "issues",
        sync_fetched: stored,
        sync_pages: pages,
        sync_rate_remaining: remaining,
        last_synced_at: new Date(),
        sync_message: `fetching open issues · page ${pages}`,
      });
      console.log(
        `[sync] ${repoId} issues page ${pages}: stored ${toStore.length} (total ${total}/${limit}, rate ${remaining})`,
      );

      if (capped) {
        // Nothing older could be stored, so the rest of the listing is not worth the requests.
        finalPhase = "capped";
        complete = false;
        break;
      }
      if (remaining < 5 && reset > Date.now()) {
        const wait = reset - Date.now() + 1000;
        await progress(repoId, {
          sync_message: `rate limited · resuming in ${Math.round(wait / 1000)}s`,
        });
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    // Anything stored as open and not seen again has closed since. When the walk was capped,
    // only rows updated at least as recently as the oldest issue looked at can be judged.
    const seenIds = [...seen];
    const closed = complete
      ? await sql`update issue set state = 'closed', closed_at = coalesce(closed_at, now())
          where repo_id = ${repoId} and state = 'open' and id <> all(${sql.array(seenIds)})`
      : oldestSeen
        ? await sql`update issue set state = 'closed', closed_at = coalesce(closed_at, now())
          where repo_id = ${repoId} and state = 'open' and updated_at >= ${oldestSeen}
          and id <> all(${sql.array(seenIds)})`
        : null;
    if (closed && closed.count > 0)
      console.log(`[sync] ${repoId}: ${closed.count} issues closed since the last sync`);
    await pullsOnce();

    await sql`update repo set sync_status = 'idle', sync_error = null, last_synced_at = now(),
      sync_phase = ${finalPhase}, sync_message = ${finalPhase === "capped" ? `capped at ${limit} open issues` : "up to date"}
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
