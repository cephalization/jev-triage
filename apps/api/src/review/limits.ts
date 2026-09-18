/**
 * Guard rails on generation, pure so they are testable: a sliding-window rate limit per
 * person, and a per-repository budget on what reviews may spend at the provider.
 */

export class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly limit: number;
  readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Records a hit and answers whether it was allowed. */
  take(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfterMs: number } {
    const since = now - this.windowMs;
    const recent = (this.#hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.limit) {
      this.#hits.set(key, recent);
      return { ok: false, retryAfterMs: recent[0]! + this.windowMs - now };
    }
    recent.push(now);
    this.#hits.set(key, recent);
    return { ok: true };
  }
}

/** True when a budget is set and the tokens already spent reach it. */
export function overBudget(usedTokens: number, budgetTokens: number): boolean {
  return budgetTokens > 0 && usedTokens >= budgetTokens;
}
