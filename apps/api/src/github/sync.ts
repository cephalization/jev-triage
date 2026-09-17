import { Octokit } from "octokit";
import { newId, sql } from "../db.ts";
import { env } from "../env.ts";
import { syncPulls } from "./pulls.ts";

/**
 * GitHub → Postgres sync, newest first.
 *
 * Walks `issues.listForRepo` sorted by `updated` descending, one page per transaction, so the
 * most recently touched issues land (and get classified) within a second or two.
 *
 *  - recent phase: everything updated in the last year, or down to the previous high-water
 *    mark (`repo.sync_cursor`) on a re-sync;
 *  - history phase: anything older, fetched slowly (one page every HISTORY_PAGE_DELAY_MS) so it
 *    never competes with the live parts; resumable via `repo.history_cursor`;
 *  - `repo.sync_limit` caps the number of issues kept (testing knob; default 100);
 *  - pull requests (see pulls.ts) are fetched once the recent issue phase ends, before the
 *    slow history backfill, so open pulls and the reviewer roster land early.
 *
 * Progress lives on the repo row (`sync_phase`, `sync_fetched`, ...) and streams to clients.
 */

const YEAR_MS = 365 * 86_400_000;
const HISTORY_PAGE_DELAY_MS = 4_000;

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

function makeOctokit() {
  return new Octokit({
    auth: env.githubToken ?? undefined,
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

type Phase = "recent" | "history";

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
  let phase: Phase = "recent";
  let finalPhase = "done";

  const { data: meta } = await octokit.rest.repos.get({ owner, repo: name });
  await sql`
    insert into repo (id, owner, name, description, default_branch, open_issues, sync_status, sync_error, paused, sync_limit,
      sync_phase, sync_fetched, sync_pages, sync_started_at, sync_message)
    values (${repoId}, ${owner}, ${name}, ${meta.description ?? null}, ${meta.default_branch}, ${meta.open_issues_count}, 'running', null,
      ${opts.paused ?? false}, ${opts.limit ?? 100}, 'recent', 0, 0, now(), 'fetching newest issues')
    on conflict (id) do update set description = excluded.description, default_branch = excluded.default_branch,
      open_issues = excluded.open_issues, sync_status = 'running', sync_error = null, sync_phase = 'recent',
      sync_fetched = 0, sync_pages = 0, sync_started_at = now(), sync_message = 'fetching newest issues'`;
  await sql`insert into worker_state (repo_id) values (${repoId}) on conflict do nothing`;
  await sql`insert into run (id, repo_id, kind, status) values (${runId}, ${repoId}, 'sync', 'running')`;

  try {
    const repoRows = await sql<
      {
        sync_cursor: string | null;
        sync_limit: number;
        history_complete: boolean;
        history_cursor: string | null;
      }[]
    >`
      select sync_cursor, sync_limit, history_complete, history_cursor from repo where id = ${repoId}`;
    const repo = repoRows[0]!;
    const highWater = repo.sync_cursor;
    const limit = repo.sync_limit;
    const yearAgo = new Date(started - YEAR_MS).toISOString();
    let newestSeen: string | null = null;
    let oldestSeen: string | null = repo.history_cursor;
    let historyDone = repo.history_complete;

    await syncLabels(octokit, owner, name, repoId);
    const existing = new Set(
      (await sql<{ id: string }[]>`select id from issue where repo_id = ${repoId}`).map(
        (r) => r.id,
      ),
    );
    let total = existing.size;
    let capped = total >= limit;
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
      state: "all",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });

    walk: for await (const page of iterator) {
      pages += 1;
      const remaining = Number(page.headers["x-ratelimit-remaining"] ?? "1000");
      const reset = Number(page.headers["x-ratelimit-reset"] ?? "0") * 1000;
      const toStore: IssueItem[] = [];
      let reachedKnown = false;
      for (const raw of page.data as IssueItem[]) {
        if (raw.pull_request) {
          skippedPulls += 1;
          continue;
        }
        if (!newestSeen) newestSeen = raw.updated_at;
        const known = existing.has(raw.node_id);
        if (phase === "recent" && highWater && raw.updated_at <= highWater) {
          // From here down everything was stored by an earlier run.
          reachedKnown = true;
          if (historyDone) break;
          if (oldestSeen && raw.updated_at >= oldestSeen) continue;
          phase = "history";
        }
        if (phase === "recent" && !highWater && raw.updated_at < yearAgo) phase = "history";
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
        const oldest = toStore[toStore.length - 1]!.updated_at;
        if (!oldestSeen || oldest < oldestSeen) oldestSeen = oldest;
        hooks.onPage?.(repoId, toStore.length);
      }
      await progress(repoId, {
        sync_phase: phase,
        sync_fetched: stored,
        sync_pages: pages,
        sync_rate_remaining: remaining,
        history_cursor: oldestSeen,
        last_synced_at: new Date(),
        sync_message:
          phase === "recent"
            ? `fetching newest issues · page ${pages}`
            : `backfilling history · page ${pages} · one page every ${HISTORY_PAGE_DELAY_MS / 1000}s`,
      });
      console.log(
        `[sync] ${repoId} ${phase} page ${pages}: stored ${toStore.length} (total ${total}/${limit}, rate ${remaining})`,
      );

      if (capped) {
        finalPhase = "capped";
        // Keep walking only while there may be fresh updates to stored issues ahead.
        if (reachedKnown || !highWater) break walk;
      }
      if (reachedKnown && historyDone) break walk;
      // Recent issues are in; fetch pull requests before the slow backfill.
      if (phase === "history") await pullsOnce();
      if (remaining < 5 && reset > Date.now()) {
        const wait = reset - Date.now() + 1000;
        await progress(repoId, {
          sync_message: `rate limited · resuming in ${Math.round(wait / 1000)}s`,
        });
        await new Promise((r) => setTimeout(r, wait));
      } else if (phase === "history") {
        await new Promise((r) => setTimeout(r, HISTORY_PAGE_DELAY_MS));
      }
    }
    if (finalPhase !== "capped") historyDone = true;
    await pullsOnce();

    await sql`update repo set sync_status = 'idle', sync_error = null, last_synced_at = now(),
      sync_cursor = ${newestSeen ?? highWater}, history_complete = ${historyDone}, history_cursor = ${oldestSeen},
      sync_phase = ${finalPhase}, sync_message = ${finalPhase === "capped" ? `capped at ${limit} issues` : "up to date"}
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
