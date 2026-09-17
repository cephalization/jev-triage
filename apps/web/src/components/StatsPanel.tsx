import { useQuery } from "@rocicorp/zero/react";
import { CATEGORIES, queries } from "@triage/schema";
import { calibrate, expectedCalibrationError } from "@triage/triage/calibration";
import { useMemo } from "react";
import { calibrationPairs, type TriageRow } from "../lib/derive.ts";
import { compact, pct } from "../lib/format.ts";
import { Columns, HBars, Legend } from "./Charts.tsx";
import { costOf, usePrices } from "./RepoBar.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx";

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
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
  const sevBuckets = ["cosmetic", "degraded", "blocking", "critical"].map((label, i) => ({
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
    <div className="flex flex-col gap-4 p-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Issues in view" value={String(rows.length)} />
        <Tile
          label="Classified"
          value={pct(rows.length ? classified.length / rows.length : null)}
          sub={`${classified.length} of ${rows.length}`}
        />
        <Tile
          label="Needs review"
          value={String(review.length)}
          sub="low confidence, disagreement, duplicate"
        />
        <Tile
          label="Human labels"
          value={String(rows.filter((r) => r.feedbackUsers.length > 0).length)}
          sub="issues with feedback"
        />
        <Tile
          label="Tokens (last 30 runs)"
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
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Category mix</CardTitle>
            <CardDescription>Effective value (human feedback wins over the model).</CardDescription>
          </CardHeader>
          <CardContent>
            <HBars data={byCategory} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Severity</CardTitle>
            <CardDescription>
              Expected score across the four rubric levels, rounded to a level.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <HBars data={sevBuckets} color="#d03b3b" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Calibration</CardTitle>
            <CardDescription>
              Model confidence vs. agreement with human category/area feedback, by confidence
              bucket.
              {ece !== null
                ? ` Expected calibration error ${ece.toFixed(2)} over ${pairs.length} pairs.`
                : " Give some feedback to populate."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
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
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Tokens per request</CardTitle>
            <CardDescription>
              Input tokens for the last {classifyRuns.length} classification runs; hover for
              latency.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Columns
              data={classifyRuns.map((r, i) => ({
                label: String(i + 1),
                value: r.input_tokens,
                hint: `${r.issues} issues, ${r.questions} questions: ${compact(r.input_tokens)} in / ${compact(r.output_tokens)} out, ${r.latency_ms} ms, ${r.model ?? ""}`,
              }))}
              format={(v) => compact(v)}
            />
          </CardContent>
        </Card>
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Table view</summary>
        <table className="mt-2 w-full max-w-md text-left tabular-nums">
          <thead>
            <tr>
              <th>bucket</th>
              <th>pairs</th>
              <th>agreement</th>
              <th>mean confidence</th>
            </tr>
          </thead>
          <tbody>
            {cal.map((b) => (
              <tr key={b.from}>
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
