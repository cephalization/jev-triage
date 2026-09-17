export function compact(n: number): string {
  if (!Number.isFinite(n)) return "–";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined) return "–";
  return `${(n * 100).toFixed(digits)}%`;
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Linear-style short stamp for list rows: "3m", "2h", "6d", "Mar 4". */
export function agoShort(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** Fixed categorical slots (dataviz palette order); never cycled. */
export const CATEGORY_COLORS: Record<string, string> = {
  bug: "#2a78d6",
  feature: "#eb6834",
  question: "#1baf7a",
  docs: "#eda100",
  chore: "#e87ba4",
  other: "#008300",
};

export const STATUS = {
  good: "#2e9e5b",
  warning: "#d9a021",
  serious: "#e07b39",
  critical: "#e5484d",
} as const;

export const SEVERITY_NAMES = ["Cosmetic", "Degraded", "Blocking", "Critical"] as const;
export const URGENCY_NAMES = ["No hurry", "This week", "Now"] as const;

/** 0..1 severity to a rubric level index (0–3), or null. */
export function severityLevel(s: number | null): number | null {
  if (s === null) return null;
  return Math.min(3, Math.max(0, Math.round(s * 3)));
}

export function severityColor(s: number | null): string {
  if (s === null) return "#9a9995";
  if (s >= 0.75) return STATUS.critical;
  if (s >= 0.5) return STATUS.serious;
  if (s >= 0.25) return STATUS.warning;
  return STATUS.good;
}

/**
 * The maintainer's next step, in the order the triage list shows its sections: things that
 * need a reply first, then work, then decisions, then housekeeping, then nothing.
 */
export interface ActionMeta {
  /** Section title and select label. */
  label: string;
  /** Short pill text in the list. */
  short: string;
  /** One line under the section title. */
  description: string;
  color: string;
}

export const ACTION_META: Record<string, ActionMeta> = {
  ask_author: {
    label: "Ask the author",
    short: "Ask",
    description: "Something is missing before anyone can act. Reply and ask for it.",
    color: "#eda100",
  },
  answer: {
    label: "Reply with an answer",
    short: "Answer",
    description: "A question or misunderstanding. Nothing in the project needs to change.",
    color: "#1baf7a",
  },
  investigate: {
    label: "Investigate",
    short: "Investigate",
    description: "A plausible defect with enough detail to try. Reproduce it.",
    color: "#2a78d6",
  },
  decide: {
    label: "Needs a decision",
    short: "Decide",
    description: "Work cannot start until the team agrees on direction.",
    color: "#e87ba4",
  },
  accept: {
    label: "Accept into backlog",
    short: "Accept",
    description: "Clear and complete. Label it, prioritise it, and it can be picked up.",
    color: "#2e9e5b",
  },
  close: {
    label: "Close",
    short: "Close",
    description: "Resolved, duplicate, out of scope, intended, or spam.",
    color: "#9a9995",
  },
  wait: {
    label: "Waiting",
    short: "Wait",
    description: "The ball is with someone else, or the next step cannot be judged yet.",
    color: "#6b6f76",
  },
};

export const ACTION_ORDER = [
  "ask_author",
  "answer",
  "investigate",
  "decide",
  "accept",
  "close",
  "wait",
] as const;

export const MISSING_NAMES: Record<string, string> = {
  repro_steps: "repro steps",
  versions: "versions",
  expected_vs_actual: "expected vs actual",
  minimal_example: "a minimal example",
  logs_or_error: "the error or logs",
  concrete_proposal: "a concrete proposal",
  none: "nothing",
};

export const EFFORT_NAMES = ["Trivial", "Small", "Substantial", "Major"] as const;

/** 0..1 review effort to a rubric level index (0–3), or null. */
export function effortLevel(e: number | null): number | null {
  if (e === null) return null;
  return Math.min(3, Math.max(0, Math.round(e * 3)));
}

export const REVIEW_DECISION_NAMES: Record<string, string> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Changes requested",
  REVIEW_REQUIRED: "Review required",
};

/** "+120 −30" style diff stat. */
export function diffStat(additions: number, deletions: number): string {
  return `+${compact(additions)} −${compact(deletions)}`;
}
