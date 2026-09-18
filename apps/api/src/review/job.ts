import type { SystemOne } from "@triage/triage";
import {
  generateReview,
  groupSeed,
  normalizeGroups,
  renderClassification,
  splitPatch,
  type ClassifiedFile,
  type ReviewGroup,
  type ReviewIntent,
} from "@triage/triage/review";
import { sql } from "../db.ts";
import { env } from "../env.ts";
import { makeOctokit } from "../github/sync.ts";
import { resolveProvider } from "../providers/store.ts";
import { cellReachable, runInCell } from "./cell.ts";
import { classifyFiles, storeFileRows } from "./files.ts";
import { complete, type Ask, type RunnerProvider } from "./runner.ts";

/**
 * One guided-review generation, from a queued row to ready or failed. Progress streams
 * through the row (status, started_at) so every viewer watches the same run. One run per
 * pull request at a time; a second request while one is in flight is refused by the route.
 *
 * Order of work: fetch the diff, ask jev about every file (the proposal), ask the agent for the
 * narrative with the proposal in hand, and if the agent fails serve the proposal as the review.
 */

const BODY_CHARS = 4000;

export interface PullSnapshot {
  headSha: string;
  intent: ReviewIntent;
  diff: string;
}

export interface Generated {
  groups: ReviewGroup[];
  files: string[];
  inputTokens: number;
  outputTokens: number;
}

/** The pure core: snapshot in, groups out, with the retry and the normalisation applied. */
export async function generate(
  snapshot: PullSnapshot,
  previousGroups: readonly ReviewGroup[] | null,
  ask: Ask,
  classification: string | null = null,
): Promise<Generated> {
  let inputTokens = 0;
  let outputTokens = 0;
  const result = await generateReview(
    { patch: snapshot.diff, intent: snapshot.intent, previousGroups, classification },
    async (prompt) => {
      const c = await ask(prompt);
      inputTokens += c.inputTokens;
      outputTokens += c.outputTokens;
      return c.text;
    },
  );
  const files = splitPatch(snapshot.diff).map((f) => f.path);
  return { groups: normalizeGroups(result.groups, files), files, inputTokens, outputTokens };
}

/** The review served when the agent fails: jev's order with generic step titles. */
export function seedReview(classified: readonly ClassifiedFile[], allFiles: string[]): Generated {
  return {
    groups: normalizeGroups(groupSeed(classified), allFiles),
    files: allFiles,
    inputTokens: 0,
    outputTokens: 0,
  };
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

interface ReviewRow {
  id: string;
  pull_id: string;
  repo_id: string;
  provider_id: string | null;
  model: string;
}

export interface JobDeps {
  /** The classifier for the file pass; null skips it (no TypeSafe key). */
  systemOne: SystemOne | null;
  fetchSnapshot?: typeof fetchPullSnapshot;
  provider?: (id: string) => Promise<RunnerProvider | null>;
  complete?: typeof complete;
}

/** Drive one queued review row to completion. Errors land on the row, never thrown. */
export async function runReviewJob(reviewId: string, deps: JobDeps): Promise<void> {
  const [row] = await sql<ReviewRow[]>`
    select id, pull_id, repo_id, provider_id, model from guided_review where id = ${reviewId}`;
  if (!row) return;
  if (inFlight.has(row.pull_id)) return;
  inFlight.add(row.pull_id);
  const t0 = Date.now();
  try {
    await sql`update guided_review set status = 'running', started_at = now() where id = ${row.id}`;
    const [pull] = await sql<
      { number: number }[]
    >`select number from pull where id = ${row.pull_id}`;
    if (!pull) throw new Error("pull request is not synced");
    if (!row.provider_id) throw new Error("no provider chosen");
    const provider = await (deps.provider ?? resolveProvider)(row.provider_id);
    if (!provider) throw new Error("the provider has no key; set one in System → Providers");
    const snapshot = await (deps.fetchSnapshot ?? fetchPullSnapshot)(row.repo_id, pull.number);
    const patchFiles = splitPatch(snapshot.diff);
    const allFiles = patchFiles.map((f) => f.path);

    // The jev pass. Its failure is not the review's failure: the agent still runs, unguided.
    let classified: ClassifiedFile[] = [];
    if (deps.systemOne) {
      try {
        classified = await classifyFiles(deps.systemOne, row.repo_id, snapshot.intent, patchFiles);
        await storeFileRows(row.id, classified);
      } catch (e) {
        console.warn(
          `[review] ${row.id}: file classification failed, continuing without it: ${e instanceof Error ? e.message : String(e)}`,
        );
        classified = [];
      }
    }
    const classification = classified.length > 0 ? renderClassification(classified) : null;

    const [prev] = await sql<{ groups_json: ReviewGroup[] }[]>`
      select groups_json from guided_review
      where pull_id = ${row.pull_id} and status = 'ready' and id <> ${row.id}
      order by created_at desc limit 1`;
    const previousGroups = prev?.groups_json ?? null;

    // A configured cell that is not answering (it crashed, or celld is not running) must not
    // cost the review: fall back to the in-process runner and say so.
    const cellUrl = env.reviewCellUrl;
    const useCell = cellUrl !== null && (await cellReachable({ url: cellUrl }));
    if (cellUrl && !useCell)
      console.warn(
        `[review] ${row.id}: reviewer cell at ${cellUrl} is not answering; running in-process`,
      );

    let out: Generated;
    let source = "agent";
    let agentError: string | null = null;
    try {
      out = useCell
        ? await runInCell({ url: cellUrl, token: env.reviewCellToken }, row.id, {
            provider,
            model: row.model,
            request: {
              patch: snapshot.diff,
              intent: snapshot.intent,
              previousGroups,
              classification,
            },
          })
        : await generate(
            snapshot,
            previousGroups,
            (prompt) => (deps.complete ?? complete)(provider, row.model, prompt),
            classification,
          );
    } catch (e) {
      if (classified.length === 0) throw e;
      agentError = e instanceof Error ? e.message : String(e);
      console.warn(`[review] ${row.id}: agent failed, serving the classified order: ${agentError}`);
      out = seedReview(classified, allFiles);
      source = "seed";
    }

    await sql.begin(async (tx) => {
      await tx`update guided_review set status = 'ready', head_sha = ${snapshot.headSha},
        groups_json = ${sql.json(out.groups)}, file_count = ${out.files.length},
        input_tokens = ${out.inputTokens}, output_tokens = ${out.outputTokens},
        source = ${source}, error = ${agentError === null ? null : agentError.slice(0, 500)},
        finished_at = now() where id = ${row.id}`;
      await tx`insert into private.review_patch (review_id, patch) values (${row.id}, ${snapshot.diff})
        on conflict (review_id) do update set patch = excluded.patch`;
    });
    console.log(
      `[review] ${row.repo_id}#${pull.number}: ${out.groups.length} steps over ${out.files.length} files, ${out.inputTokens} in / ${out.outputTokens} out, ${Date.now() - t0} ms, ${row.model}${useCell ? " (cell)" : ""}${source === "seed" ? " (seed)" : ""}`,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[review] ${row.id} failed: ${message}`);
    await sql`update guided_review set status = 'failed', error = ${message.slice(0, 500)}, finished_at = now() where id = ${row.id}`;
  } finally {
    inFlight.delete(row.pull_id);
  }
}

/** Rows left running by a previous process are failed on startup rather than spinning forever. */
export async function failOrphanedReviews(): Promise<void> {
  await sql`update guided_review set status = 'failed', error = 'the server restarted during generation', finished_at = now()
    where status in ('queued', 'running')`;
}
