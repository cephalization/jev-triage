import {
  createModels,
  type Api,
  type Context,
  type Model,
  type MutableModels,
  type Usage,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

/**
 * One completion through the pi SDK. The SDK owns the wire protocols (Anthropic messages,
 * OpenAI responses, OpenAI-style completions) and streams every request; we hand it the
 * provider kind, a base URL, an explicit key, and read back text, tokens and the cost the
 * SDK computes from its model catalog.
 */

export type ProviderKind = "anthropic" | "openai" | "openrouter" | "openai-compatible";

export interface ProviderSpec {
  kind: ProviderKind;
  /** As stored by the app: Anthropic and OpenAI defaults end in /v1. */
  baseUrl: string;
  apiKey: string;
}

/** Tokens and money for one call, as pi reports them. `priced` is false for models the catalog does not know. */
export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  priced: boolean;
}

export interface Completion extends CallUsage {
  text: string;
}

export const NO_USAGE: CallUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  priced: true,
};

export function addUsage(a: CallUsage, b: CallUsage): CallUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd,
    priced: a.priced && b.priced,
  };
}

export function usageOf(u: Usage, priced: boolean): CallUsage {
  return {
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
    costUsd: priced ? u.cost.total : 0,
    priced,
  };
}

let shared: MutableModels | null = null;
export function models(): MutableModels {
  if (!shared) {
    shared = createModels();
    shared.setProvider(anthropicProvider());
    shared.setProvider(openaiProvider());
    shared.setProvider(openrouterProvider());
  }
  return shared;
}

/** The pi SDK appends /v1/messages for Anthropic; the others expect the /v1 in the base. */
export function baseFor(kind: ProviderKind, baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return kind === "anthropic" ? trimmed.replace(/\/v1$/, "") : trimmed;
}

/**
 * Resolve a model object for the SDK. Catalogued ids come with their prices and limits, so
 * pi can put a dollar figure on every call. An id the catalog does not know (a new release,
 * or any OpenAI-compatible server) is built from a template of the same wire API with its
 * prices zeroed, so the SDK routes it correctly and the call is reported as unpriced.
 */
export function modelFor(spec: ProviderSpec, id: string): { model: Model<Api>; priced: boolean } {
  const m = models();
  const base = baseFor(spec.kind, spec.baseUrl);
  if (spec.kind !== "openai-compatible") {
    const known = m.getModel(spec.kind, id);
    if (known) return { model: { ...known, baseUrl: base }, priced: true };
  }
  const template =
    spec.kind === "anthropic"
      ? m.getModels("anthropic")[0]
      : spec.kind === "openai"
        ? m.getModels("openai")[0]
        : m.getModels("openrouter").find((x) => x.api === "openai-completions");
  if (!template) throw new Error(`no model template for ${spec.kind}`);
  const { compat: _compat, ...rest } = template;
  return {
    model: {
      ...rest,
      id,
      name: id,
      baseUrl: base,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    priced: false,
  };
}

export async function completeWithPi(
  spec: ProviderSpec,
  modelId: string,
  prompt: string,
): Promise<Completion> {
  const m = models();
  const { model, priced } = modelFor(spec, modelId);
  const context: Context = {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  };
  // Everything the model can write: a provider default can cut a long JSON answer mid-string.
  const r = await m.completeSimple(model, context, {
    apiKey: spec.apiKey,
    maxTokens: model.maxTokens,
  });
  if (r.stopReason === "error" || r.stopReason === "aborted") {
    const why = (r as { errorMessage?: string }).errorMessage ?? r.stopReason;
    throw new Error(`${spec.kind} ${modelId}: ${why}`);
  }
  const text = r.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  return { text, ...usageOf(r.usage, priced) };
}
