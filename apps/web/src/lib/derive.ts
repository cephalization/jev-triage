import {
  CLASSIFICATION_KINDS,
  PULL_KINDS,
  effectiveIssue,
  numeric,
  type ClassificationLike,
  type EffectiveIssue,
  type EffectivePull,
  type FeedbackLike,
} from "@triage/schema";
import type { CalibrationPair } from "@triage/triage/calibration";
import { THRESHOLDS, type Thresholds } from "@triage/triage/policy";
import { logNorm, priority, pullAttention, type PriorityWeights } from "@triage/triage/priority";
import { assignReviewers, isBot, type Assignment } from "@triage/triage/reviewers";
import { ACTION_ORDER, effortLevel, MISSING_NAMES, severityLevel } from "./format.ts";

/** The synced triage row, when anyone has claimed the issue or marked it done. */
export interface TriageStateLike {
  status: string;
  claimed_by?: string | null;
  claimed_at?: number | null;
  done_by?: string | null;
  done_at?: number | null;
}

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
  triage?: TriageStateLike | null;
}

export interface TriageRow<I extends IssueInput = IssueInput> {
  issue: I;
  effective: EffectiveIssue;
  category: string | null;
  categoryConfidence: number | null;
  area: string | null;
  severity: number | null;
  urgency: number | null;
  /** The maintainer's next step (ACTION_LABELS), a person's if they set one. */
  action: string | null;
  actionConfidence: number | null;
  actionSource: "human" | "model" | "none";
  /** What a reply should ask for, or null when nothing is missing. */
  missing: string | null;
  /** Issue id (or "#123" when a human typed a number) of the suggested duplicate. */
  duplicateOf: string | null;
  /** One line a person can read instead of the glyphs: "Likely bug · blocks a workflow · …". */
  why: string;
  priority: number;
  needsReview: boolean;
  reviewReasons: string[];
  unclassified: boolean;
  feedbackUsers: string[];
  /** User id holding the issue, if anyone. */
  claimedBy: string | null;
  /** True once someone marked it triaged; it leaves the default list. */
  done: boolean;
}

const KIND_LABEL: Record<string, string> = {
  category: "category",
  area: "area",
  severity: "severity",
  duplicate: "duplicate",
  urgency: "urgency",
  action: "next step",
  missing: "missing info",
};

const SEVERITY_PHRASE = ["", "degraded", "blocks a workflow", "critical impact"] as const;

/** Compose the answers into a sentence; pure so it can be tested and reused in tooltips. */
export function whyLine(r: {
  category: string | null;
  categorySource: "human" | "model" | "none";
  severity: number | null;
  urgency: number | null;
  action: string | null;
  missing: string | null;
  duplicateOf: string | null;
  reactions: number;
  comments: number;
  ageDays: number;
}): string {
  const parts: string[] = [];
  if (r.category) {
    const name = r.category === "question" ? "a question" : r.category;
    parts.push(r.categorySource === "human" ? capitalize(name) : `Likely ${name}`);
  }
  const level = severityLevel(r.severity);
  if (level !== null && level > 0) parts.push(SEVERITY_PHRASE[level]!);
  if (r.urgency !== null && r.urgency >= 0.75) parts.push("needs attention now");
  if (r.action === "ask_author" && r.missing) parts.push(`missing ${MISSING_NAMES[r.missing]}`);
  if (r.duplicateOf) parts.push("possible duplicate");
  if (r.reactions > 0) parts.push(`${r.reactions} ${r.reactions === 1 ? "reaction" : "reactions"}`);
  if (r.comments > 0) parts.push(`${r.comments} ${r.comments === 1 ? "comment" : "comments"}`);
  if (r.ageDays >= 14) parts.push(`open ${Math.round(r.ageDays)}d`);
  return parts.join(" · ");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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
    const reasons: string[] = [];
    if (
      eff.category.source === "model" &&
      (eff.category.confidence ?? 0) < thresholds.categoryAuto
    ) {
      reasons.push(
        `category confidence ${(eff.category.confidence ?? 0).toFixed(2)} below ${thresholds.categoryAuto}`,
      );
    }
    if (eff.action.source === "model" && (eff.action.confidence ?? 0) < thresholds.actionAuto) {
      reasons.push(
        `next step unclear: confidence ${(eff.action.confidence ?? 0).toFixed(2)} below ${thresholds.actionAuto}`,
      );
    }
    for (const k of CLASSIFICATION_KINDS) {
      if (eff[k].disagreement)
        reasons.push(`human overrode ${KIND_LABEL[k]}: ${eff[k].model?.value} → ${eff[k].value}`);
    }
    const dup = eff.duplicate.value && eff.duplicate.value !== "none" ? eff.duplicate.value : null;
    if (dup && eff.duplicate.source === "model") reasons.push("possible duplicate");
    const feedbackUsers = [...new Set(issue.feedback.map((f) => f.user_id))];
    const action = eff.action.value;
    const missing = eff.missing.value === "none" ? null : eff.missing.value;
    const ageDays = (now - issue.created_at) / 86_400_000;
    return {
      issue,
      effective: eff,
      category: eff.category.value,
      categoryConfidence: eff.category.confidence,
      area: eff.area.value === "none" ? null : eff.area.value,
      severity,
      urgency,
      action,
      actionConfidence: eff.action.confidence,
      actionSource: eff.action.source,
      missing,
      duplicateOf: dup,
      why: whyLine({
        category: eff.category.value,
        categorySource: eff.category.source,
        severity,
        urgency,
        action,
        missing,
        duplicateOf: dup,
        reactions: issue.reactions,
        comments: issue.comments,
        ageDays,
      }),
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
      claimedBy: issue.triage?.claimed_by ?? null,
      done: issue.triage?.status === "done",
    };
  });
}

export interface IssueGroup<I extends IssueInput = IssueInput> {
  /** An action label, or null for issues the model has not answered yet. */
  action: string | null;
  rows: TriageRow<I>[];
}

/** Sections in ACTION_ORDER, unclassified last, empty sections omitted. Row order is kept. */
export function groupByAction<I extends IssueInput>(
  rows: readonly TriageRow<I>[],
): IssueGroup<I>[] {
  const buckets = new Map<string | null, TriageRow<I>[]>();
  for (const r of rows) {
    const key =
      r.action && ACTION_ORDER.includes(r.action as (typeof ACTION_ORDER)[number])
        ? r.action
        : null;
    const list = buckets.get(key);
    if (list) list.push(r);
    else buckets.set(key, [r]);
  }
  const out: IssueGroup<I>[] = [];
  for (const a of ACTION_ORDER) {
    const list = buckets.get(a);
    if (list) out.push({ action: a, rows: list });
  }
  const rest = buckets.get(null);
  if (rest) out.push({ action: null, rows: rest });
  return out;
}

export interface PresenceLike {
  user_id: string;
  name: string;
  color: string;
  issue_id?: string | null;
  updated_at: number;
}

/**
 * Presence rows are per tab; collapse them to one entry per user, keeping the freshest row
 * and, for the "viewing" hint, the freshest row that names an issue.
 */
export function activeUsers<P extends PresenceLike>(
  rows: readonly P[],
  now: number,
  ttlMs: number,
): (P & { issue_id: string | null })[] {
  const byUser = new Map<string, P & { issue_id: string | null }>();
  for (const row of rows) {
    if (row.updated_at <= now - ttlMs) continue;
    const prev = byUser.get(row.user_id);
    if (!prev) {
      byUser.set(row.user_id, { ...row, issue_id: row.issue_id ?? null });
      continue;
    }
    const issue = row.issue_id ?? null;
    const prefer = issue && (!prev.issue_id || row.updated_at > prev.updated_at);
    byUser.set(row.user_id, {
      ...(row.updated_at > prev.updated_at ? row : prev),
      issue_id: prefer ? issue : prev.issue_id,
    });
  }
  return [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Confidence vs. agreement pairs for the calibration panel (category, area and next step). */
export function calibrationPairs(rows: readonly TriageRow[]): CalibrationPair[] {
  const pairs: CalibrationPair[] = [];
  for (const r of rows) {
    for (const k of ["category", "area", "action"] as const) {
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

// ---- Pull requests ---------------------------------------------------------

/** Structural shape of a pull row with its synced relations (see queries.pulls.byRepo). */
export interface PullInput {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  author: string;
  head_ref: string;
  base_ref: string;
  additions: number;
  deletions: number;
  changed_files: number;
  files_json: readonly string[];
  labels_json: readonly string[];
  requested_reviewers_json: readonly string[];
  review_decision: string | null;
  mergeable: string | null;
  comments: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  merged_at: number | null;
  url: string;
  reclassify: boolean;
  classifying: boolean;
  classifications: readonly ClassificationLike[];
  feedback: readonly (FeedbackLike & { id: string })[];
  reviews: readonly { id: string; reviewer: string; state: string; submitted_at: number }[];
}

export interface ReviewerInput {
  login: string;
  reviews: number;
  approvals: number;
  open_load: number;
}

export interface PullRow<P extends PullInput = PullInput> {
  pull: P;
  effective: EffectivePull;
  /** 0..1 review effort, or null. */
  effort: number | null;
  effortLevel: number | null;
  /** The model's (or a person's) reviewer pick; "none" is null. */
  reviewer: string | null;
  reviewerConfidence: number | null;
  reviewerSource: "human" | "model" | "none";
  /** Load-balanced assignment across the visible open pulls (null when unassigned). */
  assigned: Assignment | null;
  /** Latest review state per reviewer, newest first. */
  latestReviews: { reviewer: string; state: string; submitted_at: number }[];
  /** Maintainer attention score, 0..1. */
  priority: number;
  needsReview: boolean;
  reviewReasons: string[];
  unclassified: boolean;
  feedbackUsers: string[];
}

export function derivePulls<P extends PullInput>(
  pulls: readonly P[],
  questionsVersion: number,
  reviewers: readonly ReviewerInput[],
  thresholds: Thresholds = THRESHOLDS,
  now = Date.now(),
): PullRow<P>[] {
  let maxAge = 0;
  for (const p of pulls) if (p.state === "open") maxAge = Math.max(maxAge, now - p.created_at);
  const rows = pulls.map((raw) => {
    const pull = {
      ...raw,
      files_json: parseLabels(raw.files_json),
      labels_json: parseLabels(raw.labels_json),
      requested_reviewers_json: parseLabels(raw.requested_reviewers_json),
    } as P;
    const eff = effectiveIssue(pull.classifications, pull.feedback, questionsVersion, PULL_KINDS);
    const effort = numeric(eff.review_effort);
    const reasons: string[] = [];
    const rv = eff.reviewer;
    const reviewer = rv.value && rv.value !== "none" ? rv.value : null;
    if (rv.source === "model" && reviewer && (rv.confidence ?? 0) < thresholds.reviewerAuto)
      reasons.push(
        `reviewer confidence ${(rv.confidence ?? 0).toFixed(2)} below ${thresholds.reviewerAuto}`,
      );
    if (rv.source === "model" && rv.model && !reviewer)
      reasons.push("no known reviewer for these files");
    for (const k of PULL_KINDS) {
      if (eff[k].disagreement)
        reasons.push(
          `human overrode ${k.replace("_", " ")}: ${eff[k].model?.value} → ${eff[k].value}`,
        );
    }
    const seen = new Set<string>();
    const latestReviews: PullRow["latestReviews"] = [];
    for (const r of [...pull.reviews].sort((a, b) => b.submitted_at - a.submitted_at)) {
      if (seen.has(r.reviewer) || r.state === "COMMENTED" || r.state === "PENDING") continue;
      seen.add(r.reviewer);
      latestReviews.push({ reviewer: r.reviewer, state: r.state, submitted_at: r.submitted_at });
    }
    const priority = pullAttention({
      draft: pull.draft,
      reviewDecision: pull.review_decision,
      hasReviews: pull.reviews.length > 0,
      mergeable: pull.mergeable,
      ageNorm: maxAge > 0 ? (now - pull.created_at) / maxAge : 0,
      effort,
    });
    return {
      pull,
      effective: eff,
      effort,
      effortLevel: effortLevel(effort),
      reviewer,
      reviewerConfidence: rv.confidence,
      reviewerSource: rv.source,
      assigned: null as Assignment | null,
      latestReviews,
      priority,
      needsReview: reasons.length > 0,
      reviewReasons: reasons,
      unclassified: eff.review_effort.source === "none",
      feedbackUsers: [...new Set(pull.feedback.map((f) => f.user_id))],
    };
  });

  // Spread suggestions: a person's explicit pick is fixed; the model's distributions are balanced.
  const load: Record<string, number> = {};
  for (const r of reviewers) load[r.login] = r.open_load;
  const fixed = rows.filter(
    (r) => r.pull.state === "open" && r.reviewerSource === "human" && r.reviewer,
  );
  for (const r of fixed) {
    r.assigned = { login: r.reviewer!, probability: 1, balanced: false };
    load[r.reviewer!] = (load[r.reviewer!] ?? 0) + 1;
  }
  // Older answers may carry mass on accounts since dropped from the roster (bots); ignore it.
  const known = new Set(reviewers.map((r) => r.login));
  const eligible = (login: string) =>
    login !== "none" && !isBot(login) && (known.size === 0 || known.has(login));
  const assignments = assignReviewers(
    rows
      .filter((r) => r.pull.state === "open" && r.reviewerSource === "model" && r.reviewer)
      .map((r) => ({
        id: r.pull.id,
        priority: r.priority,
        probabilities: Object.fromEntries(
          Object.entries(r.effective.reviewer.probabilities).filter(([k]) => eligible(k)),
        ),
      })),
    load,
  );
  for (const r of rows) {
    const a = assignments.get(r.pull.id);
    if (a) r.assigned = a;
  }
  return rows;
}

export type PullSortKey = "priority" | "number" | "updated" | "effort" | "reviewer" | "size";

export function sortPulls<P extends PullInput>(
  rows: PullRow<P>[],
  key: PullSortKey,
  dir: "asc" | "desc",
): PullRow<P>[] {
  const m = dir === "asc" ? 1 : -1;
  const cmp = (a: PullRow<P>, b: PullRow<P>): number => {
    switch (key) {
      case "priority":
        return a.priority - b.priority;
      case "number":
        return a.pull.number - b.pull.number;
      case "updated":
        return a.pull.updated_at - b.pull.updated_at;
      case "effort":
        return (a.effort ?? -1) - (b.effort ?? -1);
      case "size":
        return a.pull.additions + a.pull.deletions - (b.pull.additions + b.pull.deletions);
      case "reviewer":
        return (a.assigned?.login ?? "~").localeCompare(b.assigned?.login ?? "~");
    }
  };
  return [...rows].sort((a, b) => m * cmp(a, b) || a.pull.number - b.pull.number);
}

/** Suggested load per reviewer across the given rows (for the roster). */
export function suggestedLoad(rows: readonly PullRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows)
    if (r.assigned) out.set(r.assigned.login, (out.get(r.assigned.login) ?? 0) + 1);
  return out;
}

export type ReviewerMode = "balanced" | "model";

export interface PullGroup<P extends PullInput = PullInput> {
  /** Reviewer login, or null for pulls with no suggestion. */
  login: string | null;
  rows: PullRow<P>[];
}

/** Who a row points at under each mode: the balanced assignment, or the raw model/human pick. */
export function suggestedReviewer(row: PullRow, mode: ReviewerMode): string | null {
  if (mode === "balanced") return row.assigned?.login ?? null;
  return row.reviewer;
}

/** Group by suggested reviewer, largest group first, the no-suggestion group last. Row order is kept. */
export function groupByReviewer<P extends PullInput>(
  rows: readonly PullRow<P>[],
  mode: ReviewerMode,
): PullGroup<P>[] {
  const groups = new Map<string | null, PullRow<P>[]>();
  for (const r of rows) {
    const key = suggestedReviewer(r, mode);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.entries()]
    .map(([login, list]) => ({ login, rows: list }))
    .sort((a, b) => {
      if (a.login === null) return 1;
      if (b.login === null) return -1;
      return b.rows.length - a.rows.length || a.login.localeCompare(b.login);
    });
}
