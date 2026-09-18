import { useEffect, useState } from "react";

export interface Prices {
  inputPerMTok: number;
  outputPerMTok: number;
}

export function usePrices(): Prices | null {
  const [prices, setPrices] = useState<Prices | null>(null);
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h: { prices: Prices | null }) => setPrices(h.prices))
      .catch(() => setPrices(null));
  }, []);
  return prices;
}

export function costOf(input: number, output: number, prices: Prices | null): string | null {
  if (!prices) return null;
  return `$${((input * prices.inputPerMTok + output * prices.outputPerMTok) / 1_000_000).toFixed(4)}`;
}

/** Fire-and-forget: the server answers 202 and progress streams through the repo row. */
export async function startSync(
  owner: string,
  name: string,
  opts: { paused?: boolean; limit?: number } = {},
): Promise<string | null> {
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, name, ...opts }),
    });
    const data = (await res.json()) as { error?: string };
    return res.ok ? null : (data.error ?? `sync failed (${res.status})`);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function parseRepoSpec(spec: string): { owner: string; name: string } | null {
  const m = /^\s*(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/.exec(spec);
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

/** Authenticated JSON call to the API; throws with the server's message on failure. */
export async function apiJson<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok)
    throw new Error(data.error ?? `${init.method ?? "GET"} ${path} failed (${res.status})`);
  return data;
}

/** Queue a guided review of a pull request with the repo's default provider and model. */
export function generateGuidedReview(token: string, pullId: string) {
  return apiJson<{ id: string }>(token, "/api/reviews", { method: "POST", body: { pullId } });
}

/** The unified diff a review was generated from; rendered by the review screen. */
export async function fetchReviewPatch(token: string, reviewId: string): Promise<string> {
  const res = await fetch(`/api/reviews/${encodeURIComponent(reviewId)}/patch`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `patch unavailable (${res.status})`);
  }
  return res.text();
}

export function pokeWorker(repoId: string) {
  return fetch("/api/classify/poke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoId }),
  });
}
