import { useQuery } from "@rocicorp/zero/react";
import { CATEGORIES, queries } from "@triage/schema";
import { calibrate, expectedCalibrationError } from "@triage/triage/calibration";
import { useMemo } from "react";
import { costOf, usePrices } from "../lib/api.ts";
import { calibrationPairs, type TriageRow } from "../lib/derive.ts";
import { compact, pct, SEVERITY_NAMES } from "../lib/format.ts";
import { Columns, HBars, Legend } from "./Charts.tsx";

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1 border-t pt-3">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Block({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t pt-4">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground text-pretty">{description}</p>
      </div>
      {children}
    </section>
  );
}

export function StatsPanel({ repoId, rows }: { repoId: string | null; rows: TriageRow[] }) {
  const [runs] = useQuery(repoId ? queries.runs.byRepo({ repoId, limit: 30 }) : undefined);
  const prices = usePrices();
  const classifyRuns = useMemo(
    () => (runs ?? []).filter((r) => r.kind === "classify" && r.status === "ok").reverse(),
    [runs],
  );

  const classified = rows.filter((r) => !r.unclassified);
  const review = rows.filter((r) => r.needsReview);
  const byCategory = CATEGORIES.map((c) => ({
    label: c,
    value: rows.filter((r) => r.category === c).length,
  }));
  const sevBuckets = SEVERITY_NAMES.map((label, i) => ({
    label,
    value: classified.filter((r) => r.severity !== null && Math.round(r.severity * 3) === i).length,
  }));
  const pairs = calibrationPairs(rows);
  const cal = calibrate(pairs, 5);
  const ece = expectedCalibrationError(cal);
  const totals = classifyRuns.reduce(
    (a, r) => ({
      input: a.input + r.input_tokens,
      output: a.output + r.output_tokens,
      ms: a.ms + r.latency_ms,
      q: a.q + r.questions,
    }),
    { input: 0, output: 0, ms: 0, q: 0 },
  );
  const cost = costOf(totals.input, totals.output, prices);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Issues in view" value={String(rows.length)} />
        <Tile
          label="Classified"
          value={pct(rows.length ? classified.length / rows.length : null)}
          sub={`${classified.length} of ${rows.length}`}
        />
        <Tile label="Needs review" value={String(review.length)} sub="unsure or disputed" />
        <Tile
          label="Human labels"
          value={String(rows.filter((r) => r.feedbackUsers.length > 0).length)}
          sub="issues with feedback"
        />
        <Tile
          label="Tokens, last 30 runs"
          value={`${compact(totals.input)} in`}
          sub={`${compact(totals.output)} out${cost ? ` · ${cost}` : ""}`}
        />
        <Tile
          label="Per question"
          value={totals.q ? `${Math.round(totals.input / totals.q)} in` : "–"}
          sub={
            classifyRuns.length
              ? `${Math.round(totals.ms / classifyRuns.length)} ms per request`
              : "no runs yet"
          }
        />
      </div>
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        <Block
          title="Category mix"
          description="Effective value: human feedback wins over the model."
        >
          <HBars data={byCategory} />
        </Block>
        <Block
          title="Severity"
          description="Expected score across the four rubric levels, rounded to a level."
        >
          <HBars data={sevBuckets} color="#e5484d" />
        </Block>
        <Block
          title="Calibration"
          description={
            ece !== null
              ? `Model confidence vs. agreement with human category and area feedback. Expected calibration error ${ece.toFixed(2)} over ${pairs.length} pairs.`
              : "Model confidence vs. agreement with human feedback. Give some feedback to populate."
          }
        >
          <Columns
            data={cal.map((b) => ({
              label: `${Math.round(b.from * 100)}–${Math.round(b.to * 100)}`,
              value: b.agreement ?? 0,
              marker: b.meanConfidence,
              hint: `${Math.round(b.from * 100)}–${Math.round(b.to * 100)}% confidence: ${b.count} pairs, agreement ${pct(b.agreement)}, mean confidence ${pct(b.meanConfidence)}`,
            }))}
            max={1}
            format={(v) => pct(v)}
          />
          <Legend
            items={[
              { label: "agreement with humans", color: "#2a78d6" },
              { label: "mean confidence", color: "#eb6834", shape: "dot" },
            ]}
          />
        </Block>
        <Block
          title="Tokens per request"
          description={`Input tokens for the last ${classifyRuns.length} classification runs. Hover for latency.`}
        >
          <Columns
            data={classifyRuns.map((r, i) => ({
              label: String(i + 1),
              value: r.input_tokens,
              hint: `${r.issues} issues, ${r.questions} questions: ${compact(r.input_tokens)} in / ${compact(r.output_tokens)} out, ${r.latency_ms} ms, ${r.model ?? ""}`,
            }))}
            format={(v) => compact(v)}
          />
        </Block>
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Calibration table</summary>
        <table className="mt-2 w-full max-w-md text-left tabular-nums">
          <thead>
            <tr>
              <th className="font-medium whitespace-nowrap">Bucket</th>
              <th className="font-medium whitespace-nowrap">Pairs</th>
              <th className="font-medium whitespace-nowrap">Agreement</th>
              <th className="font-medium whitespace-nowrap">Mean confidence</th>
            </tr>
          </thead>
          <tbody>
            {cal.map((b) => (
              <tr key={b.from} className="border-t">
                <td>
                  {Math.round(b.from * 100)}–{Math.round(b.to * 100)}%
                </td>
                <td>{b.count}</td>
                <td>{pct(b.agreement)}</td>
                <td>{pct(b.meanConfidence)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
