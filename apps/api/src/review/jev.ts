import type { SystemOne } from "@triage/triage";
import type { EntryType, Questions, SystemOneResult, Usage } from "@typesafe-ai/sdk";
import { newId, sql } from "../db.ts";
import { env } from "../env.ts";

/**
 * One System One request on behalf of a review, accounted like every other: a `run` row per
 * request with its kind, the repo's token counters bumped, usage on the console with its price.
 */
export async function askSystemOne<const Q extends Questions>(
  systemOne: SystemOne,
  req: { repoId: string; kind: string; state: EntryType; questions: Q; items: number },
): Promise<SystemOneResult<Q>> {
  const runId = newId();
  const questionCount = Object.keys(req.questions).length;
  await sql`insert into run (id, repo_id, kind, status, issues, questions)
    values (${runId}, ${req.repoId}, ${req.kind}, 'running', ${req.items}, ${questionCount})`;
  const t0 = Date.now();
  try {
    const result = await systemOne.ask(req.state, req.questions);
    const ms = Date.now() - t0;
    logUsage(req.repoId, req.kind, req.items, questionCount, result.usage, ms, result.model);
    await sql.begin(async (tx) => {
      await tx`update repo set tokens_used = tokens_used + ${result.usage.input_tokens + result.usage.output_tokens},
        input_tokens_used = input_tokens_used + ${result.usage.input_tokens},
        output_tokens_used = output_tokens_used + ${result.usage.output_tokens} where id = ${req.repoId}`;
      await tx`update run set finished_at = now(), status = 'ok', input_tokens = ${result.usage.input_tokens},
        output_tokens = ${result.usage.output_tokens}, latency_ms = ${ms}, model = ${result.model} where id = ${runId}`;
    });
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sql`update run set finished_at = now(), status = 'error', error = ${message}, latency_ms = ${Date.now() - t0} where id = ${runId}`;
    throw e;
  }
}

function logUsage(
  repoId: string,
  kind: string,
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
    `[review] ${repoId} ${kind}: ${n} items, ${questions} questions, ${usage.input_tokens} in / ${usage.output_tokens} out tokens, ${ms} ms, model ${model}${cost === null ? "" : `, $${cost.toFixed(4)}`}`,
  );
}
