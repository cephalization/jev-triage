import { z } from "zod";

/**
 * Everything a reload or a shared link should restore lives in the URL: the repository, the
 * view, the open item, and every filter, sort and layout choice. Defaults are stripped from
 * the URL so it only says what differs from a fresh visit.
 */

export const SORT_KEYS = [
  "priority",
  "number",
  "updated",
  "severity",
  "category",
  "confidence",
] as const;
export const PULL_SORT_KEYS = [
  "priority",
  "number",
  "updated",
  "effort",
  "reviewer",
  "size",
] as const;

/** Carried by every route: which repository the app is looking at. */
export const rootSearch = z.object({ repo: z.string().optional() });

export const triageSearch = z.object({
  state: z.enum(["open", "closed", "all"]).default("open"),
  cat: z.string().default("all"),
  mine: z.boolean().default(false),
  done: z.boolean().default(false),
  q: z.string().default(""),
  sort: z.enum(SORT_KEYS).default("updated"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  group: z.boolean().default(true),
});
export type TriageSearch = z.infer<typeof triageSearch>;
export const TRIAGE_DEFAULTS: TriageSearch = triageSearch.parse({});

export const unsureSearch = z.object({ q: z.string().default("") });
export type UnsureSearch = z.infer<typeof unsureSearch>;
export const UNSURE_DEFAULTS: UnsureSearch = unsureSearch.parse({});

export const pullsSearch = z.object({
  state: z.enum(["open", "merged", "closed", "all"]).default("open"),
  q: z.string().default(""),
  sort: z.enum(PULL_SORT_KEYS).default("priority"),
  dir: z.enum(["asc", "desc"]).default("desc"),
  unsure: z.boolean().default(false),
  by: z.enum(["list", "reviewer"]).default("list"),
  mode: z.enum(["balanced", "model"]).default("balanced"),
});
export type PullsSearch = z.infer<typeof pullsSearch>;
export const PULLS_DEFAULTS: PullsSearch = pullsSearch.parse({});

/** The guided review screen: which step is open (1-based, so the URL reads naturally). */
export const reviewSearch = z.object({ step: z.number().int().min(1).default(1) });
export type ReviewSearch = z.infer<typeof reviewSearch>;
export const REVIEW_DEFAULTS: ReviewSearch = reviewSearch.parse({});
