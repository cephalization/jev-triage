import { cn } from "cn";
import { CATEGORY_COLORS, pct, severityColor } from "../lib/format.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/** Confidence ring: distribution concentration, not correctness. */
export function ConfidenceRing({ value, size = 16 }: { value: number | null; size?: number }) {
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const v = value ?? 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <svg
          width={size}
          height={size}
          className="shrink-0"
          role="img"
          aria-label={`confidence ${pct(value)}`}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.15}
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
      </TooltipTrigger>
      <TooltipContent>model confidence {pct(value)}</TooltipContent>
    </Tooltip>
  );
}

export function CategoryChip({
  value,
  confidence,
  source,
}: {
  value: string | null;
  confidence: number | null;
  source: "human" | "model" | "none";
}) {
  if (!value) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs">
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: CATEGORY_COLORS[value] ?? "#9a9995" }}
      />
      <span className={cn(source === "human" && "font-semibold")}>{value}</span>
      {source === "model" ? <ConfidenceRing value={confidence} size={14} /> : null}
      {source === "human" ? <span className="text-[10px] text-muted-foreground">human</span> : null}
    </span>
  );
}

/** Meter: the fill carries severity; the track is a lighter step of the same idea. */
export function Meter({
  value,
  label,
  color,
}: {
  value: number | null;
  label: string;
  color?: string;
}) {
  const fill = color ?? severityColor(value);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-2" aria-label={`${label} ${pct(value)}`}>
          <span className="relative block h-1.5 w-14 overflow-hidden rounded-full bg-muted">
            <span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ width: pct(value ?? 0), backgroundColor: fill }}
            />
          </span>
          <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
            {value === null ? "–" : (value * 100).toFixed(0)}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {label}: {pct(value)}
      </TooltipContent>
    </Tooltip>
  );
}

/** Probabilities as thin horizontal bars, sorted by mass. */
export function ProbBars({
  probabilities,
  highlight,
}: {
  probabilities: Record<string, number>;
  highlight?: string | null;
}) {
  const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0)
    return <span className="text-xs text-muted-foreground">no model answer</span>;
  return (
    <div className="flex flex-col gap-1">
      {entries.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[7rem_1fr_2.5rem] items-center gap-2 text-xs">
          <span className={cn("truncate", k === highlight && "font-semibold")} title={k}>
            {k}
          </span>
          <span className="relative block h-1.5 overflow-hidden rounded-full bg-muted">
            <span
              className="absolute inset-y-0 left-0 rounded-r-full bg-[#2a78d6]"
              style={{ width: pct(v) }}
            />
          </span>
          <span className="text-right tabular-nums text-muted-foreground">{pct(v)}</span>
        </div>
      ))}
    </div>
  );
}
