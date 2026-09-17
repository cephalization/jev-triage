import { useQuery } from "@rocicorp/zero/react";
import { queries } from "@triage/schema";
import { cn } from "cn";
import { ago, compact } from "../lib/format.ts";

/**
 * One thin line under the repo bar that always says what the system is doing right now.
 * Both halves come straight from synced rows (repo.sync_* and worker_state), so every tab agrees.
 */
export function StatusStrip({ repoId, now }: { repoId: string | null; now: number }) {
  const [repo] = useQuery(repoId ? queries.repos.byId(repoId) : undefined);
  if (!repo) return <div className="h-8 border-b" />;
  const ws = repo.workerState;
  const syncing = repo.sync_status === "running";
  const classifying = !!ws?.in_flight;
  const pending = ws?.pending ?? 0;
  const busy = syncing || classifying || (pending > 0 && !repo.paused);
  return (
    <div className="relative flex h-8 items-center gap-4 overflow-hidden border-b px-4 text-xs text-muted-foreground">
      <div className={cn("absolute inset-x-0 top-0 h-0.5 bg-[#2a78d6]/20", !busy && "opacity-0")}>
        <div
          className={cn(
            "h-full w-1/3 bg-[#2a78d6]",
            busy && "animate-[slide_1.2s_ease-in-out_infinite]",
          )}
        />
      </div>
      <Item dot={syncing ? "live" : repo.sync_status === "error" ? "bad" : "idle"} label="sync">
        {syncing
          ? `${repo.sync_message ?? repo.sync_phase} · ${repo.sync_fetched} stored`
          : repo.sync_status === "error"
            ? (repo.sync_error ?? "error")
            : `${repo.sync_message ?? "idle"} · ${ago(repo.last_synced_at, now)}`}
        {repo.sync_rate_remaining != null && ` · rate ${compact(repo.sync_rate_remaining)}`}
      </Item>
      <Item
        dot={classifying ? "live" : ws?.last_error ? "bad" : pending > 0 ? "warn" : "idle"}
        label="classify"
      >
        {repo.paused
          ? `paused · ${pending} waiting`
          : classifying
            ? `request in flight · ${pending} waiting`
            : ws?.last_error
              ? ws.last_error
              : pending > 0
                ? `${pending} waiting`
                : "up to date"}
        {ws &&
          ws.requests > 0 &&
          ` · ${ws.requests} requests · ${compact(Number(repo.tokens_used))} tokens`}
      </Item>
      {ws && (ws.dropped_triggers > 0 || ws.coalesced_triggers > 0) && (
        <span className="ml-auto tabular-nums">
          {ws.coalesced_triggers} coalesced · {ws.dropped_triggers} deferred
        </span>
      )}
    </div>
  );
}

function Item({
  dot,
  label,
  children,
}: {
  dot: "live" | "idle" | "warn" | "bad";
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          dot === "live" && "animate-pulse bg-[#2a78d6]",
          dot === "idle" && "bg-[#0ca30c]",
          dot === "warn" && "bg-[#fab219]",
          dot === "bad" && "bg-[#d03b3b]",
        )}
      />
      <span className="font-medium text-foreground">{label}</span>
      <span className="truncate">{children}</span>
    </span>
  );
}
