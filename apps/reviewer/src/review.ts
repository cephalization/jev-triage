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
import { OI, type Span, type TraceContext } from "@triage/triage/trace";
import { runAgent, type Callback, type ToolHost } from "./agent.ts";
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
  /** Where this stage's spans go and which span they hang from; null sends nothing. */
  trace: TraceContext | null;
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

async function staged<T>(
  name: string,
  body: StagedBody,
  host: ToolHost,
  build: (previousError: string | null) => string,
  schema: Parameters<typeof askJson<T>>[1],
  input: string,
): Promise<StagedResult<T>> {
  let usage: CallUsage = NO_USAGE;
  let toolCalls = 0;
  const parent: Span | TraceContext | null = body.trace;
  const span = host.tracer.start(name, "AGENT", parent, {
    [OI.inputValue]: input,
    [OI.modelName]: body.model,
  });
  try {
    const result = await askJson(build, schema, async (prompt) => {
      const r = await runAgent(body.provider, body.model, prompt, host, span);
      usage = addUsage(usage, r);
      toolCalls += r.toolCalls;
      return r.text;
    });
    host.tracer.end(span, {
      [OI.outputValue]: JSON.stringify(result),
      [OI.outputMime]: "application/json",
      [OI.promptTokens]: usage.inputTokens,
      [OI.completionTokens]: usage.outputTokens,
      [OI.costTotal]: usage.costUsd,
      "review.tool_calls": toolCalls,
    });
    return { result, ...usage, toolCalls };
  } catch (e) {
    host.tracer.end(span, {}, e);
    throw e;
  } finally {
    await host.tracer.flush();
  }
}

export function runSkeleton(
  body: SkeletonBody,
  host: ToolHost,
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
    (prev) => buildSkeletonPrompt(req, prev),
    skeletonSchema,
    `${req.intent.title} (${req.files.length} files)`,
  );
}

export function runNarrative(
  body: NarrativeBody,
  host: ToolHost,
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
    (prev) => buildNarrativePrompt(req, prev),
    narrativeSchema,
    `${req.step.name}: ${req.step.intent}`,
  );
}
