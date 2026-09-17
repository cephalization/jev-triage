import { useQuery } from "@rocicorp/zero/react";
import { queries } from "@triage/schema";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { ago, compact } from "../lib/format.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Switch } from "./ui/switch.tsx";

interface Prices {
  inputPerMTok: number;
  outputPerMTok: number;
}

export function usePrices(): Prices | null {
  const [prices, setPrices] = useState<Prices | null>(null);
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h: { prices: Prices | null }) => setPrices(h.prices))
      .catch(() => setPrices(null));
  }, []);
  return prices;
}

export function costOf(input: number, output: number, prices: Prices | null): string | null {
  if (!prices) return null;
  return `$${((input * prices.inputPerMTok + output * prices.outputPerMTok) / 1_000_000).toFixed(4)}`;
}

export function RepoBar({
  repoId,
  onSelect,
  issueCount,
  classifiedCount,
}: {
  repoId: string | null;
  onSelect: (id: string) => void;
  issueCount: number;
  classifiedCount: number;
}) {
  const [repos] = useQuery(queries.repos.all());
  const [repo] = useQuery(repoId ? queries.repos.byId(repoId) : undefined);
  const [runs] = useQuery(repoId ? queries.runs.byRepo({ repoId, limit: 30 }) : undefined);
  const prices = usePrices();
  const [target, setTarget] = useState("");
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sync(spec: string, pausedOnCreate: boolean) {
    const m = /^\s*(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/.exec(spec);
    if (!m) {
      setError("Use owner/name");
      return;
    }
    setBusy(true);
    setError(null);
    onSelect(`${m[1]}/${m[2]}`);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: m[1], name: m[2], paused: pausedOnCreate }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) setError(data.error ?? `sync failed (${res.status})`);
      else setTarget("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const lastClassify = (runs ?? []).find((r) => r.kind === "classify" && r.status === "ok");
  const totals = (runs ?? []).reduce(
    (acc, r) => ({ input: acc.input + r.input_tokens, output: acc.output + r.output_tokens }),
    { input: 0, output: 0 },
  );
  const cost = costOf(totals.input, totals.output, prices);

  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
      <Select value={repoId ?? ""} onValueChange={onSelect}>
        <SelectTrigger className="w-64">
          <SelectValue placeholder="Pick a repo" />
        </SelectTrigger>
        <SelectContent>
          {repos.map((r) => (
            <SelectItem key={r.id} value={r.id}>
              {r.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void sync(target, paused);
        }}
      >
        <Input
          className="w-56"
          placeholder="owner/name to add or sync"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <Switch checked={paused} onCheckedChange={setPaused} /> start paused
        </label>
        <Button type="submit" size="sm" disabled={busy || !target.trim()}>
          <RefreshCw className={busy ? "animate-spin" : ""} /> Sync
        </Button>
      </form>
      {repo && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy || repo.sync_status === "running"}
          onClick={() => void sync(repo.id, false)}
        >
          <RefreshCw className={repo.sync_status === "running" ? "animate-spin" : ""} /> Re-sync
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
      {repo && (
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge
            variant={
              repo.sync_status === "error"
                ? "destructive"
                : repo.sync_status === "running"
                  ? "default"
                  : "secondary"
            }
          >
            sync {repo.sync_status}
          </Badge>
          {repo.sync_error && <span className="text-destructive">{repo.sync_error}</span>}
          <span>{issueCount} issues</span>
          <span>{classifiedCount} classified</span>
          <span>synced {ago(repo.last_synced_at)}</span>
          <span title={repo.sync_cursor ?? ""}>
            cursor {repo.sync_cursor ? repo.sync_cursor.slice(0, 10) : "none"}
          </span>
          <span>v{repo.questions_version}</span>
          {lastClassify && (
            <span
              title={`last run: ${lastClassify.issues} issues, ${lastClassify.questions} questions`}
            >
              last run {compact(lastClassify.input_tokens)} in /{" "}
              {compact(lastClassify.output_tokens)} out · {lastClassify.latency_ms} ms ·{" "}
              {lastClassify.model}
            </span>
          )}
          <span>
            total {compact(Number(repo.tokens_used))} tokens{cost ? ` · ${cost}` : ""}
          </span>
          {repo.paused && <Badge variant="outline">classification paused</Badge>}
        </div>
      )}
    </div>
  );
}
