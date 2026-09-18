import {
  askJson,
  buildNarrativePrompt,
  buildSkeletonPrompt,
  generateReview,
  narrativeSchema,
  normalizeGroups,
  skeletonSchema,
  splitPatch,
  type NarrativeRequest,
  type ReviewGroup,
  type ReviewRequest,
  type SkeletonRequest,
  type StepSkeleton,
} from "@triage/triage/review";
import { runAgent, type Callback, type ToolHost } from "./agent.ts";
import { completeWithPi, type Completion, type ProviderSpec } from "./pi.ts";

/** What the API sends a cell for the single-shot review: who to call, with what, about which change. */
export interface RunBody {
  provider: ProviderSpec;
  model: string;
  request: ReviewRequest;
}

export interface RunResult {
  groups: ReviewGroup[];
  files: string[];
  inputTokens: number;
  outputTokens: number;
}

/** Prompt, retry, validate and normalise: the same pipeline the API runs in-process. */
export async function runReview(
  body: RunBody,
  ask: (prompt: string) => Promise<Completion> = (p) =>
    completeWithPi(body.provider, body.model, p),
): Promise<RunResult> {
  let inputTokens = 0;
  let outputTokens = 0;
  const result = await generateReview(body.request, async (prompt) => {
    const c = await ask(prompt);
    inputTokens += c.inputTokens;
    outputTokens += c.outputTokens;
    return c.text;
  });
  const files = splitPatch(body.request.patch).map((f) => f.path);
  return { groups: normalizeGroups(result.groups, files), files, inputTokens, outputTokens };
}

/** The staged calls: the API sends the patch subset and the prompt inputs; the cell adds tools. */
export interface StagedBody {
  provider: ProviderSpec;
  model: string;
  callback: Callback | null;
  /** `owner/repo`, for the repository's ledger of cells. */
  repo: string;
  /** The loaded snapshot the tools read; null runs without tools. */
  snapshot: { owner: string; repo: string; sha: string } | null;
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

export interface StagedResult<T> {
  result: T;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

async function staged<T>(
  body: StagedBody,
  host: ToolHost,
  build: (previousError: string | null) => string,
  schema: Parameters<typeof askJson<T>>[1],
): Promise<StagedResult<T>> {
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  const result = await askJson(build, schema, async (prompt) => {
    const r = await runAgent(body.provider, body.model, prompt, host);
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    toolCalls += r.toolCalls;
    return r.text;
  });
  return { result, inputTokens, outputTokens, toolCalls };
}

export function runSkeleton(
  body: SkeletonBody,
  host: ToolHost,
): Promise<StagedResult<{ steps: StepSkeleton[] }>> {
  const req: SkeletonRequest = {
    ...body.request,
    files: splitPatch(body.request.patch),
    skimPaths: new Set(body.request.skimPaths),
    tools: host.snapshot !== null,
  };
  return staged(body, host, (prev) => buildSkeletonPrompt(req, prev), skeletonSchema);
}

export function runNarrative(
  body: NarrativeBody,
  host: ToolHost,
): Promise<StagedResult<{ summary: string }>> {
  const req: NarrativeRequest = {
    ...body.request,
    files: splitPatch(body.request.patch),
    tools: host.snapshot !== null,
  };
  return staged(body, host, (prev) => buildNarrativePrompt(req, prev), narrativeSchema);
}
