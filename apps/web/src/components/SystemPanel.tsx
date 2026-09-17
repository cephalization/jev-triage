import { useQuery, useZero } from "@rocicorp/zero/react";
import { mutators, queries } from "@triage/schema";
import { calibrate, expectedCalibrationError } from "@triage/triage/calibration";
import { THRESHOLDS } from "@triage/triage/policy";
import type { PriorityWeights } from "@triage/triage/priority";
import { useEffect, useMemo, useState } from "react";
import { costOf, pokeWorker, usePrices } from "../lib/api.ts";
import type { Session } from "../lib/auth.ts";
import { People } from "./People.tsx";
import { calibrationPairs, type TriageRow } from "../lib/derive.ts";
import { ago, compact, pct } from "../lib/format.ts";
import { Columns, Legend } from "./Charts.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";
import { Slider } from "./ui/slider.tsx";
import { Switch } from "./ui/switch.tsx";

const WEIGHT_KEYS: (keyof PriorityWeights)[] = [
  "severity",
  "urgency",
  "reactions",
  "comments",
  "age",
];

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1 border-t pt-3">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4 py-6 first:pt-0 last:pb-0 md:grid-cols-[14rem_1fr] md:gap-8">
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground text-pretty">{description}</p>
      </div>
      <div className="flex max-w-xl flex-col gap-4">{children}</div>
    </section>
  );
}

/** Operator-facing: how the model and worker are doing, what they cost, and the knobs. */
export function SystemPanel({
  session,
  repoId,
  rows,
  weights,
  setWeights,
  visibleIssueIds,
  now,
}: {
  session: Session;
  repoId: string | null;
  rows: TriageRow[];
  weights: PriorityWeights;
  setWeights: (w: PriorityWeights) => void;
  visibleIssueIds: string[];
  now: number;
}) {
  const z = useZero();
  const [repo] = useQuery(repoId ? queries.repos.byId(repoId) : undefined);
  const [runs] = useQuery(repoId ? queries.runs.byRepo({ repoId, limit: 30 }) : undefined);
  const prices = usePrices();
  const [batch, setBatch] = useState("20");
  const [cadence, setCadence] = useState("2000");
  const [budget, setBudget] = useState("0");
  const [limit, setLimit] = useState("100");
  const [pullLimit, setPullLimit] = useState("200");
  const [pullHistory, setPullHistory] = useState("300");
  useEffect(() => {
    if (!repo) return;
    setBatch(String(repo.batch_size));
    setCadence(String(repo.cadence_ms));
    setBudget(String(repo.budget_tokens));
    setLimit(String(repo.sync_limit));
    setPullLimit(String(repo.pull_limit));
    setPullHistory(String(repo.pull_history_limit));
  }, [
    repo?.id,
    repo?.batch_size,
    repo?.cadence_ms,
    repo?.budget_tokens,
    repo?.sync_limit,
    repo?.pull_limit,
    repo?.pull_history_limit,
  ]);

  const classifyRuns = useMemo(
    () => (runs ?? []).filter((r) => r.kind.startsWith("classify") && r.status === "ok").reverse(),
    [runs],
  );
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
  const spent = repo
    ? costOf(Number(repo.input_tokens_used), Number(repo.output_tokens_used), prices)
    : null;
  const pairs = calibrationPairs(rows);
  const cal = calibrate(pairs, 5);
  const ece = expectedCalibrationError(cal);
  const ws = repo?.workerState;
  const [adminLogins, setAdminLogins] = useState<string[]>([]);
  useEffect(() => {
    if (session.user.role !== "admin") return;
    fetch("/api/auth/admins", { headers: { authorization: `Bearer ${session.token}` } })
      .then((r) => (r.ok ? r.json() : { logins: [] }))
      .then((d: { logins: string[] }) => setAdminLogins(d.logins))
      .catch(() => setAdminLogins([]));
  }, [session]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col divide-y p-6">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 pb-6 sm:grid-cols-5">
        <Tile
          label="Spent to date"
          value={spent ?? "–"}
          sub={
            repo
              ? `${compact(Number(repo.input_tokens_used))} in · ${compact(Number(repo.output_tokens_used))} out${prices ? "" : " · set TYPESAFE_PRICE_* to price"}`
              : "pick a repository"
          }
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
        <Tile
          label="Waiting for the model"
          value={String(ws?.pending ?? 0)}
          sub={ws?.in_flight ? "one request in flight" : "idle"}
        />
        <Tile
          label="Calibration error"
          value={ece === null ? "–" : ece.toFixed(2)}
          sub={`${pairs.length} model vs human pairs`}
        />
      </div>

      {session.user.role === "admin" && (
        <Section
          title="People"
          description="Who can sign in. Invite a GitHub login and choose a role; removing an invite stops the next sign-in."
        >
          <People session={session} adminLogins={adminLogins} now={now} />
        </Section>
      )}

      <Section
        title="Classification"
        description="Shared with everyone on this repo. One TypeSafe request per batch, one in flight."
      >
        {!repo && <p className="text-muted-foreground">Pick a repository first.</p>}
        {repo && (
          <>
            <label className="flex items-center justify-between gap-4">
              <span>
                Pause classification
                <span className="block text-xs text-muted-foreground">
                  Triggers still queue; nothing is sent.
                </span>
              </span>
              <Switch
                checked={repo.paused}
                onCheckedChange={(v) =>
                  void z.mutate(mutators.repo.setKnobs({ repoId: repo.id, paused: v }))
                }
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="batch">Batch size</Label>
                <Input
                  id="batch"
                  className="h-8"
                  value={batch}
                  onChange={(e) => setBatch(e.target.value)}
                  inputMode="numeric"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cadence">Cadence (ms)</Label>
                <Input
                  id="cadence"
                  className="h-8"
                  value={cadence}
                  onChange={(e) => setCadence(e.target.value)}
                  inputMode="numeric"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="limit">Sync cap (issues)</Label>
                <Input
                  id="limit"
                  className="h-8"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  inputMode="numeric"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pull-limit">Open pull requests to keep</Label>
                <Input
                  id="pull-limit"
                  className="h-8"
                  value={pullLimit}
                  onChange={(e) => setPullLimit(e.target.value)}
                  inputMode="numeric"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pull-history">Reviewed pull requests (for reviewer stats)</Label>
                <Input
                  id="pull-history"
                  className="h-8"
                  value={pullHistory}
                  onChange={(e) => setPullHistory(e.target.value)}
                  inputMode="numeric"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="budget">Token budget (0 = unlimited)</Label>
                <Input
                  id="budget"
                  className="h-8"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  inputMode="numeric"
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-xs text-muted-foreground tabular-nums">
                Used {compact(Number(repo.tokens_used))} tokens
                {Number(repo.budget_tokens) > 0 ? ` of ${compact(Number(repo.budget_tokens))}` : ""}
              </span>
              <Button
                size="sm"
                onClick={() =>
                  void z.mutate(
                    mutators.repo.setKnobs({
                      repoId: repo.id,
                      batchSize: Math.min(50, Math.max(1, Number(batch) || 20)),
                      cadenceMs: Math.min(60_000, Math.max(250, Number(cadence) || 2000)),
                      budgetTokens: Math.max(0, Number(budget) || 0),
                      syncLimit: Math.min(5000, Math.max(1, Number(limit) || 100)),
                      pullLimit: Math.min(2000, Math.max(1, Number(pullLimit) || 200)),
                      pullHistoryLimit: Math.min(2000, Math.max(0, Number(pullHistory) || 0)),
                    }),
                  )
                }
              >
                Save
              </Button>
            </div>
          </>
        )}
      </Section>

      <Section
        title="Priority weights"
        description="How the priority bars in the list are computed. Only the view changes; nothing is re-asked. Stored in this browser."
      >
        {WEIGHT_KEYS.map((k) => (
          <div key={k} className="flex flex-col gap-1.5">
            <div className="flex justify-between">
              <Label className="capitalize">{k}</Label>
              <span className="text-xs text-muted-foreground tabular-nums">
                {weights[k].toFixed(2)}
              </span>
            </div>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={[weights[k]]}
              onValueChange={([v]) => setWeights({ ...weights, [k]: v ?? 0 })}
            />
          </div>
        ))}
        <p className="text-xs text-muted-foreground text-pretty">
          Policy thresholds live in code: category auto-apply at {THRESHOLDS.categoryAuto}, area at{" "}
          {THRESHOLDS.areaAuto}, next step at {THRESHOLDS.actionAuto}, duplicate at{" "}
          {THRESHOLDS.duplicateMin}, reviewer at {THRESHOLDS.reviewerAuto}. Duplicates are never
          auto-closed.
        </p>
      </Section>

      <Section
        title="Calibration"
        description="Model confidence vs. agreement with human feedback on category, area and next step. A well-calibrated model agrees about as often as it is confident."
      >
        {pairs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Confirm or correct a few suggestions to populate this.
          </p>
        ) : (
          <>
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
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Table</summary>
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
          </>
        )}
      </Section>

      <Section
        title="Requests"
        description={`Input tokens for the last ${classifyRuns.length} classification runs. Hover for latency.`}
      >
        {classifyRuns.length === 0 ? (
          <p className="text-xs text-muted-foreground">No runs yet.</p>
        ) : (
          <Columns
            data={classifyRuns.map((r, i) => ({
              label: String(i + 1),
              value: r.input_tokens,
              hint: `${r.issues} ${r.kind === "classify_pulls" ? "pulls" : "issues"}, ${r.questions} questions: ${compact(r.input_tokens)} in / ${compact(r.output_tokens)} out, ${r.latency_ms} ms, ${r.model ?? ""}`,
            }))}
            format={(v) => compact(v)}
          />
        )}
      </Section>

      <Section title="Worker" description="Backpressure stats, live from the server.">
        {!ws && <p className="text-muted-foreground">No runs yet.</p>}
        {ws && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">In flight</dt>
            <dd>{ws.in_flight ? "yes" : "no"}</dd>
            <dt className="text-muted-foreground">Dirty</dt>
            <dd>{ws.dirty ? "yes" : "no"}</dd>
            <dt className="text-muted-foreground">Pending</dt>
            <dd className="tabular-nums">{ws.pending}</dd>
            <dt className="text-muted-foreground">Requests</dt>
            <dd className="tabular-nums">{ws.requests}</dd>
            <dt className="text-muted-foreground">Dropped triggers</dt>
            <dd className="tabular-nums">{ws.dropped_triggers}</dd>
            <dt className="text-muted-foreground">Coalesced triggers</dt>
            <dd className="tabular-nums">{ws.coalesced_triggers}</dd>
            <dt className="text-muted-foreground">Updated</dt>
            <dd>{ago(ws.updated_at, now)}</dd>
            {ws.last_error && (
              <>
                <dt className="text-muted-foreground">Last error</dt>
                <dd className="text-destructive">{ws.last_error}</dd>
              </>
            )}
          </dl>
        )}
        {repo && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => void pokeWorker(repo.id)}>
              Poke worker
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={visibleIssueIds.length === 0}
              onClick={() =>
                void z.mutate(
                  mutators.repo.recalculate({
                    repoId: repo.id,
                    mode: "flag",
                    issueIds: visibleIssueIds,
                  }),
                )
              }
            >
              Re-ask {visibleIssueIds.length} in the triage list
            </Button>
          </div>
        )}
      </Section>

      {repo && (
        <Section
          title="Recalculate everything"
          description="Bumps the questions version. Every issue is re-asked; old answers are kept as history."
        >
          <div>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                if (
                  confirm(
                    "Bump questions_version? Every issue will be re-classified (new rows, old ones kept).",
                  )
                ) {
                  void z.mutate(mutators.repo.recalculate({ repoId: repo.id, mode: "version" }));
                }
              }}
            >
              Recalculate everything (v{repo.questions_version + 1})
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}
