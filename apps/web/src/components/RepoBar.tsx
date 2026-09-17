import { useQuery } from "@rocicorp/zero/react";
import { queries } from "@triage/schema";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { compact } from "../lib/format.ts";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";

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

/** Fire-and-forget: the server answers 202 and progress streams through the repo row. */
export async function startSync(
  owner: string,
  name: string,
  opts: { paused?: boolean; limit?: number } = {},
): Promise<string | null> {
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, name, ...opts }),
    });
    const data = (await res.json()) as { error?: string };
    return res.ok ? null : (data.error ?? `sync failed (${res.status})`);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function parseRepoSpec(spec: string): { owner: string; name: string } | null {
  const m = /^\s*(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/.exec(spec);
  return m ? { owner: m[1]!, name: m[2]! } : null;
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
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(spec: string) {
    const parsed = parseRepoSpec(spec);
    if (!parsed) {
      setError("Use owner/name");
      return;
    }
    setError(null);
    setTarget("");
    onSelect(`${parsed.owner}/${parsed.name}`);
    setError(await startSync(parsed.owner, parsed.name));
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2">
      <Select value={repoId ?? ""} onValueChange={onSelect}>
        <SelectTrigger className="w-60">
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
          void submit(target);
        }}
      >
        <Input
          className="w-56"
          placeholder="owner/name"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <Button type="submit" size="sm" disabled={!target.trim()}>
          Add
        </Button>
      </form>
      {repo && (
        <Button
          size="sm"
          variant="outline"
          disabled={repo.sync_status === "running"}
          onClick={() => void submit(repo.id)}
        >
          <RefreshCw className={repo.sync_status === "running" ? "animate-spin" : ""} /> Sync now
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
      {repo && (
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {issueCount} issues · {classifiedCount} classified
          </span>
          <span>cap {repo.sync_limit}</span>
          <span>v{repo.questions_version}</span>
          <span className="tabular-nums">{compact(Number(repo.tokens_used))} tokens</span>
          {repo.paused && <Badge variant="outline">classification paused</Badge>}
        </div>
      )}
    </div>
  );
}
