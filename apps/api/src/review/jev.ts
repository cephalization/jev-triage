import type { SystemOne } from "@triage/triage";
import type { EntryType, Questions, SystemOneResult, Usage } from "@typesafe-ai/sdk";
import {
  OpenInferenceSpanKind,
  SemanticConventions as S,
} from "@arizeai/openinference-semantic-conventions";
import { SpanStatusCode } from "@opentelemetry/api";
import { newId, sql } from "../db.ts";
import { env } from "../env.ts";
import { tracer } from "./otel.ts";

/**
 * One System One request on behalf of a review, accounted like every other: a `run` row per
 * request with its kind, the repo's token counters bumped, usage on the console with its
 * price, and an LLM span under whatever span is active when it is called.
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
  return tracer.startActiveSpan(
    `jev.${req.kind}`,
    {
      attributes: {
        [S.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
        [S.LLM_SYSTEM]: "typesafe",
        [S.LLM_PROVIDER]: "typesafe",
        [S.INPUT_VALUE]: JSON.stringify({ state: req.state, questions: req.questions }),
        [S.INPUT_MIME_TYPE]: "application/json",
        "jev.items": req.items,
        "jev.questions": questionCount,
      },
    },
    async (span) => {
      try {
        const result = await systemOne.ask(req.state, req.questions);
        const ms = Date.now() - t0;
        logUsage(req.repoId, req.kind, req.items, questionCount, result.usage, ms, result.model);
        span.setAttributes({
          [S.LLM_MODEL_NAME]: result.model,
          [S.OUTPUT_VALUE]: JSON.stringify(result.answers),
          [S.OUTPUT_MIME_TYPE]: "application/json",
          [S.LLM_TOKEN_COUNT_PROMPT]: result.usage.input_tokens,
          [S.LLM_TOKEN_COUNT_COMPLETION]: result.usage.output_tokens,
          [S.LLM_TOKEN_COUNT_TOTAL]: result.usage.input_tokens + result.usage.output_tokens,
          ...priceAttributes(result.usage),
        });
        span.setStatus({ code: SpanStatusCode.OK });
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
        span.recordException(e instanceof Error ? e : new Error(message));
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        await sql`update run set finished_at = now(), status = 'error', error = ${message}, latency_ms = ${Date.now() - t0} where id = ${runId}`;
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

function priceAttributes(usage: Usage): Record<string, number> {
  if (env.priceInputPerMTok === null || env.priceOutputPerMTok === null) return {};
  const prompt = (usage.input_tokens * env.priceInputPerMTok) / 1_000_000;
  const completion = (usage.output_tokens * env.priceOutputPerMTok) / 1_000_000;
  return {
    [S.LLM_COST_PROMPT]: prompt,
    [S.LLM_COST_COMPLETION]: completion,
    [S.LLM_COST_TOTAL]: prompt + completion,
  };
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
