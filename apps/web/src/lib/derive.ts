import {
  CLASSIFICATION_KINDS,
  effectiveIssue,
  numeric,
  type ClassificationLike,
  type EffectiveIssue,
  type FeedbackLike,
} from "@triage/schema";
import type { CalibrationPair } from "@triage/triage/calibration";
import { THRESHOLDS, type Thresholds } from "@triage/triage/policy";
import { logNorm, priority, type PriorityWeights } from "@triage/triage/priority";

/** Structural shape of an issue row with its synced relations (see queries.issues.byRepo). */
export interface IssueInput {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  labels_json: readonly string[];
  comments: number;
  reactions: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  url: string;
  reclassify: boolean;
  classifying: boolean;
  classifications: readonly ClassificationLike[];
  feedback: readonly (FeedbackLike & { id: string })[];
  labels: readonly { id: string; name: string; color: string }[];
  presence: readonly { user_id: string; name: string; color: string; updated_at: number }[];
}

export interface TriageRow<I extends IssueInput = IssueInput> {
  issue: I;
  effective: EffectiveIssue;
  category: string | null;
  categoryConfidence: number | null;
  area: string | null;
  severity: number | null;
  urgency: number | null;
  needsInfo: boolean | null;
  actionable: boolean | null;
  /** Issue id (or "#123" when a human typed a number) of the suggested duplicate. */
  duplicateOf: string | null;
  priority: number;
  needsReview: boolean;
  reviewReasons: string[];
  unclassified: boolean;
  feedbackUsers: string[];
}

const KIND_LABEL: Record<string, string> = {
  category: "category",
  area: "area",
  severity: "severity",
  needs_info: "needs info",
  actionable: "actionable",
  duplicate: "duplicate",
  urgency: "urgency",
};

export function deriveRows<I extends IssueInput>(
  issues: readonly I[],
  questionsVersion: number,
  weights: PriorityWeights,
  thresholds: Thresholds = THRESHOLDS,
  now = Date.now(),
): TriageRow<I>[] {
  let maxReactions = 0;
  let maxComments = 0;
  let maxAge = 0;
  for (const i of issues) {
    maxReactions = Math.max(maxReactions, i.reactions);
    maxComments = Math.max(maxComments, i.comments);
    maxAge = Math.max(maxAge, now - i.created_at);
  }
  return issues.map((raw) => {
    // Defensive: a jsonb column written as a JSON string (older sync rows) must not crash the table.
    const issue = Array.isArray(raw.labels_json)
      ? raw
      : { ...raw, labels_json: parseLabels(raw.labels_json) };
    const eff = effectiveIssue(
      issue.classifications,
      issue.feedback,
      questionsVersion,
      CLASSIFICATION_KINDS,
    );
    const severity = numeric(eff.severity);
    const urgency = numeric(eff.urgency);
    const needsInfoP = numeric(eff.needs_info);
    const actionableP = numeric(eff.actionable);
    const reasons: string[] = [];
    if (
      eff.category.source === "model" &&
      (eff.category.confidence ?? 0) < thresholds.categoryAuto
    ) {
      reasons.push(
        `category confidence ${(eff.category.confidence ?? 0).toFixed(2)} below ${thresholds.categoryAuto}`,
      );
    }
    for (const k of CLASSIFICATION_KINDS) {
      if (eff[k].disagreement)
        reasons.push(`human overrode ${KIND_LABEL[k]}: ${eff[k].model?.value} → ${eff[k].value}`);
    }
    const dup = eff.duplicate.value && eff.duplicate.value !== "none" ? eff.duplicate.value : null;
    if (dup && eff.duplicate.source === "model") reasons.push("possible duplicate");
    const feedbackUsers = [...new Set(issue.feedback.map((f) => f.user_id))];
    return {
      issue,
      effective: eff,
      category: eff.category.value,
      categoryConfidence: eff.category.confidence,
      area: eff.area.value === "none" ? null : eff.area.value,
      severity,
      urgency,
      needsInfo: needsInfoP === null ? null : needsInfoP >= thresholds.yes,
      actionable: actionableP === null ? null : actionableP >= thresholds.yes,
      duplicateOf: dup,
      priority: priority(
        {
          severity,
          urgency,
          reactionsNorm: logNorm(issue.reactions, maxReactions),
          commentsNorm: logNorm(issue.comments, maxComments),
          ageNorm: maxAge > 0 ? (now - issue.created_at) / maxAge : 0,
        },
        weights,
      ),
      needsReview: reasons.length > 0,
      reviewReasons: reasons,
      unclassified: eff.category.source === "none",
      feedbackUsers,
    };
  });
}

/** Confidence vs. agreement pairs for the calibration panel (category and area). */
export function calibrationPairs(rows: readonly TriageRow[]): CalibrationPair[] {
  const pairs: CalibrationPair[] = [];
  for (const r of rows) {
    for (const k of ["category", "area"] as const) {
      const f = r.effective[k];
      if (f.model && f.human && f.model.confidence != null) {
        pairs.push({ confidence: f.model.confidence, agreed: f.model.value === f.human.value });
      }
    }
  }
  return pairs;
}

export type SortKey = "priority" | "number" | "updated" | "severity" | "category" | "confidence";

export function sortRows<I extends IssueInput>(
  rows: TriageRow<I>[],
  key: SortKey,
  dir: "asc" | "desc",
): TriageRow<I>[] {
  const m = dir === "asc" ? 1 : -1;
  const cmp = (a: TriageRow<I>, b: TriageRow<I>): number => {
    switch (key) {
      case "priority":
        return a.priority - b.priority;
      case "number":
        return a.issue.number - b.issue.number;
      case "updated":
        return a.issue.updated_at - b.issue.updated_at;
      case "severity":
        return (a.severity ?? -1) - (b.severity ?? -1);
      case "confidence":
        return (a.categoryConfidence ?? -1) - (b.categoryConfidence ?? -1);
      case "category":
        return (a.category ?? "~").localeCompare(b.category ?? "~");
    }
  };
  return [...rows].sort((a, b) => m * cmp(a, b) || a.issue.number - b.issue.number);
}

function parseLabels(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}
