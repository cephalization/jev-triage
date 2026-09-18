import type { SystemOne } from "@triage/triage";
import {
  buildFileQuestions,
  buildFileState,
  decideFile,
  FILES_PER_REQUEST,
  foldFileAnswers,
  REVIEW_FILE_QUESTIONS_VERSION,
  type ClassifiedFile,
  type PatchFile,
  type ReviewIntent,
} from "@triage/triage/review";
import type { Usage } from "@typesafe-ai/sdk";
import { newId, sql } from "../db.ts";
import { env } from "../env.ts";

/**
 * The jev pass over a review's diff: every changed file gets its role, risk, attention and
 * entry-point answers in batches of FILES_PER_REQUEST, one `run` row per request so cost shows
 * up with everything else. Batches run one after another; a review is one job, and the
 * classifier worker's one-in-flight rule is about repository triage, not this.
 */
export async function classifyFiles(
  systemOne: SystemOne,
  repoId: string,
  intent: ReviewIntent,
  files: readonly PatchFile[],
): Promise<ClassifiedFile[]> {
  const out: ClassifiedFile[] = [];
  for (let start = 0; start < files.length; start += FILES_PER_REQUEST) {
    const batch = files.slice(start, start + FILES_PER_REQUEST);
    const state = buildFileState(intent, batch);
    const questions = buildFileQuestions(batch.length);
    const runId = newId();
    await sql`insert into run (id, repo_id, kind, status, issues, questions)
      values (${runId}, ${repoId}, 'review_files', 'running', ${batch.length}, ${Object.keys(questions).length})`;
    const t0 = Date.now();
    try {
      const result = await systemOne.ask(state, questions);
      const ms = Date.now() - t0;
      logUsage(repoId, batch.length, Object.keys(questions).length, result.usage, ms, result.model);
      const folded = foldFileAnswers(
        result.answers as Parameters<typeof foldFileAnswers>[0],
        batch.length,
      );
      batch.forEach((f, i) =>
        out.push({
          path: f.path,
          status: f.status,
          added: f.added,
          removed: f.removed,
          signal: decideFile(folded[i] ?? {}),
        }),
      );
      await finishRun(repoId, runId, result.usage, ms, result.model);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await sql`update run set finished_at = now(), status = 'error', error = ${message}, latency_ms = ${Date.now() - t0} where id = ${runId}`;
      throw e;
    }
  }
  return out;
}

async function finishRun(repoId: string, runId: string, usage: Usage, ms: number, model: string) {
  await sql.begin(async (tx) => {
    await tx`update repo set tokens_used = tokens_used + ${usage.input_tokens + usage.output_tokens},
      input_tokens_used = input_tokens_used + ${usage.input_tokens},
      output_tokens_used = output_tokens_used + ${usage.output_tokens} where id = ${repoId}`;
    await tx`update run set finished_at = now(), status = 'ok', input_tokens = ${usage.input_tokens},
      output_tokens = ${usage.output_tokens}, latency_ms = ${ms}, model = ${model} where id = ${runId}`;
  });
}

function logUsage(
  repoId: string,
  n: number,
  questions: number,
  usage: Usage,
  ms: number,
  model: string,
) {
  const cost =
    env.priceInputPerMTok === null || env.priceOutputPerMTok === null
      ? null
      : (usage.input_tokens * env.priceInputPerMTok +
          usage.output_tokens * env.priceOutputPerMTok) /
        1_000_000;
  console.log(
    `[review] ${repoId} files v${REVIEW_FILE_QUESTIONS_VERSION}: ${n} files, ${questions} questions, ${usage.input_tokens} in / ${usage.output_tokens} out tokens, ${ms} ms, model ${model}${cost === null ? "" : `, $${cost.toFixed(4)}`}`,
  );
}

/** Persist the answers against the review, replacing any earlier rows for the same paths. */
export async function storeFileRows(reviewId: string, files: readonly ClassifiedFile[]) {
  if (files.length === 0) return;
  const rows = files.map((f) => ({
    review_id: reviewId,
    path: f.path,
    status: f.status,
    added: f.added,
    removed: f.removed,
    role: f.signal.role,
    role_confidence: f.signal.roleConfidence,
    risk: f.signal.risk,
    attention: f.signal.attention,
    entry: f.signal.entry,
    probabilities_json: sql.json(f.signal.probabilities),
    questions_version: REVIEW_FILE_QUESTIONS_VERSION,
  }));
  await sql`insert into guided_review_file ${sql(rows)}
    on conflict (review_id, path) do update set
      status = excluded.status, added = excluded.added, removed = excluded.removed,
      role = excluded.role, role_confidence = excluded.role_confidence, risk = excluded.risk,
      attention = excluded.attention, entry = excluded.entry,
      probabilities_json = excluded.probabilities_json, questions_version = excluded.questions_version`;
}
