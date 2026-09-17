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
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

export function severityColor(s: number | null): string {
  if (s === null) return "#9a9995";
  if (s >= 0.75) return STATUS.critical;
  if (s >= 0.5) return STATUS.serious;
  if (s >= 0.25) return STATUS.warning;
  return STATUS.good;
}
