import {
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
import type { CallUsage, ProviderSpec } from "./pi.ts";
import { freshState, resumeStaged, type Outcome } from "./resume.ts";
import type { AgentStore } from "./state.ts";

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

/** A finished stage: the validated result and what the whole stage cost. */
export interface StagedResult<T> extends CallUsage {
  status: "done";
  result: T;
  toolCalls: number;
}

/** A stage the cell paused inside its time budget; the API asks again to continue it. */
export interface StagedRunning {
  status: "running";
  turns: number;
  toolCalls: number;
}

export type StagedAnswer<T> = StagedResult<T> | StagedRunning;

/**
 * How long one request works before handing back. Well inside celld's handler budget (300 s by
 * default) with room for the turn in flight, which can only be as long as one provider call.
 */
export const PART_MS = 60_000;

/** What a stage needs beyond its body: the inbound request for its parent, and the cell's lifecycle. */
export interface StageEnv {
  request: Request;
  tracing: WorkersTracing | null;
  execution: { waitUntil(promise: Promise<unknown>): void } | null;
  /** Where the conversation waits between parts. */
  store: AgentStore;
  /** When this request began, for the part's deadline. */
  startedAt: number;
}

async function staged<T>(
  name: string,
  key: string,
  body: StagedBody,
  host: ToolHost,
  env: StageEnv,
  build: (previousError: string | null) => string,
  schema: Parameters<typeof resumeStaged<T>>[2],
  input: string,
): Promise<StagedAnswer<T>> {
  const run = async (): Promise<StagedAnswer<T>> => {
    const yieldAfter = env.startedAt + PART_MS;
    let out: Outcome<T>;
    try {
      out = await resumeStaged(
        env.store.load(key) ?? freshState(),
        build,
        schema,
        (messages, turns) =>
          runAgent(body.provider, body.model, messages, host, { yieldAfter, turns }),
        () => Date.now() >= yieldAfter,
      );
    } catch (e) {
      env.store.clear(key);
      throw e;
    }
    if (out.status === "running") {
      env.store.save(key, out.state);
      return { status: "running", turns: out.state.turns, toolCalls: out.state.toolCalls };
    }
    env.store.clear(key);
    return {
      status: "done",
      result: out.result,
      ...out.state.usage,
      toolCalls: out.state.toolCalls,
    };
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
      span.setAttribute("review.status", out.status);
      if (out.status === "running")
        span.setAttributes({ "review.turns": out.turns, "review.tool_calls": out.toolCalls });
      else
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
): Promise<StagedAnswer<{ steps: StepSkeleton[] }>> {
  const req: SkeletonRequest = {
    ...body.request,
    files: splitPatch(body.request.patch),
    skimPaths: new Set(body.request.skimPaths),
    tools: true,
  };
  return staged(
    "skeleton",
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
): Promise<StagedAnswer<Narrative>> {
  const req: NarrativeRequest = {
    ...body.request,
    files: splitPatch(body.request.patch),
    tools: true,
  };
  return staged(
    `narrative: ${req.step.name}`,
    `narrative:${req.index}`,
    body,
    host,
    env,
    (prev) => buildNarrativePrompt(req, prev),
    narrativeSchema,
    `${req.step.name}: ${req.step.intent}`,
  );
}
