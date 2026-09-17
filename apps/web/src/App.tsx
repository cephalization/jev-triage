import { useQuery } from "@rocicorp/zero/react";
import { CATEGORIES, queries } from "@triage/schema";
import { LogOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IssuePanel } from "./components/IssuePanel.tsx";
import { IssueTable, type UserInfo } from "./components/IssueTable.tsx";
import { OnlineUsers } from "./components/Presence.tsx";
import { RepoBar } from "./components/RepoBar.tsx";
import { Settings } from "./components/Settings.tsx";
import { StatsPanel } from "./components/StatsPanel.tsx";
import { StatusStrip } from "./components/StatusStrip.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Switch } from "./components/ui/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import type { Session } from "./lib/auth.ts";
import { deriveRows, sortRows, type SortKey } from "./lib/derive.ts";
import { useNow, usePresenceHeartbeat } from "./lib/presence.ts";
import { useLocalState, useWeights } from "./lib/store.ts";

type StateFilter = "open" | "closed" | "all";

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return (
    !!t &&
    (t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT" ||
      t.isContentEditable ||
      t.getAttribute("role") === "combobox")
  );
}

export function App({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [repos] = useQuery(queries.repos.all());
  const [{ repoId: storedRepo }, setStoredRepo] = useLocalState<{ repoId: string | null }>(
    "typeful-triage.repo",
    { repoId: null },
  );
  const repoId =
    storedRepo && repos.some((r) => r.id === storedRepo)
      ? storedRepo
      : (repos[0]?.id ?? storedRepo);
  const [repo] = useQuery(repoId ? queries.repos.byId(repoId) : undefined);
  const [users] = useQuery(queries.users.all());
  const [stateFilter, setStateFilter] = useState<StateFilter>("open");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "updated",
    dir: "desc",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState("triage");
  const [weights, setWeights] = useWeights();
  const now = useNow();
  usePresenceHeartbeat(repoId, selectedId);

  const [issues, issuesResult] = useQuery(
    repoId ? queries.issues.byRepo({ repoId, state: stateFilter, search, limit: 500 }) : undefined,
  );
  const version = repo?.questions_version ?? 1;
  const rows = useMemo(
    () => deriveRows(issues ?? [], version, weights),
    [issues, version, weights],
  );
  const filtered = useMemo(() => {
    let r = rows;
    if (category !== "all")
      r = r.filter((x) => (category === "unclassified" ? x.unclassified : x.category === category));
    if (reviewOnly) r = r.filter((x) => x.needsReview);
    return sortRows(r, sort.key, sort.dir);
  }, [rows, category, reviewOnly, sort]);
  const reviewRows = useMemo(
    () =>
      sortRows(
        rows.filter((r) => r.needsReview),
        "confidence",
        "asc",
      ),
    [rows],
  );
  const userMap = useMemo(
    () =>
      new Map(
        users.map((u) => [u.id, { id: u.id, name: u.name, color: u.color } satisfies UserInfo]),
      ),
    [users],
  );
  const numberToId = useMemo(() => new Map((issues ?? []).map((i) => [i.number, i.id])), [issues]);
  const areaLabels = useMemo(() => (repo?.labels ?? []).map((l) => l.name).sort(), [repo?.labels]);
  const visible = tab === "review" ? reviewRows : filtered;
  const loading = !!repoId && issuesResult?.type !== "complete" && (issues ?? []).length === 0;

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "number" || key === "category" ? "asc" : "desc" },
    );

  // Keyboard: j/k move, Enter opens, Esc closes. The panel itself handles 1–6.
  const move = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const idx = visible.findIndex((r) => r.issue.id === selectedId);
      const next =
        idx < 0
          ? delta > 0
            ? 0
            : visible.length - 1
          : Math.min(visible.length - 1, Math.max(0, idx + delta));
      const id = visible[next]!.issue.id;
      setSelectedId(id);
      document.querySelector(`[data-issue-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
    },
    [visible, selectedId],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        (document.activeElement as HTMLElement | null)?.blur();
        setSelectedId(null);
        return;
      }
      if (isTyping(e)) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "/") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("input[data-search]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <h1 className="text-base font-semibold">typeful-triage</h1>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          j/k move · Enter open · Esc close · 1–6 category · / search
        </span>
        <div className="ml-auto flex items-center gap-4">
          <OnlineUsers selfId={session.user.userID} onOpenIssue={setSelectedId} />
          <span className="text-sm">{session.user.name}</span>
          <Button variant="ghost" size="sm" onClick={onLogout} aria-label="Sign out">
            <LogOut />
          </Button>
        </div>
      </header>
      <RepoBar
        repoId={repoId}
        onSelect={(id) => setStoredRepo({ repoId: id })}
        issueCount={rows.length}
        classifiedCount={rows.filter((r) => !r.unclassified).length}
      />
      <StatusStrip repoId={repoId} now={now} />
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <TabsList>
            <TabsTrigger value="triage">Triage</TabsTrigger>
            <TabsTrigger value="review">Review ({reviewRows.length})</TabsTrigger>
            <TabsTrigger value="stats">Stats</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          {(tab === "triage" || tab === "review") && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Input
                data-search
                className="w-56"
                placeholder="Search  /"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Select value={stateFilter} onValueChange={(v) => setStateFilter(v as StateFilter)}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">open</SelectItem>
                  <SelectItem value="closed">closed</SelectItem>
                  <SelectItem value="all">all</SelectItem>
                </SelectContent>
              </Select>
              {tab === "triage" && (
                <>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">all categories</SelectItem>
                      <SelectItem value="unclassified">unclassified</SelectItem>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Switch checked={reviewOnly} onCheckedChange={setReviewOnly} /> review only
                  </label>
                </>
              )}
            </div>
          )}
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-auto">
            <TabsContent value="triage" className="m-0">
              <IssueTable
                rows={filtered}
                users={userMap}
                now={now}
                sort={sort}
                onSort={onSort}
                onOpen={setSelectedId}
                selectedId={selectedId}
                numberToId={numberToId}
                loading={loading}
                emptyText={repoId ? "No issues match." : "Add a repo above to start."}
              />
            </TabsContent>
            <TabsContent value="review" className="m-0">
              <p className="px-4 pt-3 text-xs text-muted-foreground">
                Lowest confidence first: the model was unsure, a human disagreed, or a duplicate is
                suspected.
              </p>
              <IssueTable
                rows={reviewRows}
                users={userMap}
                now={now}
                sort={{ key: "confidence", dir: "asc" }}
                onSort={() => {}}
                onOpen={setSelectedId}
                selectedId={selectedId}
                numberToId={numberToId}
                loading={loading}
                emptyText="Review queue is empty."
              />
            </TabsContent>
            <TabsContent value="stats" className="m-0">
              <StatsPanel repoId={repoId} rows={rows} />
            </TabsContent>
            <TabsContent value="settings" className="m-0">
              <Settings
                repoId={repoId}
                weights={weights}
                setWeights={setWeights}
                visibleIssueIds={filtered.map((r) => r.issue.id)}
                now={now}
              />
            </TabsContent>
          </div>
          {selectedId && (tab === "triage" || tab === "review") && (
            <div className="w-[44%] min-w-[26rem] max-w-[44rem] shrink-0">
              <IssuePanel
                issueId={selectedId}
                questionsVersion={version}
                areaLabels={areaLabels}
                numberToId={numberToId}
                onClose={() => setSelectedId(null)}
                now={now}
              />
            </div>
          )}
        </div>
      </Tabs>
    </div>
  );
}
