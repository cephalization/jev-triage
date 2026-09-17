import { useQuery, useZero } from "@rocicorp/zero/react";
import { mutators, queries } from "@triage/schema";
import { THRESHOLDS } from "@triage/triage/policy";
import type { PriorityWeights } from "@triage/triage/priority";
import { useEffect, useState } from "react";
import { ago, compact } from "../lib/format.ts";
import { Button } from "./ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card.tsx";
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
  useEffect(() => {
    if (!repo) return;
    setBatch(String(repo.batch_size));
    setCadence(String(repo.cadence_ms));
    setBudget(String(repo.budget_tokens));
    setLimit(String(repo.sync_limit));
  }, [repo?.id, repo?.batch_size, repo?.cadence_ms, repo?.budget_tokens, repo?.sync_limit]);

  const ws = repo?.workerState;
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>Priority weights</CardTitle>
          <CardDescription>
            Only the view changes; nothing is re-asked. Stored per browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {WEIGHT_KEYS.map((k) => (
            <div key={k} className="flex flex-col gap-1">
              <div className="flex justify-between text-sm">
                <Label>{k}</Label>
                <span className="tabular-nums text-muted-foreground">{weights[k].toFixed(2)}</span>
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
          <div className="text-xs text-muted-foreground">
            Policy thresholds (in code): category auto-apply ≥ {THRESHOLDS.categoryAuto}, area ≥{" "}
            {THRESHOLDS.areaAuto}, duplicate ≥ {THRESHOLDS.duplicateMin}. Duplicates are never
            auto-closed.
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cost controls</CardTitle>
          <CardDescription>
            Shared with everyone on this repo. One TypeSafe request per batch, one in flight.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {!repo && <p className="text-sm text-muted-foreground">Pick a repo.</p>}
          {repo && (
            <>
              <label className="flex items-center justify-between text-sm">
                <span>Classification paused</span>
                <Switch
                  checked={repo.paused}
                  onCheckedChange={(v) =>
                    void z.mutate(mutators.repo.setKnobs({ repoId: repo.id, paused: v }))
                  }
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label>Batch size</Label>
                  <Input
                    value={batch}
                    onChange={(e) => setBatch(e.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>Cadence (ms)</Label>
                  <Input
                    value={cadence}
                    onChange={(e) => setCadence(e.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>Sync cap (issues)</Label>
                  <Input
                    value={limit}
                    onChange={(e) => setLimit(e.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label>Budget (tokens, 0 = ∞)</Label>
                  <Input
                    value={budget}
                    onChange={(e) => setBudget(e.target.value)}
                    inputMode="numeric"
                  />
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void z.mutate(
                    mutators.repo.setKnobs({
                      repoId: repo.id,
                      batchSize: Math.min(50, Math.max(1, Number(batch) || 20)),
                      cadenceMs: Math.min(60_000, Math.max(250, Number(cadence) || 2000)),
                      budgetTokens: Math.max(0, Number(budget) || 0),
                      syncLimit: Math.min(5000, Math.max(1, Number(limit) || 100)),
                    }),
                  )
                }
              >
                Save knobs
              </Button>
              <div className="text-xs text-muted-foreground">
                used {compact(Number(repo.tokens_used))} tokens
                {Number(repo.budget_tokens) > 0 ? ` of ${compact(Number(repo.budget_tokens))}` : ""}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Worker</CardTitle>
          <CardDescription>Backpressure stats, live from the server.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {!ws && <p className="text-muted-foreground">No runs yet.</p>}
          {ws && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">in flight</dt>
              <dd>{ws.in_flight ? "yes" : "no"}</dd>
              <dt className="text-muted-foreground">dirty</dt>
              <dd>{ws.dirty ? "yes" : "no"}</dd>
              <dt className="text-muted-foreground">pending issues</dt>
              <dd>{ws.pending}</dd>
              <dt className="text-muted-foreground">requests</dt>
              <dd>{ws.requests}</dd>
              <dt className="text-muted-foreground">dropped triggers</dt>
              <dd>{ws.dropped_triggers}</dd>
              <dt className="text-muted-foreground">coalesced triggers</dt>
              <dd>{ws.coalesced_triggers}</dd>
              <dt className="text-muted-foreground">updated</dt>
              <dd>{ago(ws.updated_at, now)}</dd>
              {ws.last_error && (
                <>
                  <dt className="text-muted-foreground">last error</dt>
                  <dd className="text-destructive">{ws.last_error}</dd>
                </>
              )}
            </dl>
          )}
          {repo && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() =>
                  void fetch("/api/classify/poke", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ repoId: repo.id }),
                  })
                }
              >
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
                Recalculate {visibleIssueIds.length} filtered
              </Button>
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
          )}
        </CardContent>
      </Card>
    </div>
  );
}
