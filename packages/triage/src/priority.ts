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
