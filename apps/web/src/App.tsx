import { useQuery } from "@rocicorp/zero/react";
import { CATEGORIES, queries } from "@triage/schema";
import { cn } from "cn";
import { ListFilter, Menu, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IssuePanel } from "./components/IssuePanel.tsx";
import { IssueTable, type UserInfo } from "./components/IssueTable.tsx";
import { Settings } from "./components/Settings.tsx";
import { Sidebar, type View } from "./components/Sidebar.tsx";
import { StatsPanel } from "./components/StatsPanel.tsx";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { Sheet, SheetContent, SheetTitle } from "./components/ui/sheet.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.tsx";
import type { Session } from "./lib/auth.ts";
import { deriveRows, sortRows, type SortKey } from "./lib/derive.ts";
import { useNow, usePresenceHeartbeat } from "./lib/presence.ts";
import { useLocalState, useWeights } from "./lib/store.ts";
import { useTheme } from "./lib/theme.ts";

type StateFilter = "open" | "closed" | "all";

const VIEW_TITLE: Record<View, string> = {
  triage: "Triage",
  review: "Review",
  stats: "Stats",
  settings: "Settings",
};
const GO: Record<string, View> = { t: "triage", r: "review", s: "stats", ",": "settings" };
const FILTER_TRIGGER =
  "h-7 gap-1 border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent";

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

export function App({
  session,
  onLogout,
  onSessionRejected,
}: {
  session: Session;
  onLogout: () => void;
  /** A server-rejected write: re-verify the token and sign out if it is dead. */
  onSessionRejected: (error: unknown) => void;
}) {
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
  const [view, setView] = useState<View>("triage");
  const [navOpen, setNavOpen] = useState(false);
  const [weights, setWeights] = useWeights();
  const [theme, setTheme] = useTheme();
  const now = useNow();
  usePresenceHeartbeat(repoId, selectedId, onSessionRejected);

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
  const listView = view === "triage" || view === "review";
  const visible = view === "review" ? reviewRows : filtered;
  const loading = !!repoId && issuesResult?.type !== "complete" && (issues ?? []).length === 0;
  const busy = repo?.sync_status === "running" || !!repo?.workerState?.in_flight;

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "number" || key === "category" ? "asc" : "desc" },
    );
  const changeView = useCallback((v: View) => {
    setView(v);
    setNavOpen(false);
  }, []);
  const openIssue = useCallback((id: string) => {
    setSelectedId(id);
    setView((v) => (v === "triage" || v === "review" ? v : "triage"));
    setNavOpen(false);
  }, []);

  // Keyboard: j/k move, Esc closes, / searches, g+t/r/s/, switches views. The panel handles 1–6.
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
  const chord = useRef<number>(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        (document.activeElement as HTMLElement | null)?.blur();
        setSelectedId(null);
        return;
      }
      if (isTyping(e)) return;
      const chorded = Date.now() - chord.current < 800;
      chord.current = 0;
      if (chorded && GO[e.key]) {
        e.preventDefault();
        changeView(GO[e.key]!);
      } else if (e.key === "g") {
        chord.current = Date.now();
      } else if (e.key === "j" || e.key === "ArrowDown") {
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
  }, [move, changeView]);

  const sidebar = (
    <Sidebar
      session={session}
      repoId={repoId}
      onSelectRepo={(id) => setStoredRepo({ repoId: id })}
      view={view}
      onView={changeView}
      counts={{ triage: rows.length, review: reviewRows.length }}
      onOpenIssue={openIssue}
      onLogout={onLogout}
      theme={theme}
      setTheme={setTheme}
      now={now}
    />
  );

  return (
    <div className="isolate flex h-dvh overflow-hidden bg-background text-sm text-foreground antialiased">
      <aside className="w-60 shrink-0 border-r border-sidebar-border max-lg:hidden">
        {sidebar}
      </aside>
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="w-64 p-0 pt-8">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden transition-opacity",
            busy ? "opacity-100" : "opacity-0",
          )}
          aria-hidden="true"
        >
          <div className="h-full w-1/3 animate-[indeterminate_1.2s_ease-in-out_infinite] bg-primary" />
        </div>
        <header className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
          <Button
            variant="ghost"
            size="icon-xs"
            className="lg:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
          >
            <Menu />
          </Button>
          <h1 className="pl-1 font-medium">{VIEW_TITLE[view]}</h1>
          {listView && (
            <span className="text-xs text-muted-foreground tabular-nums">{visible.length}</span>
          )}
          <span className="flex-1" />
          {listView && (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  data-search
                  className="h-7 w-44 border-transparent bg-transparent pl-7 text-xs shadow-none hover:bg-accent focus-visible:border-input focus-visible:bg-background focus-visible:ring-0 dark:bg-transparent"
                  placeholder="Search"
                  aria-label="Search issues"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Select value={stateFilter} onValueChange={(v) => setStateFilter(v as StateFilter)}>
                <SelectTrigger size="sm" className={FILTER_TRIGGER} aria-label="Issue state">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                  <SelectItem value="all">All</SelectItem>
                </SelectContent>
              </Select>
              {view === "triage" && (
                <>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger size="sm" className={FILTER_TRIGGER} aria-label="Category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="all">All categories</SelectItem>
                      <SelectItem value="unclassified">Unclassified</SelectItem>
                      {CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    data-active={reviewOnly || undefined}
                    onClick={() => setReviewOnly((v) => !v)}
                    className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground data-active:bg-accent data-active:text-foreground"
                  >
                    <ListFilter className="size-3.5" />
                    Needs review
                  </button>
                </>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="kbd ml-1 cursor-default" tabIndex={0}>
                    ?
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end" className="text-left">
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                    <span>j / k</span>
                    <span>move</span>
                    <span>Esc</span>
                    <span>close</span>
                    <span>1–6</span>
                    <span>set category</span>
                    <span>/</span>
                    <span>search</span>
                    <span>g then t r s ,</span>
                    <span>switch view</span>
                  </div>
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </header>

        <div className="relative flex min-h-0 flex-1">
          <section className="@container min-w-0 flex-1 overflow-auto">
            {view === "triage" && (
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
                emptyText={repoId ? "No issues match." : "Add a repository to start."}
              />
            )}
            {view === "review" && (
              <>
                <p className="border-b px-4 py-2 text-xs text-muted-foreground">
                  Lowest confidence first: the model was unsure, a person disagreed, or a duplicate
                  is suspected.
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
                  emptyText="Nothing to review."
                />
              </>
            )}
            {view === "stats" && <StatsPanel repoId={repoId} rows={rows} />}
            {view === "settings" && (
              <Settings
                repoId={repoId}
                weights={weights}
                setWeights={setWeights}
                visibleIssueIds={filtered.map((r) => r.issue.id)}
                now={now}
              />
            )}
          </section>
          {selectedId && listView && (
            <div className="w-[42%] max-w-2xl min-w-96 shrink-0 max-md:absolute max-md:inset-0 max-md:w-full max-md:max-w-none max-md:min-w-0">
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
      </main>
    </div>
  );
}
