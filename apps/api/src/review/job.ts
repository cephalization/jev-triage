import type { SystemOne } from "@triage/triage";
import { splitPatch, type ReviewGroup, type ReviewIntent } from "@triage/triage/review";
import { OI, Tracer } from "@triage/triage/trace";
import { newId, sql } from "../db.ts";
import { env } from "../env.ts";
import { makeOctokit } from "../github/sync.ts";
import { resolveProvider } from "../providers/store.ts";
import { cellReachable, loadSnapshotInCell, type Cell } from "./cell.ts";
import { classifyFiles, storeFileRows } from "./files.ts";
import { cellAgent, generateStaged, type Phase } from "./stages.ts";
import type { CallUsage } from "./usage.ts";

/**
 * One guided-review generation, from a queued row to ready or failed. Progress streams
 * through the row (status, phase, and the skeleton before its narratives) so every viewer
 * watches the same run. One run per pull request at a time.
 *
 * A review needs jev and the reviewer cell. If either is missing or any stage fails, the row
 * is failed with the reason; nothing degraded is ever served as a review.
 */

const BODY_CHARS = 4000;

export interface PullSnapshot {
  headSha: string;
  intent: ReviewIntent;
  diff: string;
}

/** The pull request as GitHub has it right now: metadata for intent, and its unified diff. */
export async function fetchPullSnapshot(
  repoId: string,
  number: number,
  octokit = makeOctokit(),
): Promise<PullSnapshot> {
  const [owner, repo] = repoId.split("/") as [string, string];
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
  const diffRes = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: number,
    mediaType: { format: "diff" },
  });
  // With the diff media type the body is the raw patch text, whatever the typed response says.
  const diff = diffRes.data as unknown as string;
  if (!diff.trim()) throw new Error("GitHub returned an empty diff");
  return {
    headSha: pr.head.sha,
    intent: {
      title: pr.title,
      body: (pr.body ?? "").slice(0, BODY_CHARS),
      author: pr.user?.login ?? "",
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
    },
    diff,
  };
}

const inFlight = new Set<string>();

export function isGenerating(pullId: string): boolean {
  return inFlight.has(pullId);
}

/** Why generation cannot start, or null when it can. Checked by the route before queueing. */
export async function generationBlocker(systemOne: SystemOne | null): Promise<string | null> {
  if (!systemOne) return "TYPESAFE_API_KEY is not set; guided reviews need the classifier";
  if (!env.reviewCellUrl)
    return "no reviewer cell: install celld and start with `vp run dev`, or set REVIEW_CELL_URL";
  if (!(await cellReachable({ url: env.reviewCellUrl })))
    return `the reviewer cell at ${env.reviewCellUrl} is not answering`;
  return null;
}

interface ReviewRow {
  id: string;
  pull_id: string;
  repo_id: string;
  provider_id: string | null;
  model: string;
  created_by: string | null;
}

interface CostInsert extends CallUsage {
  stage: "skeleton" | "narrative";
}

/** One row per provider call: who is charged (the key's owner now) and who asked. */
async function storeCosts(
  row: ReviewRow,
  provider: { kind: string; keySetBy: string | null },
  calls: readonly CostInsert[],
): Promise<{ costUsd: number; priced: boolean }> {
  let costUsd = 0;
  let priced = true;
  const rows = calls.map((c) => {
    costUsd += c.costUsd;
    priced &&= c.priced;
    return {
      id: newId(),
      repo_id: row.repo_id,
      review_id: row.id,
      provider_id: row.provider_id,
      provider_kind: provider.kind,
      model: row.model,
      key_owner: provider.keySetBy,
      requested_by: row.created_by,
      stage: c.stage,
      input_tokens: c.inputTokens,
      output_tokens: c.outputTokens,
      cache_read_tokens: c.cacheReadTokens,
      cache_write_tokens: c.cacheWriteTokens,
      cost_usd: c.costUsd,
      priced: c.priced,
    };
  });
  if (rows.length > 0) await sql`insert into llm_cost ${sql(rows)}`;
  return { costUsd, priced };
}

export interface JobDeps {
  systemOne: SystemOne | null;
  fetchSnapshot?: typeof fetchPullSnapshot;
  provider?: typeof resolveProvider;
}

/** Drive one queued review row to completion. Errors land on the row, never thrown. */
export async function runReviewJob(reviewId: string, deps: JobDeps): Promise<void> {
  const [row] = await sql<ReviewRow[]>`
    select id, pull_id, repo_id, provider_id, model, created_by from guided_review where id = ${reviewId}`;
  if (!row) return;
  if (inFlight.has(row.pull_id)) return;
  inFlight.add(row.pull_id);
  const t0 = Date.now();
  const tracer = new Tracer(env.phoenixEndpoint, env.phoenixProject, "typeful-api");
  const root = tracer.start("guided_review", "AGENT", null, {
    [OI.sessionId]: row.id,
    [OI.userId]: row.created_by ?? "",
    [OI.inputValue]: `${row.repo_id} review ${row.id}`,
    [OI.metadata]: JSON.stringify({ repo: row.repo_id, pull: row.pull_id, model: row.model }),
  });
  const setPhase = async (phase: Phase | null, groups: ReviewGroup[] | null) => {
    if (groups)
      await sql`update guided_review set phase = ${phase}, groups_json = ${sql.json(groups)} where id = ${row.id}`;
    else await sql`update guided_review set phase = ${phase} where id = ${row.id}`;
  };
  try {
    await sql`update guided_review set status = 'running', started_at = now(), phase = null where id = ${row.id}`;
    const blocker = await generationBlocker(deps.systemOne);
    if (blocker) throw new Error(blocker);
    const systemOne = deps.systemOne!;
    const cell: Cell = { url: env.reviewCellUrl!, token: env.reviewCellToken };

    const [pull] = await sql<
      { number: number }[]
    >`select number from pull where id = ${row.pull_id}`;
    if (!pull) throw new Error("pull request is not synced");
    if (!row.provider_id) throw new Error("no provider chosen");
    const provider = await (deps.provider ?? resolveProvider)(row.provider_id);
    if (!provider) throw new Error("the provider has no key; set one in System → Providers");
    const snapshot = await (deps.fetchSnapshot ?? fetchPullSnapshot)(row.repo_id, pull.number);
    const allFiles = splitPatch(snapshot.diff).map((f) => f.path);
    // The patch is stored now so the review screen can show diffs under the skeleton.
    await sql`insert into private.review_patch (review_id, patch) values (${row.id}, ${snapshot.diff})
      on conflict (review_id) do update set patch = excluded.patch`;

    // Only a review the model wrote is worth keeping steps from.
    const [prev] = await sql<{ id: string; groups_json: ReviewGroup[] }[]>`
      select id, groups_json from guided_review
      where pull_id = ${row.pull_id} and status = 'ready' and source = 'agent' and id <> ${row.id}
      order by created_at desc limit 1`;
    const [prevPatch] = prev
      ? await sql<
          { patch: string }[]
        >`select patch from private.review_patch where review_id = ${prev.id}`
      : [];

    const staged = await generateStaged({
      reviewId: row.id,
      repoId: row.repo_id,
      intent: snapshot.intent,
      headSha: snapshot.headSha,
      patch: snapshot.diff,
      previous: prev && prevPatch ? { groups: prev.groups_json, patch: prevPatch.patch } : null,
      systemOne,
      loadSnapshot: () =>
        loadSnapshotInCell(cell, row.repo_id, snapshot.headSha, {
          token: env.githubToken,
          apiBase: env.githubSyncApiUrl,
        }),
      agent: (snap) =>
        cellAgent(
          cell,
          row.id,
          row.repo_id,
          provider,
          row.model,
          `http://127.0.0.1:${env.port}`,
          snap,
          tracer,
        ),
      classify: async (intent, files, trace) => {
        const c = await classifyFiles(systemOne, row.repo_id, intent, files, trace);
        await storeFileRows(row.id, c);
        return c;
      },
      onPhase: setPhase,
      tracer,
      root,
    });
    const spend = await storeCosts(row, provider, staged.calls);

    await sql`update guided_review set status = 'ready', phase = null, head_sha = ${snapshot.headSha},
      groups_json = ${sql.json(staged.groups)}, file_count = ${allFiles.length},
      input_tokens = ${staged.inputTokens}, output_tokens = ${staged.outputTokens},
      tool_calls = ${staged.toolCalls}, reused_steps = ${staged.reusedSteps},
      cost_usd = ${spend.costUsd}, priced = ${spend.priced},
      source = 'agent', error = null, finished_at = now() where id = ${row.id}`;
    tracer.end(root, {
      [OI.outputValue]: staged.groups.map((g) => g.name).join(" → "),
      [OI.promptTokens]: staged.inputTokens,
      [OI.completionTokens]: staged.outputTokens,
      [OI.costTotal]: spend.costUsd,
      "review.tool_calls": staged.toolCalls,
      "review.reused_steps": staged.reusedSteps,
    });
    console.log(
      `[review] ${row.repo_id}#${pull.number}: ${staged.groups.length} steps over ${allFiles.length} files (${staged.reusedSteps} kept), ${staged.inputTokens} in / ${staged.outputTokens} out, ${staged.toolCalls} tool calls, ${spend.priced ? `$${spend.costUsd.toFixed(4)}` : "unpriced"}, ${Date.now() - t0} ms, ${row.model}`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[review] ${row.id} failed: ${message}`);
    if (root.end === null) tracer.end(root, {}, e);
    await sql`update guided_review set status = 'failed', phase = null, error = ${message.slice(0, 500)}, finished_at = now() where id = ${row.id}`;
  } finally {
    inFlight.delete(row.pull_id);
    await tracer.flush();
  }
}

/** Rows left running by a previous process are failed on startup rather than spinning forever. */
export async function failOrphanedReviews(): Promise<void> {
  await sql`update guided_review set status = 'failed', phase = null, error = 'the server restarted during generation', finished_at = now()
    where status in ('queued', 'running')`;
}
