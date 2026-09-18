import {
  createModels,
  type Api,
  type Context,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

/**
 * One completion through the pi SDK. The SDK owns the wire protocols (Anthropic messages,
 * OpenAI responses, OpenAI-style completions) and streams every request; we hand it the
 * provider kind, a base URL, an explicit key, and read back text and usage.
 */

export type ProviderKind = "anthropic" | "openai" | "openrouter" | "openai-compatible";

export interface ProviderSpec {
  kind: ProviderKind;
  /** As stored by the app: Anthropic and OpenAI defaults end in /v1. */
  baseUrl: string;
  apiKey: string;
}

export interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
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
 * Resolve a model object for the SDK. Catalogued ids come with their cost and limits; an id
 * the catalog does not know (a new release, or any OpenAI-compatible server) is built from a
 * template of the same wire API so the SDK still routes it correctly.
 */
export function modelFor(spec: ProviderSpec, id: string): Model<Api> {
  const m = models();
  const base = baseFor(spec.kind, spec.baseUrl);
  if (spec.kind !== "openai-compatible") {
    const known = m.getModel(spec.kind, id);
    if (known) return { ...known, baseUrl: base };
  }
  const template =
    spec.kind === "anthropic"
      ? m.getModels("anthropic")[0]
      : spec.kind === "openai"
        ? m.getModels("openai")[0]
        : m.getModels("openrouter").find((x) => x.api === "openai-completions");
  if (!template) throw new Error(`no model template for ${spec.kind}`);
  const { compat: _compat, ...rest } = template;
  return { ...rest, id, name: id, baseUrl: base, reasoning: false, input: ["text"] };
}

export async function completeWithPi(
  spec: ProviderSpec,
  modelId: string,
  prompt: string,
): Promise<Completion> {
  const m = models();
  const model = modelFor(spec, modelId);
  const context: Context = {
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  };
  const r = await m.completeSimple(model, context, { apiKey: spec.apiKey });
  if (r.stopReason === "error" || r.stopReason === "aborted") {
    const why = (r as { errorMessage?: string }).errorMessage ?? r.stopReason;
    throw new Error(`${spec.kind} ${modelId}: ${why}`);
  }
  const text = r.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  return { text, inputTokens: r.usage.input, outputTokens: r.usage.output };
}
