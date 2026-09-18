import {
  askJson,
  buildNarrativePrompt,
  buildSkeletonPrompt,
  narrativeSchema,
  skeletonSchema,
  splitPatch,
  type Narrative,
  type NarrativeRequest,
  type SkeletonRequest,
  type StepSkeleton,
} from "@triage/triage/review";
import { withRequestSpan, type WorkersTracing } from "@triage/openinference-workers";
import {
  OpenInferenceSpanKind,
  SemanticConventions as S,
} from "@arizeai/openinference-semantic-conventions";
import { runAgent, type Callback, type ToolHost } from "./agent.ts";
import type { TraceTarget } from "./otel.ts";
import { addUsage, NO_USAGE, type CallUsage, type ProviderSpec } from "./pi.ts";

/** The staged calls: the API sends the patch subset and the prompt inputs; the cell adds tools. */
export interface StagedBody {
  provider: ProviderSpec;
  model: string;
  callback: Callback | null;
  /** `owner/repo`, for the repository's ledger of cells. */
  repo: string;
  /** The loaded snapshot the tools read. */
  snapshot: { owner: string; repo: string; sha: string };
  /** Where spans go; the parent comes from the request's `traceparent`. Null sends nothing. */
  trace: TraceTarget | null;
}

export interface SkeletonBody extends StagedBody {
  request: Omit<SkeletonRequest, "files" | "skimPaths" | "tools"> & {
    patch: string;
    skimPaths: string[];
  };
}

export interface NarrativeBody extends StagedBody {
  request: Omit<NarrativeRequest, "files" | "tools"> & { patch: string };
}

export interface StagedResult<T> extends CallUsage {
  result: T;
  toolCalls: number;
}

/** What a stage needs beyond its body: the inbound request for its parent, and the cell's lifecycle. */
export interface StageEnv {
  request: Request;
  tracing: WorkersTracing | null;
  execution: { waitUntil(promise: Promise<unknown>): void } | null;
}

async function staged<T>(
  name: string,
  body: StagedBody,
  host: ToolHost,
  env: StageEnv,
  build: (previousError: string | null) => string,
  schema: Parameters<typeof askJson<T>>[1],
  input: string,
): Promise<StagedResult<T>> {
  const run = async (): Promise<StagedResult<T>> => {
    let usage: CallUsage = NO_USAGE;
    let toolCalls = 0;
    const result = await askJson(build, schema, async (prompt) => {
      const r = await runAgent(body.provider, body.model, prompt, host);
      usage = addUsage(usage, r);
      toolCalls += r.toolCalls;
      return r.text;
    });
    return { result, ...usage, toolCalls };
  };
  if (!env.tracing) return run();
  return withRequestSpan(
    {
      tracer: env.tracing.tracer,
      request: env.request,
      name,
      kind: OpenInferenceSpanKind.AGENT,
      attributes: { [S.INPUT_VALUE]: input, [S.LLM_MODEL_NAME]: body.model },
      execution: env.execution,
      flush: env.tracing.flush,
    },
    async (span) => {
      const out = await run();
      span.setAttributes({
        [S.OUTPUT_VALUE]: JSON.stringify(out.result),
        [S.OUTPUT_MIME_TYPE]: "application/json",
        [S.LLM_TOKEN_COUNT_PROMPT]: out.inputTokens,
        [S.LLM_TOKEN_COUNT_COMPLETION]: out.outputTokens,
        [S.LLM_COST_TOTAL]: out.costUsd,
        "review.tool_calls": out.toolCalls,
      });
      return out;
    },
  );
}

export function runSkeleton(
  body: SkeletonBody,
  host: ToolHost,
  env: StageEnv,
): Promise<StagedResult<{ steps: StepSkeleton[] }>> {
  const req: SkeletonRequest = {
    ...body.request,
    files: splitPatch(body.request.patch),
    skimPaths: new Set(body.request.skimPaths),
    tools: true,
  };
  return staged(
    "skeleton",
    body,
    host,
    env,
    (prev) => buildSkeletonPrompt(req, prev),
    skeletonSchema,
    `${req.intent.title} (${req.files.length} files)`,
  );
}

export function runNarrative(
  body: NarrativeBody,
  host: ToolHost,
  env: StageEnv,
): Promise<StagedResult<Narrative>> {
  const req: NarrativeRequest = {
    ...body.request,
    files: splitPatch(body.request.patch),
    tools: true,
  };
  return staged(
    `narrative: ${req.step.name}`,
    body,
    host,
    env,
    (prev) => buildNarrativePrompt(req, prev),
    narrativeSchema,
    `${req.step.name}: ${req.step.intent}`,
  );
}
