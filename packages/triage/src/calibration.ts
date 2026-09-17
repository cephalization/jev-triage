/**
 * Calibration: model confidence vs. agreement with human feedback, bucketed.
 * A well-calibrated model agrees with humans about as often as it is confident.
 */
export interface CalibrationPair {
  confidence: number;
  agreed: boolean;
}

export interface CalibrationBucket {
  /** inclusive lower bound */
  from: number;
  /** exclusive upper bound (inclusive for the last bucket) */
  to: number;
  count: number;
  agreement: number | null;
  meanConfidence: number | null;
}

export function calibrate(pairs: readonly CalibrationPair[], buckets = 5): CalibrationBucket[] {
  const out: CalibrationBucket[] = Array.from({ length: buckets }, (_, i) => ({
    from: i / buckets,
    to: (i + 1) / buckets,
    count: 0,
    agreement: null,
    meanConfidence: null,
  }));
  const agreedCount = Array.from({ length: buckets }, () => 0);
  const confSum = Array.from({ length: buckets }, () => 0);
  for (const p of pairs) {
    const c = Math.min(1, Math.max(0, p.confidence));
    const i = Math.min(buckets - 1, Math.floor(c * buckets));
    const b = out[i]!;
    b.count += 1;
    confSum[i]! += c;
    if (p.agreed) agreedCount[i]! += 1;
  }
  for (let i = 0; i < buckets; i++) {
    const b = out[i]!;
    if (b.count > 0) {
      b.agreement = agreedCount[i]! / b.count;
      b.meanConfidence = confSum[i]! / b.count;
    }
  }
  return out;
}

/** Expected calibration error: |confidence − agreement| weighted by bucket mass. */
export function expectedCalibrationError(buckets: readonly CalibrationBucket[]): number | null {
  const n = buckets.reduce((s, b) => s + b.count, 0);
  if (n === 0) return null;
  let ece = 0;
  for (const b of buckets) {
    if (b.count === 0 || b.agreement === null || b.meanConfidence === null) continue;
    ece += (b.count / n) * Math.abs(b.meanConfidence - b.agreement);
  }
  return ece;
}
