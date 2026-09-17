import { useQuery, useZero } from "@rocicorp/zero/react";
import { mutators, queries } from "@triage/schema";
import { THRESHOLDS } from "@triage/triage/policy";
import type { PriorityWeights } from "@triage/triage/priority";
import { useEffect, useState } from "react";
import { pokeWorker } from "../lib/api.ts";
import { ago, compact } from "../lib/format.ts";
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
      <div className="flex max-w-md flex-col gap-4">{children}</div>
    </section>
  );
}

export function Settings({
  repoId,
  weights,
  setWeights,
  visibleIssueIds,
  now,
}: {
  repoId: string | null;
  weights: PriorityWeights;
  setWeights: (w: PriorityWeights) => void;
  visibleIssueIds: string[];
  now: number;
}) {
  const z = useZero();
  const [repo] = useQuery(repoId ? queries.repos.byId(repoId) : undefined);
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

  const ws = repo?.workerState;
  return (
    <div className="mx-auto flex max-w-3xl flex-col divide-y p-6">
      <Section
        title="Priority weights"
        description="Only the view changes; nothing is re-asked. Stored in this browser."
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
          {THRESHOLDS.areaAuto}, duplicate at {THRESHOLDS.duplicateMin}, reviewer at{" "}
          {THRESHOLDS.reviewerAuto}. Duplicates are never auto-closed.
        </p>
      </Section>

      <Section
        title="Cost controls"
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

      <Section title="Worker" description="Backpressure stats, live from the server.">
        {!ws && <p className="text-muted-foreground">No runs yet.</p>}
        {ws && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">In flight</dt>
            <dd>{ws.in_flight ? "yes" : "no"}</dd>
            <dt className="text-muted-foreground">Dirty</dt>
            <dd>{ws.dirty ? "yes" : "no"}</dd>
            <dt className="text-muted-foreground">Pending issues</dt>
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
              Recalculate {visibleIssueIds.length} in view
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
