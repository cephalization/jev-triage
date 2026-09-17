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
