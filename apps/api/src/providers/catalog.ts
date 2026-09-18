import { PROVIDER_KINDS, type ProviderKind } from "@triage/schema";

/**
 * What each provider kind needs: a default base URL, how to authenticate, and how to read its
 * model list. Pure apart from `listModels`, which does the one HTTP call.
 */

export interface KindInfo {
  label: string;
  /** Default API base; `openai-compatible` has none and needs one from the admin. */
  baseUrl: string | null;
  /** Env var the agent CLI expects the key in (phase 3 injects it into the runner). */
  keyEnv: string;
}

export const KINDS: Record<ProviderKind, KindInfo> = {
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: "ANTHROPIC_API_KEY",
  },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY" },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: "OPENROUTER_API_KEY",
  },
  "openai-compatible": { label: "OpenAI-compatible", baseUrl: null, keyEnv: "OPENAI_API_KEY" },
};

export function isKind(v: string): v is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(v);
}

/** Request headers for the kind; Anthropic uses its own header, everyone else a bearer token. */
export function authHeaders(kind: ProviderKind, key: string): Record<string, string> {
  if (kind === "anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  return { authorization: `Bearer ${key}` };
}

export interface ModelInfo {
  id: string;
  label: string;
}

/**
 * Every kind here answers `GET {base}/models` with `{ data: [{ id, … }] }`; Anthropic adds
 * `display_name`, OpenRouter `name`. Unknown shapes yield an empty list rather than a throw,
 * so an odd proxy does not block saving a provider.
 */
export function parseModels(body: unknown): ModelInfo[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: ModelInfo[] = [];
  for (const m of data as { id?: unknown; display_name?: unknown; name?: unknown }[]) {
    if (typeof m?.id !== "string") continue;
    const label =
      typeof m.display_name === "string"
        ? m.display_name
        : typeof m.name === "string"
          ? m.name
          : m.id;
    out.push({ id: m.id, label });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function listModels(
  kind: ProviderKind,
  baseUrl: string,
  key: string,
): Promise<ModelInfo[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: {
      accept: "application/json",
      "user-agent": "typeful-triage",
      ...authHeaders(kind, key),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${KINDS[kind].label} answered ${res.status} for the model list`);
  return parseModels(await res.json());
}

/** The first character of a key that cannot travel in an HTTP header, or null when it is clean. */
export function badHeaderChar(key: string): string | null {
  return /[^\x21-\x7e]/.exec(key)?.[0] ?? null;
}
