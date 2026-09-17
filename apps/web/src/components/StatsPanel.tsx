import { useQuery } from "@rocicorp/zero/react";
import { CATEGORIES, queries } from "@triage/schema";
import { calibrate, expectedCalibrationError } from "@triage/triage/calibration";
import { cn } from "cn";
import { useMemo } from "react";
import { costOf, usePrices } from "../lib/api.ts";
import { calibrationPairs, suggestedLoad, type PullRow, type TriageRow } from "../lib/derive.ts";
import { agoShort, compact, EFFORT_NAMES, pct, SEVERITY_NAMES } from "../lib/format.ts";
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
  className,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 border-t pt-4", className)}>
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground text-pretty">{description}</p>
      </div>
      {children}
    </section>
  );
}

export interface ReviewerRosterRow {
  login: string;
  reviews: number;
  approvals: number;
  changes_requested: number;
  last_review_at?: number | null;
  median_response_hours?: number | null;
  open_load: number;
  dirs_json: readonly { dir: string; count: number }[];
}

export function StatsPanel({
  repoId,
  rows,
  pullRows,
  reviewers,
}: {
  repoId: string | null;
  rows: TriageRow[];
  pullRows: PullRow[];
  reviewers: readonly ReviewerRosterRow[];
}) {
  const [runs] = useQuery(repoId ? queries.runs.byRepo({ repoId, limit: 30 }) : undefined);
  const prices = usePrices();
  const classifyRuns = useMemo(
    () => (runs ?? []).filter((r) => r.kind.startsWith("classify") && r.status === "ok").reverse(),
    [runs],
  );
  const openPulls = pullRows.filter((r) => r.pull.state === "open");
  const awaiting = openPulls.filter(
    (r) => !r.pull.draft && r.pull.reviews.length === 0 && r.pull.review_decision !== "APPROVED",
  );
  const approved = openPulls.filter((r) => r.pull.review_decision === "APPROVED");
  const effortBuckets = EFFORT_NAMES.map((label, i) => ({
    label,
    value: openPulls.filter((r) => r.effortLevel === i).length,
  }));
  const suggested = suggestedLoad(openPulls);
  const now = Date.now();

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
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Open pull requests" value={String(openPulls.length)} />
        <Tile label="Awaiting first review" value={String(awaiting.length)} sub="not drafts" />
        <Tile label="Approved, unmerged" value={String(approved.length)} sub="ready to finish" />
        <Tile
          label="Quick reviews"
          value={String(
            openPulls.filter((r) => r.effortLevel !== null && r.effortLevel <= 1).length,
          )}
          sub="trivial or small"
        />
        <Tile label="Reviewers known" value={String(reviewers.length)} sub="from merged history" />
        <Tile
          label="Needs a reviewer"
          value={String(openPulls.filter((r) => !r.pull.draft && !r.assigned).length)}
          sub="no confident match"
        />
      </div>
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        <Block
          title="Reviewers"
          description="Who reviews what, from the reviewed pull requests synced for this repo. Suggested counts the load-balanced assignments across open pull requests."
          className="lg:col-span-2"
        >
          {reviewers.length === 0 && (
            <p className="text-xs text-muted-foreground">No reviewer history synced yet.</p>
          )}
          {reviewers.length > 0 && (
            <table className="w-full max-w-3xl text-left text-xs tabular-nums">
              <thead>
                <tr className="text-muted-foreground [&>th]:pr-3 [&>th]:pb-1 [&>th]:font-medium [&>th]:whitespace-nowrap">
                  <th>Reviewer</th>
                  <th>Reviews</th>
                  <th>Approved</th>
                  <th title="Median time from a pull opening to their first review">Response</th>
                  <th>Open</th>
                  <th>Suggested</th>
                  <th className="pr-0!">Last</th>
                </tr>
              </thead>
              <tbody>
                {reviewers.slice(0, 15).map((r) => (
                  <tr key={r.login} className="border-t">
                    <td className="py-1 pr-2">
                      <div className="truncate font-medium text-foreground">{r.login}</div>
                      <div className="truncate text-muted-foreground">
                        {r.dirs_json
                          .slice(0, 3)
                          .map((d) => d.dir)
                          .join(", ")}
                      </div>
                    </td>
                    <td className="py-1 pr-2 align-top">{r.reviews}</td>
                    <td className="py-1 pr-2 align-top">{r.approvals}</td>
                    <td className="py-1 pr-2 align-top">
                      {r.median_response_hours == null
                        ? "–"
                        : r.median_response_hours < 48
                          ? `${Math.round(r.median_response_hours)}h`
                          : `${Math.round(r.median_response_hours / 24)}d`}
                    </td>
                    <td className="py-1 pr-2 align-top">{r.open_load}</td>
                    <td className="py-1 pr-2 align-top">{suggested.get(r.login) ?? 0}</td>
                    <td className="py-1 align-top whitespace-nowrap text-muted-foreground">
                      {r.last_review_at ? agoShort(r.last_review_at, now) : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Block>
        <Block
          title="Review effort"
          description="Expected reviewer time across the four rubric levels for open pull requests."
        >
          <HBars data={effortBuckets} color="#eb6834" />
        </Block>
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
