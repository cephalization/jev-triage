import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { apiJson } from "../lib/api.ts";
import type { Session } from "../lib/auth.ts";
import { ago, compact } from "../lib/format.ts";
import { Tag } from "./Marks.tsx";
import { Button } from "./ui/button.tsx";

/**
 * What the reviewer cells hold for this repository: one snapshot per reviewed commit (the
 * repository as text the agent can read), one small record per review run, and the ledger
 * itself. Sizes are the cells' SQLite files, so this is the real footprint.
 */

interface CellStats {
  configured: boolean;
  reachable?: boolean;
  snapshots?: {
    sha: string;
    status: string;
    files: number;
    bytes: number;
    dbBytes: number;
    error: string | null;
    createdAt: number | null;
    lastUsedAt: number | null;
  }[];
  runs?: { count: number; bytes: number; calls: number };
  indexBytes?: number;
}

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function ReviewEnvironment({ repoId, session }: { repoId: string; session: Session }) {
  const [stats, setStats] = useState<CellStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owner, name] = repoId.split("/") as [string, string];
  const load = useCallback(() => {
    apiJson<CellStats>(session.token, `/api/repos/${owner}/${name}/cell`)
      .then(setStats)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [session.token, owner, name]);
  useEffect(load, [load]);

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!stats) return <p className="text-xs text-muted-foreground">Asking the reviewer cell…</p>;
  if (!stats.configured)
    return (
      <p className="text-xs text-muted-foreground text-pretty">
        No reviewer cell is configured. Install celld and run `vp run dev` again; reviews then get a
        repository snapshot and tools, and this shows what they hold.
      </p>
    );
  if (!stats.reachable)
    return <p className="text-xs text-status-warning">The reviewer cell is not answering.</p>;

  const snapshots = stats.snapshots ?? [];
  const snapshotBytes = snapshots.reduce((a, s) => a + s.dbBytes, 0);
  const total = snapshotBytes + (stats.runs?.bytes ?? 0) + (stats.indexBytes ?? 0);
  const remove = async (sha: string) => {
    await apiJson(session.token, `/api/repos/${owner}/${name}/cell/snapshots/${sha}`, {
      method: "DELETE",
    }).catch(() => null);
    load();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <Stat label="Cells, total" value={bytesLabel(total)} sub="SQLite on disk" />
        <Stat
          label="Snapshots"
          value={String(snapshots.length)}
          sub={`${bytesLabel(snapshotBytes)} · one per reviewed commit`}
        />
        <Stat
          label="Review runs"
          value={String(stats.runs?.count ?? 0)}
          sub={`${bytesLabel(stats.runs?.bytes ?? 0)} · ${stats.runs?.calls ?? 0} agent calls`}
        />
        <Stat label="Ledger" value={bytesLabel(stats.indexBytes ?? 0)} sub="this list" />
      </div>
      {snapshots.length > 0 && (
        <ol className="flex flex-col divide-y text-xs">
          {snapshots.map((s) => (
            <li key={s.sha} className="flex items-center gap-2 py-1.5">
              <span className="font-mono">{s.sha.slice(0, 7)}</span>
              <Tag>{s.status}</Tag>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {s.status === "ready"
                  ? `${compact(s.files)} files · ${bytesLabel(s.bytes)} of text · ${bytesLabel(s.dbBytes)} on disk`
                  : (s.error ?? s.status)}
              </span>
              <span className="w-16 shrink-0 text-right whitespace-nowrap text-muted-foreground">
                {ago(s.lastUsedAt ?? s.createdAt, Date.now())}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Delete snapshot ${s.sha.slice(0, 7)}`}
                onClick={() => void remove(s.sha)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
