import { Octokit } from "octokit";
import { newId, sql } from "../db.ts";
import { env } from "../env.ts";

/**
 * Incremental GitHub → Postgres sync. One page per transaction so clients watching
 * through Zero see progress live. `repo.sync_cursor` is the max `updated_at` seen,
 * fetched in ascending order so a crash mid-way resumes correctly.
 */

type ThrottleOptions = { method: string; url: string };

const inFlight = new Map<string, Promise<SyncResult>>();

export interface SyncResult {
  repoId: string;
  pages: number;
  issues: number;
  skippedPulls: number;
  cursor: string | null;
}

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

export function syncRepo(owner: string, name: string, paused = false): Promise<SyncResult> {
  const id = `${owner}/${name}`;
  const existing = inFlight.get(id);
  if (existing) return existing;
  const p = runSync(owner, name, paused).finally(() => inFlight.delete(id));
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

async function runSync(owner: string, name: string, paused: boolean): Promise<SyncResult> {
  const repoId = `${owner}/${name}`;
  const octokit = makeOctokit();
  const runId = newId();
  const started = Date.now();
  let pages = 0;
  let issues = 0;
  let skippedPulls = 0;

  const { data: meta } = await octokit.rest.repos.get({ owner, repo: name });
  await sql`
    insert into repo (id, owner, name, description, default_branch, open_issues, sync_status, sync_error, paused)
    values (${repoId}, ${owner}, ${name}, ${meta.description ?? null}, ${meta.default_branch}, ${meta.open_issues_count}, 'running', null, ${paused})
    on conflict (id) do update set description = excluded.description, default_branch = excluded.default_branch,
      open_issues = excluded.open_issues, sync_status = 'running', sync_error = null`;
  await sql`insert into worker_state (repo_id) values (${repoId}) on conflict do nothing`;
  await sql`insert into run (id, repo_id, kind, status) values (${runId}, ${repoId}, 'sync', 'running')`;

  try {
    const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
      owner,
      repo: name,
      per_page: 100,
    });
    if (labels.length > 0) {
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

    const cursorRows = await sql<{ sync_cursor: string | null }[]>`
      select sync_cursor from repo where id = ${repoId}`;
    const cursor = cursorRows[0]?.sync_cursor ?? null;
    let maxUpdated = cursor;

    const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
      owner,
      repo: name,
      state: "all",
      sort: "updated",
      direction: "asc",
      per_page: 100,
      ...(cursor ? { since: cursor } : {}),
    });

    for await (const page of iterator) {
      pages += 1;
      const remaining = Number(page.headers["x-ratelimit-remaining"] ?? "1000");
      const reset = Number(page.headers["x-ratelimit-reset"] ?? "0") * 1000;
      const items = (page.data as IssueItem[]).filter((i) => {
        if (i.pull_request) {
          skippedPulls += 1;
          return false;
        }
        return true;
      });
      if (items.length > 0) {
        await upsertPage(repoId, items);
        issues += items.length;
        for (const i of items)
          if (!maxUpdated || i.updated_at > maxUpdated) maxUpdated = i.updated_at;
      }
      await sql`update repo set sync_cursor = ${maxUpdated}, last_synced_at = now() where id = ${repoId}`;
      console.log(
        `[sync] ${repoId} page ${pages}: ${items.length} issues (rate limit remaining ${remaining})`,
      );
      if (remaining < 5 && reset > Date.now()) {
        const wait = reset - Date.now() + 1000;
        console.warn(`[sync] ${repoId} near rate limit; sleeping ${Math.round(wait / 1000)}s`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    await sql`update repo set sync_status = 'idle', sync_error = null, last_synced_at = now() where id = ${repoId}`;
    await sql`update run set finished_at = now(), status = 'ok', issues = ${issues}, latency_ms = ${Date.now() - started} where id = ${runId}`;
    return { repoId, pages, issues, skippedPulls, cursor: maxUpdated };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sql`update repo set sync_status = 'error', sync_error = ${message} where id = ${repoId}`;
    await sql`update run set finished_at = now(), status = 'error', error = ${message}, issues = ${issues}, latency_ms = ${Date.now() - started} where id = ${runId}`;
    throw e;
  }
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
