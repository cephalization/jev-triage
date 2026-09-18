import type { ReviewGroup, ReviewRequest } from "@triage/triage/review";
import type { RunnerProvider } from "./runner.ts";

/**
 * The reviewer cell (apps/reviewer, a celld Durable Object running the pi SDK). When
 * REVIEW_CELL_URL is set the API hands the whole generation to it; the provider key travels
 * in the request body, so put the cell behind loopback or a REVIEWER_TOKEN.
 */

export interface CellResult {
  groups: ReviewGroup[];
  files: string[];
  inputTokens: number;
  outputTokens: number;
}

const base = (url: string) => url.replace(/\/+$/, "");

/** True when the cell answers its health check; a dead cell must not fail every review. */
export async function cellReachable(
  cell: { url: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${base(cell.url)}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runInCell(
  cell: { url: string; token: string | null },
  reviewId: string,
  body: { provider: RunnerProvider; model: string; request: ReviewRequest },
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<CellResult> {
  const f = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(`${base(cell.url)}/runs/${encodeURIComponent(reviewId)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cell.token ? { "x-reviewer-token": cell.token } : {}),
      },
      body: JSON.stringify({
        provider: {
          kind: body.provider.kind,
          baseUrl: body.provider.baseUrl,
          apiKey: body.provider.key,
        },
        model: body.model,
        request: body.request,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10 * 60_000),
    });
  } catch (e) {
    throw new Error(
      `reviewer cell at ${cell.url} unreachable: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const data = (await res.json().catch(() => ({}))) as Partial<CellResult> & { error?: string };
  if (!res.ok || !Array.isArray(data.groups))
    throw new Error(`reviewer cell: ${data.error ?? `status ${res.status}`}`);
  return {
    groups: data.groups,
    files: data.files ?? [],
    inputTokens: data.inputTokens ?? 0,
    outputTokens: data.outputTokens ?? 0,
  };
}
