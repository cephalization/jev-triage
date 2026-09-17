import { cn } from "cn";
import { Check, CircleAlert, CircleDashed } from "lucide-react";
import {
  ACTION_META,
  CATEGORY_COLORS,
  EFFORT_NAMES,
  effortLevel,
  pct,
  SEVERITY_NAMES,
  severityColor,
  severityLevel,
} from "../lib/format.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/** Confidence ring: distribution concentration, not correctness. */
export function ConfidenceRing({
  value,
  size = 14,
  className,
}: {
  value: number | null;
  size?: number;
  className?: string;
}) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const v = value ?? 0;
  return (
    <svg
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      role="img"
      aria-label={`confidence ${pct(value)}`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeOpacity={0.2}
        strokeWidth={2}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={`${c * v} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export type IssueStatus = "unclassified" | "classifying" | "model" | "human" | "review";

/**
 * Linear-style status circle. Two states matter to a maintainer: suggested (the ring) and
 * confirmed by a person (the check). The warning marks a suggestion the model was unsure of.
 */
export function StatusIcon({
  status,
  confidence,
  hint,
}: {
  status: IssueStatus;
  confidence?: number | null;
  hint?: string;
}) {
  const label =
    hint ??
    {
      unclassified: "Not classified yet",
      classifying: "Classifying…",
      model: `Suggested by the model (confidence ${pct(confidence)})`,
      human: "Confirmed by a person",
      review: "The model was unsure",
    }[status];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex size-4 items-center justify-center" aria-label={label}>
          {status === "unclassified" && <CircleDashed className="size-3.5 text-muted-foreground" />}
          {status === "classifying" && (
            <span className="size-3.5 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
          )}
          {status === "model" && (
            <ConfidenceRing value={confidence ?? 0} className="text-primary" />
          )}
          {status === "human" && (
            <span className="inline-flex size-3.5 items-center justify-center rounded-full bg-status-good text-white">
              <Check className="size-2.5" strokeWidth={3} />
            </span>
          )}
          {status === "review" && <CircleAlert className="size-3.5 text-status-warning" />}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Linear's priority glyph: four rising bars, filled to the level. */
export function PriorityBars({ value, className }: { value: number | null; className?: string }) {
  const level = value === null ? null : Math.min(4, Math.max(0, Math.ceil(value * 4)));
  const label = level === null ? "No priority yet" : `Priority ${pct(value)}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <svg
          width={16}
          height={16}
          viewBox="0 0 16 16"
          className={cn("shrink-0", className)}
          role="img"
          aria-label={label}
        >
          {level === null ? (
            <>
              <circle cx={3} cy={8} r={1.2} fill="currentColor" opacity={0.4} />
              <circle cx={8} cy={8} r={1.2} fill="currentColor" opacity={0.4} />
              <circle cx={13} cy={8} r={1.2} fill="currentColor" opacity={0.4} />
            </>
          ) : (
            [4, 7, 10, 13].map((h, i) => (
              <rect
                key={h}
                x={1 + i * 4}
                y={14 - h}
                width={3}
                height={h}
                rx={1}
                fill="currentColor"
                opacity={i < level ? 1 : 0.22}
              />
            ))
          )}
        </svg>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Severity as a colored dot plus the rubric level name. */
export function SeverityMark({
  value,
  labelClassName,
}: {
  value: number | null;
  labelClassName?: string;
}) {
  const level = severityLevel(value);
  if (level === null) return <span className="text-muted-foreground">—</span>;
  const name = SEVERITY_NAMES[level]!;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: severityColor(value) }}
          />
          <span className={labelClassName}>{name}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {name} · severity {pct(value)}
      </TooltipContent>
    </Tooltip>
  );
}

/** Label pill: colored dot, name, hairline border (Linear's label chip). */
export function Pill({
  color,
  children,
  trailing,
  className,
  muted = false,
}: {
  color?: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  className?: string;
  muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-40 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs whitespace-nowrap",
        muted ? "text-muted-foreground" : "text-foreground/90",
        className,
      )}
    >
      {color && (
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      )}
      <span className="truncate">{children}</span>
      {trailing}
    </span>
  );
}

/** Category chip. Confirmed values get a check; suggested ones are plain (confidence lives in the panel). */
export function CategoryChip({
  value,
  source,
}: {
  value: string | null;
  source: "human" | "model" | "none";
}) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <Pill
      color={CATEGORY_COLORS[value] ?? "#9a9995"}
      trailing={
        source === "human" ? <Check className="size-3 text-status-good" strokeWidth={3} /> : null
      }
    >
      {value}
    </Pill>
  );
}

/** The maintainer's next step as a pill; the tooltip carries the why line. */
export function ActionPill({
  value,
  source,
  hint,
  className,
}: {
  value: string | null;
  source: "human" | "model" | "none";
  hint?: string;
  className?: string;
}) {
  const meta = value ? ACTION_META[value] : undefined;
  if (!meta) return <span className="text-muted-foreground">—</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex", className)}>
          <Pill
            color={meta.color}
            trailing={
              source === "human" ? (
                <Check className="size-3 text-status-good" strokeWidth={3} />
              ) : null
            }
          >
            {meta.short}
          </Pill>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        <div className="font-medium">
          {meta.label}
          {source === "human" ? " · confirmed" : " · suggested"}
        </div>
        {hint && <div className="text-muted-foreground">{hint}</div>}
      </TooltipContent>
    </Tooltip>
  );
}

/** One stacked strip of outcome probabilities; the highlighted outcome is the model's pick. */
export function ProbStrip({
  probabilities,
  highlight,
  format = (k: string) => k,
}: {
  probabilities: Record<string, number>;
  highlight?: string | null;
  /** Turns an outcome key into a display name (e.g. severity level index → rubric name). */
  format?: (key: string) => string;
}) {
  const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0)
    return <span className="text-xs text-muted-foreground">no model answer</span>;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted">
        {entries.map(([k, v]) => (
          <span
            key={k}
            title={`${format(k)}: ${pct(v)}`}
            className={cn("h-full", k === highlight ? "bg-primary" : "bg-foreground/20")}
            style={{ width: pct(v) }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-2 text-2xs text-muted-foreground">
        {entries.slice(0, 4).map(([k, v]) => (
          <span key={k} className={cn(k === highlight && "text-foreground")}>
            {format(k)} <span className="tabular-nums">{Math.round(v * 100)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Review effort as a colored dot plus the rubric level name (same scale as severity). */
export function EffortMark({
  value,
  labelClassName,
}: {
  value: number | null;
  labelClassName?: string;
}) {
  const level = effortLevel(value);
  if (level === null) return <span className="text-muted-foreground">—</span>;
  const name = EFFORT_NAMES[level]!;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: severityColor(value) }}
          />
          <span className={labelClassName}>{name}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {name} · review effort {pct(value)}
      </TooltipContent>
    </Tooltip>
  );
}

/** Where a pull request stands with reviewers: approved, changes requested, or waiting. */
export function ReviewDecisionMark({
  decision,
  draft,
  hasReviews,
}: {
  decision: string | null;
  draft: boolean;
  hasReviews: boolean;
}) {
  const [label, node] = draft
    ? ["Draft", <CircleDashed key="d" className="size-3.5 text-muted-foreground" />]
    : decision === "APPROVED"
      ? [
          "Approved",
          <span
            key="a"
            className="inline-flex size-3.5 items-center justify-center rounded-full bg-status-good text-white"
          >
            <Check className="size-2.5" strokeWidth={3} />
          </span>,
        ]
      : decision === "CHANGES_REQUESTED"
        ? ["Changes requested", <CircleAlert key="c" className="size-3.5 text-status-serious" />]
        : hasReviews
          ? ["In review", <ConfidenceRing key="r" value={0.5} className="text-primary" />]
          : ["Awaiting review", <ConfidenceRing key="w" value={0} className="text-primary" />];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex size-4 items-center justify-center" aria-label={label}>
          {node}
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
