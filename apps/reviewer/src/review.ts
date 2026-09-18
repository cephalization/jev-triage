import {
  generateReview,
  normalizeGroups,
  splitPatch,
  type ReviewGroup,
  type ReviewRequest,
} from "@triage/triage/review";
import { completeWithPi, type Completion, type ProviderSpec } from "./pi.ts";

/** What the API sends a cell: who to call, with what, about which change. */
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
