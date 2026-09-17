import { useQuery } from "@rocicorp/zero/react";
import { queries } from "@triage/schema";
import { cn } from "cn";
import {
  ChartColumn,
  Check,
  ChevronsUpDown,
  CircleAlert,
  GitPullRequest,
  Inbox,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
} from "lucide-react";
import { useState } from "react";
import { parseRepoSpec, startSync } from "../lib/api.ts";
import type { Session } from "../lib/auth.ts";
import { ago, compact } from "../lib/format.ts";
import type { Theme } from "../lib/theme.ts";
import { Avatar } from "./Avatar.tsx";
import { OnlineUsers } from "./Presence.tsx";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Input } from "./ui/input.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export type View = "triage" | "review" | "pulls" | "stats" | "settings";

const NAV: { id: View; label: string; icon: typeof Inbox; key: string }[] = [
  { id: "triage", label: "Triage", icon: Inbox, key: "g t" },
  { id: "review", label: "Review", icon: CircleAlert, key: "g r" },
  { id: "pulls", label: "Pull requests", icon: GitPullRequest, key: "g p" },
  { id: "stats", label: "Stats", icon: ChartColumn, key: "g s" },
  { id: "settings", label: "Settings", icon: SettingsIcon, key: "g ," },
];

export function Sidebar({
  session,
  repoId,
  onSelectRepo,
  view,
  onView,
  counts,
  onOpenIssue,
  onLogout,
  theme,
  setTheme,
  now,
}: {
  session: Session;
  repoId: string | null;
  onSelectRepo: (id: string) => void;
  view: View;
  onView: (v: View) => void;
  counts: Partial<Record<View, number>>;
  onOpenIssue: (id: string) => void;
  onLogout: () => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  now: number;
}) {
  const [repos] = useQuery(queries.repos.all());
  const [repo] = useQuery(repoId ? queries.repos.byId(repoId) : undefined);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sync(spec: string) {
    const parsed = parseRepoSpec(spec);
    if (!parsed) {
      setError("Use owner/name");
      return false;
    }
    setError(null);
    onSelectRepo(`${parsed.owner}/${parsed.name}`);
    const err = await startSync(parsed.owner, parsed.name);
    setError(err);
    return !err;
  }

  return (
    <div className="flex h-full flex-col gap-1 bg-sidebar p-2 text-sidebar-foreground">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left font-medium hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <RepoMark id={repoId} />
            <span className="min-w-0 flex-1 truncate">{repoId ?? "Pick a repository"}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            Repositories
          </DropdownMenuLabel>
          {repos.map((r) => (
            <DropdownMenuItem key={r.id} onSelect={() => onSelectRepo(r.id)}>
              <RepoMark id={r.id} />
              <span className="min-w-0 flex-1 truncate">{r.id}</span>
              {r.id === repoId && <Check className="size-3.5" />}
            </DropdownMenuItem>
          ))}
          {repos.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">Nothing synced yet.</div>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setAdding(true)}>
            <Plus className="size-3.5" />
            Add repository…
          </DropdownMenuItem>
          {repo && (
            <DropdownMenuItem
              disabled={repo.sync_status === "running"}
              onSelect={() => void sync(repo.id)}
            >
              <RefreshCw className="size-3.5" />
              Sync now
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <nav className="flex flex-col gap-px pt-2" aria-label="Views">
        {NAV.map((n) => {
          const count = counts[n.id];
          return (
            <button
              key={n.id}
              type="button"
              data-active={view === n.id || undefined}
              onClick={() => onView(n.id)}
              className="flex h-7 items-center gap-2 rounded-md px-2 text-left text-foreground/80 hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-active:bg-sidebar-accent data-active:text-foreground"
            >
              <n.icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1">{n.label}</span>
              {count !== undefined && count > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex-1" />

      {repo && <Activity repo={repo} now={now} onSync={() => void sync(repo.id)} />}
      {error && <p className="px-2 text-xs text-destructive">{error}</p>}

      <div className="flex flex-col gap-2 border-t border-sidebar-border pt-2">
        <OnlineUsers selfId={session.user.userID} onOpenIssue={onOpenIssue} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Avatar
                name={session.user.name}
                color={session.user.color}
                size="md"
                className="ring-sidebar"
              />
              <span className="min-w-0 flex-1 truncate">{session.user.name}</span>
              <MoreHorizontal className="size-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              <DropdownMenuRadioItem value="system">
                <Monitor className="size-3.5" /> System
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">
                <Sun className="size-3.5" /> Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <Moon className="size-3.5" /> Dark
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onLogout}>
              <LogOut className="size-3.5" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AddRepoDialog
        open={adding}
        onOpenChange={setAdding}
        onSubmit={async (spec) => {
          const ok = await sync(spec);
          if (ok) setAdding(false);
          return ok;
        }}
      />
    </div>
  );
}

function RepoMark({ id }: { id: string | null }) {
  const letter = (id?.split("/")[1]?.[0] ?? id?.[0] ?? "?").toUpperCase();
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-primary text-2xs font-semibold text-primary-foreground">
      {letter}
    </span>
  );
}

function AddRepoDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (spec: string) => Promise<boolean>;
}) {
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!parseRepoSpec(spec)) {
              setError("Use owner/name or a GitHub URL");
              return;
            }
            setBusy(true);
            setError(null);
            const ok = await onSubmit(spec.trim());
            setBusy(false);
            if (ok) setSpec("");
            else setError("Sync could not start; check the API log");
          }}
        >
          <DialogHeader>
            <DialogTitle>Add repository</DialogTitle>
            <DialogDescription>
              Issues and pull requests sync newest first and classify as they land. Caps live in
              Settings.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="owner/name"
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy || !spec.trim()}>
              {busy ? "Starting…" : "Add and sync"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Structural view of the repo row; only what the status lines need. */
interface RepoRow {
  id: string;
  sync_status: string;
  sync_error?: string | null;
  sync_phase: string;
  sync_fetched: number;
  sync_message?: string | null;
  last_synced_at?: number | null;
  paused: boolean;
  tokens_used: number;
  workerState?: {
    in_flight: boolean;
    pending: number;
    dropped_triggers: number;
    coalesced_triggers: number;
    requests: number;
    last_error?: string | null;
  } | null;
}

/** What the system is doing right now, straight from synced rows so every tab agrees. */
function Activity({ repo, now, onSync }: { repo: RepoRow; now: number; onSync: () => void }) {
  const ws = repo.workerState;
  const syncing = repo.sync_status === "running";
  const classifying = !!ws?.in_flight;
  const pending = ws?.pending ?? 0;
  const syncText = syncing
    ? `${repo.sync_message ?? repo.sync_phase} · ${repo.sync_fetched} stored`
    : repo.sync_status === "error"
      ? (repo.sync_error ?? "error")
      : (repo.sync_message ?? "idle");
  const classifyText = repo.paused
    ? `paused · ${pending} waiting`
    : classifying
      ? `in flight · ${pending} waiting`
      : ws?.last_error
        ? ws.last_error
        : pending > 0
          ? `${pending} waiting`
          : "up to date";
  return (
    <div className="flex flex-col gap-2 px-2 pb-2 text-xs">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <Dot state={syncing ? "live" : repo.sync_status === "error" ? "bad" : "idle"} />
          <span className="flex-1 font-medium">Sync</span>
          <span className="text-muted-foreground">{ago(repo.last_synced_at, now)}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={syncing}
                onClick={onSync}
                aria-label="Sync now"
                className="rounded-sm p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw className={cn("size-3", syncing && "animate-spin")} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Sync now</TooltipContent>
          </Tooltip>
        </div>
        <div className="truncate pl-3.5 text-muted-foreground" title={syncText}>
          {syncText}
        </div>
      </div>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <Dot
            state={
              classifying
                ? "live"
                : ws?.last_error
                  ? "bad"
                  : pending > 0 && !repo.paused
                    ? "warn"
                    : "idle"
            }
          />
          <span className="flex-1 font-medium">Classify</span>
          <span className="text-muted-foreground tabular-nums">
            {compact(Number(repo.tokens_used))} tokens
          </span>
        </div>
        <div className="truncate pl-3.5 text-muted-foreground" title={classifyText}>
          {classifyText}
          {ws && ws.requests > 0 && ` · ${ws.requests} requests`}
          {ws && ws.coalesced_triggers > 0 && ` · ${ws.coalesced_triggers} coalesced`}
          {ws && ws.dropped_triggers > 0 && ` · ${ws.dropped_triggers} deferred`}
        </div>
      </div>
    </div>
  );
}

function Dot({ state }: { state: "live" | "idle" | "warn" | "bad" }) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "live" && "animate-pulse bg-primary",
        state === "idle" && "bg-status-good",
        state === "warn" && "bg-status-warning",
        state === "bad" && "bg-status-critical",
      )}
    />
  );
}
