/**
 * Composite priority = weights · features. Weights are user-adjustable sliders in the UI
 * and change no inference (the judgments are reusable data; only the view changes).
 */
export interface PriorityWeights {
  severity: number;
  urgency: number;
  reactions: number;
  comments: number;
  age: number;
}

export const DEFAULT_WEIGHTS: PriorityWeights = {
  severity: 0.35,
  urgency: 0.3,
  reactions: 0.15,
  comments: 0.1,
  age: 0.1,
};

export interface PriorityFeatures {
  severity: number | null;
  urgency: number | null;
  /** log-normalised 0..1 relative to the repo's busiest issue */
  reactionsNorm: number;
  commentsNorm: number;
  /** 0..1, older is higher, relative to the repo's oldest open issue */
  ageNorm: number;
}

/** log1p normalisation against a maximum; 0 when max is 0. */
export function logNorm(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.min(1, Math.log1p(value) / Math.log1p(max));
}

export function priority(f: PriorityFeatures, w: PriorityWeights = DEFAULT_WEIGHTS): number {
  const total = w.severity + w.urgency + w.reactions + w.comments + w.age;
  if (total <= 0) return 0;
  const sum =
    w.severity * (f.severity ?? 0) +
    w.urgency * (f.urgency ?? 0) +
    w.reactions * f.reactionsNorm +
    w.comments * f.commentsNorm +
    w.age * f.ageNorm;
  return Math.min(1, Math.max(0, sum / total));
}

// ---- Pull requests ---------------------------------------------------------

/**
 * What a maintainer should look at next among pull requests. Not sliders: the states are
 * categorical and the order is a policy, kept in one place.
 *  - approved and mergeable: finish it (highest);
 *  - waiting for a first review: sooner when older and when the review is quick;
 *  - changes requested: the ball is with the author (low);
 *  - draft: lowest.
 */
export interface PullFeatures {
  draft: boolean;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null */
  reviewDecision: string | null;
  hasReviews: boolean;
  mergeable: string | null;
  /** 0..1, older is higher, relative to the oldest open pull. */
  ageNorm: number;
  /** 0..1 review effort, or null when unknown. */
  effort: number | null;
}

export function pullAttention(f: PullFeatures): number {
  if (f.draft) return 0.05 + 0.05 * f.ageNorm;
  const conflict = f.mergeable === "CONFLICTING" ? -0.15 : 0;
  if (f.reviewDecision === "APPROVED") return clamp(0.85 + 0.1 * f.ageNorm + conflict);
  if (f.reviewDecision === "CHANGES_REQUESTED") return clamp(0.25 + 0.1 * f.ageNorm + conflict);
  const quick = f.effort === null ? 0.5 : 1 - f.effort;
  const base = f.hasReviews ? 0.45 : 0.55;
  return clamp(base + 0.2 * f.ageNorm + 0.15 * quick + conflict);
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}
