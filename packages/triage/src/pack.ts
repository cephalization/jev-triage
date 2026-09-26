/**
 * Right-sizing a request. The model has a bounded window (see docs.typesafe.ai/models) and
 * its accuracy falls as unrelated state grows, so a batch is packed to a budget of estimated
 * tokens rather than to a fixed count. Sizes are measured on the serialized request, which is
 * what the model actually reads; the caller turns characters into tokens with a ratio it
 * calibrates from the usage every response reports. Pure, so the packing is testable.
 */

export interface ItemCosts {
  /** Serialized size of a request with no items: repo, examples, and the constant parts. */
  base: number;
  /** Serialized size each item adds on its own, in the same unit as `base`. */
  costs: number[];
}

/** Measures every item alone against an empty request, so packing is one pass. */
export function itemCosts<T>(
  items: readonly T[],
  measure: (subset: readonly T[]) => number,
): ItemCosts {
  const base = measure([]);
  return { base, costs: items.map((item) => Math.max(0, measure([item]) - base)) };
}

/**
 * How many leading items fit: the longest prefix whose total stays within `budget`, at most
 * `maxItems`. Order is kept because it is the claim order (newest first). Always at least one
 * item when there are any, so an oversized item goes out alone and fails alone.
 */
export function packPrefix(
  costs: readonly number[],
  base: number,
  budget: number,
  maxItems: number,
): number {
  let total = base;
  let n = 0;
  for (const cost of costs) {
    if (n >= maxItems) break;
    if (n > 0 && total + cost > budget) break;
    total += cost;
    n += 1;
  }
  return n;
}

/** A calibrated characters-per-token ratio: a moving average clamped to a sane range. */
export function calibrateCharsPerToken(previous: number, chars: number, tokens: number): number {
  if (!(tokens > 0) || !(chars > 0)) return previous;
  const observed = chars / tokens;
  const next = previous * 0.7 + observed * 0.3;
  return Math.min(8, Math.max(2, next));
}
