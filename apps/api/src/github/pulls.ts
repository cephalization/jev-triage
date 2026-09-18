import type { Octokit } from "octokit";
import { deriveReviewers, type PullForStats, type ReviewEvent } from "@triage/triage/reviewers";
import { sql } from "../db.ts";

/**
 * Pull request sync over GraphQL (one query returns files, reviews and requested reviewers,
 * which REST spreads over three endpoints). Two walks, both newest-updated first:
 *  - open pulls, up to `repo.pull_limit` (default 200): the ones to review;
 *  - merged/closed pulls, up to `repo.pull_history_limit` (default 300): who reviewed what,
 *    folded into the `reviewer` table after every page so the roster streams in.
 * Needs GITHUB_TOKEN (GraphQL is never anonymous); without it the phase is skipped with a message.
 */

const PAGE = 25;
const FILES_KEPT = 100;
const HISTORY_PAGE_DELAY_MS = 1_000;

const QUERY = /* GraphQL */ `
  query Pulls(
    $owner: String!
    $name: String!
    $states: [PullRequestState!]!
    $first: Int!
    $after: String
  ) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        states: $states
        first: $first
        after: $after
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          number
          title
          body
          state
          isDraft
          url
          createdAt
          updatedAt
          closedAt
          mergedAt
          author {
            login
          }
          authorAssociation
          headRefName
          headRefOid
          baseRefName
          additions
          deletions
          changedFiles
          reviewDecision
          mergeable
          comments {
            totalCount
          }
          mergedBy {
            login
          }
          labels(first: 20) {
            nodes {
              name
            }
          }
          reviewRequests(first: 10) {
            nodes {
              requestedReviewer {
                __typename
                ... on User {
                  login
                }
                ... on Team {
                  slug
                }
              }
            }
          }
          files(first: 100) {
            nodes {
              path
            }
          }
          reviews(last: 50) {
            nodes {
              id
              state
              submittedAt
              author {
                login
              }
            }
          }
        }
      }
    }
    rateLimit {
      remaining
      resetAt
      cost
    }
  }
`;

interface PullNode {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  author: { login: string } | null;
  authorAssociation: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  mergeable: string | null;
  comments: { totalCount: number };
  mergedBy: { login: string } | null;
  labels: { nodes: Array<{ name: string } | null> };
  reviewRequests: {
    nodes: Array<{
      requestedReviewer: { __typename: string; login?: string; slug?: string } | null;
    } | null>;
  };
  files: { nodes: Array<{ path: string } | null> } | null;
  reviews: {
    nodes: Array<{
      id: string;
      state: string;
      submittedAt: string | null;
      author: { login: string } | null;
    } | null>;
  };
}

interface PullsResponse {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<PullNode | null>;
    };
  };
  rateLimit: { remaining: number; resetAt: string; cost: number };
}

export interface PullSyncProgress {
  (fields: Record<string, unknown>): Promise<void>;
}

export interface PullSyncHooks {
  onPage?: (repoId: string, stored: number) => void;
}

export interface PullSyncResult {
  open: number;
  history: number;
  pages: number;
}

export async function syncPulls(
  octokit: Octokit,
  owner: string,
  name: string,
  repoId: string,
  progress: PullSyncProgress,
  hooks: PullSyncHooks = {},
): Promise<PullSyncResult> {
  const [repo] = await sql<{ pull_limit: number; pull_history_limit: number }[]>`
    select pull_limit, pull_history_limit from repo where id = ${repoId}`;
  const openLimit = repo?.pull_limit ?? 200;
  const historyLimit = repo?.pull_history_limit ?? 300;
  let pages = 0;

  const walk = async (
    states: string[],
    limit: number,
    phase: string,
    message: string,
    delayMs: number,
  ): Promise<{ seen: Set<string>; complete: boolean; oldest: string | null }> => {
    const seen = new Set<string>();
    let after: string | null = null;
    let complete = true;
    let oldest: string | null = null;
    while (seen.size < limit) {
      const first = Math.min(PAGE, limit - seen.size);
      const data: PullsResponse = await octokit.graphql<PullsResponse>(QUERY, {
        owner,
        name,
        states,
        first,
        after,
      });
      pages += 1;
      const conn = data.repository.pullRequests;
      const nodes = conn.nodes.filter((n): n is PullNode => n !== null);
      if (nodes.length > 0) {
        await upsertPulls(repoId, nodes);
        for (const n of nodes) seen.add(n.id);
        oldest = nodes[nodes.length - 1]!.updatedAt;
        hooks.onPage?.(repoId, nodes.length);
      }
      await progress({
        sync_phase: phase,
        sync_pages: pages,
        sync_rate_remaining: data.rateLimit.remaining,
        sync_message: `${message} · ${seen.size} stored`,
      });
      console.log(
        `[sync] ${repoId} ${phase}: ${nodes.length} pulls (total ${seen.size}/${limit}, graphql ${data.rateLimit.remaining} left)`,
      );
      if (!conn.pageInfo.hasNextPage) break;
      if (seen.size >= limit) {
        complete = false;
        break;
      }
      after = conn.pageInfo.endCursor;
      if (data.rateLimit.remaining < 50) {
        const wait = Math.max(0, Date.parse(data.rateLimit.resetAt) - Date.now()) + 1000;
        await progress({ sync_message: `rate limited · resuming in ${Math.round(wait / 1000)}s` });
        await new Promise((r) => setTimeout(r, wait));
      } else if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return { seen, complete, oldest };
  };

  const open = await walk(["OPEN"], openLimit, "pulls", "fetching open pull requests", 0);
  // Anything we thought was open and did not see again has closed or merged since.
  // When the walk was capped, only rows newer than the oldest seen can be judged.
  const seenIds = [...open.seen];
  if (open.complete) {
    await sql`update pull set state = 'closed' where repo_id = ${repoId} and state = 'open'
      and id <> all(${sql.array(seenIds)})`;
  } else if (open.oldest) {
    await sql`update pull set state = 'closed' where repo_id = ${repoId} and state = 'open'
      and updated_at >= ${open.oldest} and id <> all(${sql.array(seenIds)})`;
  }
  await refreshReviewers(repoId);

  let history = 0;
  if (historyLimit > 0) {
    const closed = await walk(
      ["MERGED", "CLOSED"],
      historyLimit,
      "pull-history",
      "fetching reviewed pull requests",
      HISTORY_PAGE_DELAY_MS,
    );
    history = closed.seen.size;
    const roster = await refreshReviewers(repoId);
    // Open pulls classified before the roster existed never got a reviewer question; re-ask.
    if (roster > 0) {
      const flagged =
        await sql`update pull set reclassify = true where repo_id = ${repoId} and state = 'open'
        and not reclassify and not exists (select 1 from classification c where c.pull_id = pull.id and c.kind = 'reviewer')`;
      if (flagged.count > 0) hooks.onPage?.(repoId, flagged.count);
    }
  }
  await sql`update repo set pull_synced_at = now() where id = ${repoId}`;
  return { open: open.seen.size, history, pages };
}

function stateOf(n: PullNode): string {
  return n.state === "OPEN" ? "open" : n.state === "MERGED" ? "merged" : "closed";
}

async function upsertPulls(repoId: string, nodes: PullNode[]) {
  const rows = nodes.map((n) => ({
    id: n.id,
    repo_id: repoId,
    number: n.number,
    title: n.title,
    body: n.body ?? "",
    state: stateOf(n),
    draft: n.isDraft,
    author: n.author?.login ?? "",
    author_association: n.authorAssociation ?? "",
    head_ref: n.headRefName,
    head_sha: n.headRefOid ?? null,
    base_ref: n.baseRefName,
    additions: n.additions,
    deletions: n.deletions,
    changed_files: n.changedFiles,
    files_json: sql.json(
      (n.files?.nodes ?? [])
        .filter((f): f is { path: string } => f !== null)
        .slice(0, FILES_KEPT)
        .map((f) => f.path),
    ),
    labels_json: sql.json(
      n.labels.nodes.filter((l): l is { name: string } => l !== null).map((l) => l.name),
    ),
    requested_reviewers_json: sql.json(
      n.reviewRequests.nodes
        .map((r) => r?.requestedReviewer)
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => (r.login ? r.login : r.slug ? `team:${r.slug}` : null))
        .filter((x): x is string => x !== null),
    ),
    review_decision: n.reviewDecision,
    mergeable: n.mergeable,
    comments: n.comments.totalCount,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    closed_at: n.closedAt,
    merged_at: n.mergedAt,
    merged_by: n.mergedBy?.login ?? null,
    url: n.url,
  }));
  const reviews = nodes.flatMap((n) =>
    n.reviews.nodes
      .filter(
        (r): r is NonNullable<typeof r> & { submittedAt: string; author: { login: string } } =>
          !!r && !!r.submittedAt && !!r.author,
      )
      .map((r) => ({
        id: r.id,
        pull_id: n.id,
        repo_id: repoId,
        reviewer: r.author.login,
        state: r.state,
        submitted_at: r.submittedAt,
      })),
  );

  await sql.begin(async (tx) => {
    await tx`insert into pull ${tx(
      rows,
      "id",
      "repo_id",
      "number",
      "title",
      "body",
      "state",
      "draft",
      "author",
      "author_association",
      "head_ref",
      "head_sha",
      "base_ref",
      "additions",
      "deletions",
      "changed_files",
      "files_json",
      "labels_json",
      "requested_reviewers_json",
      "review_decision",
      "mergeable",
      "comments",
      "created_at",
      "updated_at",
      "closed_at",
      "merged_at",
      "merged_by",
      "url",
    )}
      on conflict (id) do update set title = excluded.title, body = excluded.body, state = excluded.state,
        draft = excluded.draft, author = excluded.author, author_association = excluded.author_association,
        head_ref = excluded.head_ref, head_sha = excluded.head_sha, base_ref = excluded.base_ref, additions = excluded.additions,
        deletions = excluded.deletions, changed_files = excluded.changed_files, files_json = excluded.files_json,
        labels_json = excluded.labels_json, requested_reviewers_json = excluded.requested_reviewers_json,
        review_decision = excluded.review_decision, mergeable = excluded.mergeable, comments = excluded.comments,
        updated_at = excluded.updated_at, closed_at = excluded.closed_at, merged_at = excluded.merged_at,
        merged_by = excluded.merged_by, url = excluded.url`;
    if (reviews.length > 0) {
      await tx`insert into pull_review ${tx(reviews, "id", "pull_id", "repo_id", "reviewer", "state", "submitted_at")}
        on conflict (id) do update set state = excluded.state, submitted_at = excluded.submitted_at`;
    }
  });
}

/** Rebuilds the reviewer roster for a repo from every synced pull and review. */
export async function refreshReviewers(repoId: string): Promise<number> {
  const pulls = await sql<
    {
      id: string;
      title: string;
      author: string;
      state: string;
      created_at: Date;
      files_json: string[];
      requested_reviewers_json: string[];
    }[]
  >`select id, title, author, state, created_at, files_json, requested_reviewers_json from pull where repo_id = ${repoId}`;
  const reviews = await sql<
    { pull_id: string; reviewer: string; state: string; submitted_at: Date }[]
  >`select pull_id, reviewer, state, submitted_at from pull_review where repo_id = ${repoId}`;
  const stats = deriveReviewers(
    pulls.map((p): PullForStats => ({
      id: p.id,
      title: p.title,
      author: p.author,
      state: p.state,
      createdAt: p.created_at.getTime(),
      files: Array.isArray(p.files_json) ? p.files_json : [],
      requestedReviewers: Array.isArray(p.requested_reviewers_json)
        ? p.requested_reviewers_json
        : [],
    })),
    reviews.map((r): ReviewEvent => ({
      pullId: r.pull_id,
      reviewer: r.reviewer,
      state: r.state,
      submittedAt: r.submitted_at.getTime(),
    })),
  );
  const rows = stats.map((s) => ({
    repo_id: repoId,
    login: s.login,
    reviews: s.reviews,
    approvals: s.approvals,
    changes_requested: s.changesRequested,
    last_review_at: s.lastReviewAt === null ? null : new Date(s.lastReviewAt),
    median_response_hours: s.medianResponseHours,
    dirs_json: sql.json(s.dirs),
    recent_titles_json: sql.json(s.recentTitles),
    open_load: s.openLoad,
  }));
  await sql.begin(async (tx) => {
    if (rows.length > 0) {
      await tx`insert into reviewer ${tx(
        rows,
        "repo_id",
        "login",
        "reviews",
        "approvals",
        "changes_requested",
        "last_review_at",
        "median_response_hours",
        "dirs_json",
        "recent_titles_json",
        "open_load",
      )}
        on conflict (repo_id, login) do update set reviews = excluded.reviews, approvals = excluded.approvals,
          changes_requested = excluded.changes_requested, last_review_at = excluded.last_review_at,
          median_response_hours = excluded.median_response_hours, dirs_json = excluded.dirs_json,
          recent_titles_json = excluded.recent_titles_json, open_load = excluded.open_load`;
    }
    const keep = rows.map((r) => r.login);
    await tx`delete from reviewer where repo_id = ${repoId} and login <> all(${tx.array(keep)})`;
  });
  return rows.length;
}
