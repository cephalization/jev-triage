import type { EntryType, Questions, SystemOneResult } from "@typesafe-ai/sdk";

/** Transport seam: the real client in apps/api, canned answers in tests. */
export interface SystemOne {
  ask<const Q extends Questions>(state: EntryType, questions: Q): Promise<SystemOneResult<Q>>;
}

export interface RepoForTriage {
  owner: string;
  name: string;
  description: string;
  /** Component/area labels the model may pick from (top labels by usage). */
  areaLabels: string[];
}

export interface LabeledExample {
  number: number;
  title: string;
  excerpt: string;
  category: string;
  area?: string;
}

export interface DuplicateCandidate {
  id: string;
  number: number;
  title: string;
}

export interface IssueForTriage {
  id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  comments: number;
  reactions: number;
  ageDays: number;
  authorAssociation: string;
  candidates: DuplicateCandidate[];
}

export const QUESTIONS_VERSION = 1;

export const FAMILIES = [
  "category",
  "area",
  "severity",
  "needs_info",
  "actionable",
  "urgency",
  "duplicate",
] as const;
export type Family = (typeof FAMILIES)[number];

export const CATEGORY_LABELS = ["bug", "feature", "question", "docs", "chore", "other"] as const;
export type CategoryLabel = (typeof CATEGORY_LABELS)[number];

export const SEVERITY_LEVELS = [
  "Cosmetic or trivial: typo, minor visual glitch, no functional impact",
  "Degraded but workable: something misbehaves but a workaround exists",
  "Blocks a common workflow: a normal task cannot be completed",
  "Data loss, security exposure, crash, or outage",
] as const;

export const URGENCY_LEVELS = [
  "No hurry: can sit in the backlog",
  "Should be looked at this week",
  "Needs attention now: many users affected or actively getting worse",
] as const;

export const NONE = "none";

// ---- Pull requests ---------------------------------------------------------

export const PULL_FAMILIES = ["review_effort", "reviewer"] as const;
export type PullFamily = (typeof PULL_FAMILIES)[number];

/** Ordered rubric for how much reviewer time a pull request needs. */
export const REVIEW_EFFORT_LEVELS = [
  "Trivial: a few lines or a mechanical change (typo, version bump, lockfile, formatting, generated code); under fifteen minutes",
  "Small: one focused change in a single area that a reviewer can read start to finish in one sitting; about an hour",
  "Substantial: several files or new behaviour that needs careful reading and probably running locally; half a day",
  "Major: broad or risky change to core logic, data formats, concurrency, security, or many subsystems; a day or more",
] as const;

/** A reviewer the code shortlisted; the model picks among these (rerank pattern). */
export interface ReviewerCandidate {
  login: string;
  reviews: number;
  approvals: number;
  /** Directories they review most, most first. */
  dirs: string[];
  /** Titles of pull requests they recently approved. */
  recentTitles: string[];
  /** Open pull requests they are already requested on or reviewing. */
  openLoad: number;
  lastReviewDays: number | null;
  /** 0..1 share of this pull's changed directories they have reviewed before. */
  pathOverlap: number;
  /** Already requested on this pull. */
  requested: boolean;
}

export interface PullForTriage {
  id: string;
  number: number;
  title: string;
  body: string;
  state: string;
  draft: boolean;
  author: string;
  labels: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  files: string[];
  baseRef: string;
  ageDays: number;
  requestedReviewers: string[];
  reviewDecision: string | null;
  candidates: ReviewerCandidate[];
}
