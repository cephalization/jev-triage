import type { ProviderKind } from "@triage/schema";
import { authHeaders } from "../providers/catalog.ts";

/**
 * One completion over a provider's HTTP API. This is the first runner: no CLI, no checkout,
 * the prompt already carries the diff. A subprocess runner (pi) can sit behind the same
 * `Ask` shape later.
 */

export interface RunnerProvider {
  kind: ProviderKind;
  baseUrl: string;
  key: string;
}

export interface Completion {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export type Ask = (prompt: string) => Promise<Completion>;

const MAX_OUTPUT_TOKENS = 8192;

export async function complete(
  provider: RunnerProvider,
  model: string,
  prompt: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Completion> {
  const f = opts.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10 * 60_000);
  const base = provider.baseUrl.replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "typeful-triage",
    ...authHeaders(provider.kind, provider.key),
  };
  if (provider.kind === "anthropic") {
    const res = await f(`${base}/messages`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic answered ${res.status}: ${await errorText(res)}`);
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return {
      text,
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
    };
  }
  const res = await f(`${base}/chat/completions`, {
    method: "POST",
    headers,
    signal,
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`${provider.kind} answered ${res.status}: ${await errorText(res)}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
  };
}

async function errorText(res: Response): Promise<string> {
  const t = await res.text().catch(() => "");
  return t.slice(0, 300);
}
