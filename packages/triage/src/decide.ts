import type { PullAnswers } from "./pulls.ts";
import type { IssueAnswers } from "./questions.ts";
import type { DuplicateCandidate, ReviewerCandidate } from "./types.ts";
import { THRESHOLDS, type Thresholds } from "./policy.ts";
import { NONE, REVIEW_EFFORT_LEVELS, SEVERITY_LEVELS, URGENCY_LEVELS } from "./types.ts";

/**
 * Policy lives here, not in the questions. Pure: answers in, decisions out.
 * Thresholds are named so they can move without touching inference.
 */

export interface Decision {
  category: { value: string | null; confidence: number; applied: boolean };
  area: { value: string | null; confidence: number; applied: boolean };
  /** 0..1, normalised expected score across the severity rubric. */
  severity: number | null;
  /** 0..1, normalised expected score across the urgency rubric. */
  urgency: number | null;
  needsInfo: { probability: number; yes: boolean } | null;
  actionable: { probability: number; yes: boolean } | null;
  duplicate: { of: DuplicateCandidate | null; confidence: number; candidateKey: string | null };
  /** True when a human should look: low-confidence category or a plausible duplicate. */
  needsReview: boolean;
  reasons: string[];
}

export function normaliseScore(score: number, levels: number): number {
  if (levels <= 1) return 0;
  return Math.min(1, Math.max(0, score / (levels - 1)));
}

export function decide(
  answers: IssueAnswers,
  candidates: readonly DuplicateCandidate[],
  t: Thresholds = THRESHOLDS,
): Decision {
  const reasons: string[] = [];

  const cat = answers.category;
  const category = cat
    ? { value: cat.choice, confidence: cat.confidence, applied: cat.confidence >= t.categoryAuto }
    : { value: null, confidence: 0, applied: false };
  if (cat && !category.applied)
    reasons.push(`category confidence ${cat.confidence.toFixed(2)} < ${t.categoryAuto}`);

  const ar = answers.area;
  const area = ar
    ? {
        value: ar.choice === NONE ? null : ar.choice,
        confidence: ar.confidence,
        applied: ar.choice !== NONE && ar.confidence >= t.areaAuto,
      }
    : { value: null, confidence: 0, applied: false };

  const severity = answers.severity
    ? normaliseScore(answers.severity.score, SEVERITY_LEVELS.length)
    : null;
  const urgency = answers.urgency
    ? normaliseScore(answers.urgency.score, URGENCY_LEVELS.length)
    : null;

  const needsInfo = answers.needs_info
    ? { probability: answers.needs_info.noul, yes: answers.needs_info.noul >= t.yes }
    : null;
  const actionable = answers.actionable
    ? { probability: answers.actionable.noul, yes: answers.actionable.noul >= t.yes }
    : null;

  let duplicate: Decision["duplicate"] = { of: null, confidence: 0, candidateKey: null };
  const dup = answers.duplicate;
  if (dup && dup.choice !== NONE) {
    const m = /^candidate_(\d+)$/.exec(dup.choice);
    const idx = m ? Number(m[1]) : -1;
    const target = idx >= 0 && idx < candidates.length ? candidates[idx]! : null;
    if (target && dup.confidence >= t.duplicateMin) {
      duplicate = { of: target, confidence: dup.confidence, candidateKey: dup.choice };
      reasons.push(`possible duplicate of #${target.number} (${dup.confidence.toFixed(2)})`);
    } else if (target) {
      duplicate = { of: null, confidence: dup.confidence, candidateKey: dup.choice };
    }
  } else if (dup) {
    duplicate = { of: null, confidence: dup.confidence, candidateKey: NONE };
  }

  const needsReview = (cat !== undefined && !category.applied) || duplicate.of !== null;
  return {
    category,
    area,
    severity,
    urgency,
    needsInfo,
    actionable,
    duplicate,
    needsReview,
    reasons,
  };
}

// ---- Pull requests ---------------------------------------------------------

export interface PullDecision {
  /** 0..1, normalised expected score across the review-effort rubric. */
  effort: number | null;
  /** Rubric level the expected score rounds to. */
  effortLevel: number | null;
  reviewer: {
    candidate: ReviewerCandidate | null;
    confidence: number;
    /** True when the suggestion is confident enough to show without a warning. */
    applied: boolean;
    candidateKey: string | null;
  };
  /** Probabilities re-keyed from candidate_N to logins (plus none). */
  reviewerProbabilities: Record<string, number>;
  needsReview: boolean;
  reasons: string[];
}

export function decidePull(
  answers: PullAnswers,
  candidates: readonly ReviewerCandidate[],
  t: Thresholds = THRESHOLDS,
): PullDecision {
  const reasons: string[] = [];
  const effort = answers.review_effort
    ? normaliseScore(answers.review_effort.score, REVIEW_EFFORT_LEVELS.length)
    : null;
  const effortLevel =
    effort === null ? null : Math.round(effort * (REVIEW_EFFORT_LEVELS.length - 1));

  const probs: Record<string, number> = {};
  let reviewer: PullDecision["reviewer"] = {
    candidate: null,
    confidence: 0,
    applied: false,
    candidateKey: null,
  };
  const rv = answers.reviewer;
  if (rv) {
    for (const [k, v] of Object.entries(rv.probabilities)) {
      const m = /^candidate_(\d+)$/.exec(k);
      const c = m ? candidates[Number(m[1])] : undefined;
      probs[c ? c.login : k] = v;
    }
    const m = /^candidate_(\d+)$/.exec(rv.choice);
    const idx = m ? Number(m[1]) : -1;
    const target = idx >= 0 && idx < candidates.length ? candidates[idx]! : null;
    reviewer = {
      candidate: target,
      confidence: rv.confidence,
      applied: target !== null && rv.confidence >= t.reviewerAuto,
      candidateKey: rv.choice,
    };
    if (target && !reviewer.applied)
      reasons.push(`reviewer confidence ${rv.confidence.toFixed(2)} < ${t.reviewerAuto}`);
    if (!target && rv.choice === NONE) reasons.push("no candidate has reviewed related code");
  }
  return {
    effort,
    effortLevel,
    reviewer,
    reviewerProbabilities: probs,
    needsReview: reasons.length > 0,
    reasons,
  };
}
