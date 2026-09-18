import { useQuery } from "@rocicorp/zero/react";
import { queries } from "@triage/schema";
import { useMemo, useState } from "react";
import { compact } from "../lib/format.ts";
import { Legend } from "./Charts.tsx";
import { Segmented } from "./ViewHeader.tsx";

/**
 * What review generation costs at the providers: every agent call priced by the pi catalog,
 * bucketed by day and split by model, provider or key owner. Unpriced calls (a model the
 * catalog does not know) are counted and shown as tokens only.
 */

type Dimension = "model" | "provider" | "owner";
type Window = 7 | 30 | 90;

const PALETTE = [
  "#5e6ad2",
  "#2a78d6",
  "#1baf7a",
  "#eda100",
  "#eb6834",
  "#e87ba4",
  "#8b7cf6",
  "#0ea5a3",
];

export function money(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function ReviewCost({ repoId, now }: { repoId: string; now: number }) {
  const [dimension, setDimension] = useState<Dimension>("model");
  const [days, setDays] = useState<Window>(30);
  const since = useMemo(() => now - days * 86_400_000, [now, days]);
  const [rows] = useQuery(queries.llmCosts.byRepo({ repoId, since, limit: 5000 }));

  const keyOf = (r: (typeof rows)[number]) =>
    dimension === "model"
      ? r.model
      : dimension === "provider"
        ? (r.provider?.label ?? r.provider_kind)
        : (r.keyOwner?.name ?? "unknown owner");

  const totals = useMemo(() => {
    const by = new Map<
      string,
      { calls: number; input: number; output: number; cost: number; unpriced: number }
    >();
    for (const r of rows) {
      const k = keyOf(r);
      const t = by.get(k) ?? { calls: 0, input: 0, output: 0, cost: 0, unpriced: 0 };
      t.calls += 1;
      t.input += r.input_tokens;
      t.output += r.output_tokens;
      t.cost += r.cost_usd;
      if (!r.priced) t.unpriced += 1;
      by.set(k, t);
    }
    return [...by.entries()].sort((a, b) => b[1].cost - a[1].cost || b[1].input - a[1].input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, dimension]);
  const keys = totals.map(([k]) => k);
  const colorOf = (k: string) => PALETTE[Math.max(0, keys.indexOf(k)) % PALETTE.length]!;

  // Daily buckets, oldest first, every day present so the chart reads as a calendar.
  const buckets = useMemo(() => {
    const dayMs = 86_400_000;
    const start = Math.floor(since / dayMs) * dayMs;
    const out: { day: number; by: Map<string, number>; total: number }[] = [];
    for (let t = start; t <= now; t += dayMs) out.push({ day: t, by: new Map(), total: 0 });
    for (const r of rows) {
      const i = Math.floor((r.created_at - start) / dayMs);
      const b = out[i];
      if (!b) continue;
      const k = keyOf(r);
      b.by.set(k, (b.by.get(k) ?? 0) + r.cost_usd);
      b.total += r.cost_usd;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, since, now, dimension]);

  const grand = totals.reduce((a, [, t]) => a + t.cost, 0);
  const unpriced = totals.reduce((a, [, t]) => a + t.unpriced, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label="Split by"
          value={dimension}
          options={[
            ["model", "Model"],
            ["provider", "Provider"],
            ["owner", "Key owner"],
          ]}
          onChange={setDimension}
        />
        <Segmented
          label="Window"
          value={String(days) as "7" | "30" | "90"}
          options={[
            ["7", "7 days"],
            ["30", "30 days"],
            ["90", "90 days"],
          ]}
          onChange={(v) => setDays(Number(v) as Window)}
        />
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {money(grand)} over {rows.length} calls
          {unpriced > 0 ? ` · ${unpriced} unpriced` : ""}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No review generation in this window.</p>
      ) : (
        <>
          <StackedDays buckets={buckets} keys={keys} colorOf={colorOf} />
          <Legend items={keys.slice(0, 8).map((k) => ({ label: k, color: colorOf(k) }))} />
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="py-1 font-normal">
                  {dimension === "model"
                    ? "Model"
                    : dimension === "provider"
                      ? "Provider"
                      : "Key owner"}
                </th>
                <th className="py-1 text-right font-normal">Calls</th>
                <th className="py-1 text-right font-normal">In</th>
                <th className="py-1 text-right font-normal">Out</th>
                <th className="py-1 text-right font-normal">Cost</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {totals.map(([k, t]) => (
                <tr key={k} className="border-t">
                  <td className="flex items-center gap-2 py-1">
                    <span
                      className="size-2 shrink-0 rounded-sm"
                      style={{ backgroundColor: colorOf(k) }}
                    />
                    <span className="truncate">{k}</span>
                  </td>
                  <td className="py-1 text-right">{t.calls}</td>
                  <td className="py-1 text-right">{compact(t.input)}</td>
                  <td className="py-1 text-right">{compact(t.output)}</td>
                  <td className="py-1 text-right">
                    {t.unpriced === t.calls ? "unpriced" : money(t.cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

/** Stacked columns per day; hover shows the day's total. */
function StackedDays({
  buckets,
  keys,
  colorOf,
}: {
  buckets: { day: number; by: Map<string, number>; total: number }[];
  keys: string[];
  colorOf: (k: string) => string;
}) {
  const width = 560;
  const height = 120;
  const padB = 16;
  const max = Math.max(0.0001, ...buckets.map((b) => b.total));
  const slot = width / buckets.length;
  const barW = Math.max(2, slot - 2);
  const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-32 w-full max-w-2xl"
      role="img"
      aria-label="Cost per day"
    >
      {buckets.map((b, i) => {
        let y = height - padB;
        const x = i * slot + 1;
        return (
          <g key={b.day}>
            <title>
              {fmt.format(b.day)}: {money(b.total)}
            </title>
            {keys.map((k) => {
              const v = b.by.get(k) ?? 0;
              if (v <= 0) return null;
              const h = ((height - padB - 4) * v) / max;
              y -= h;
              return <rect key={k} x={x} y={y} width={barW} height={h} fill={colorOf(k)} rx={1} />;
            })}
            {(i === 0 || i === buckets.length - 1 || i % Math.ceil(buckets.length / 6) === 0) && (
              <text
                x={x + barW / 2}
                y={height - 4}
                textAnchor="middle"
                className="fill-muted-foreground"
                fontSize={9}
              >
                {fmt.format(b.day)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
