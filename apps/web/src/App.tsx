import { useQuery } from "@rocicorp/zero/react";
import { CATEGORIES, queries } from "@triage/schema";
import { cn } from "cn";
import { CircleCheck, Hand, Menu, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IssuePanel } from "./components/IssuePanel.tsx";
import { IssueTable, type UserInfo } from "./components/IssueTable.tsx";
import { PullPanel } from "./components/PullPanel.tsx";
import { PullTable } from "./components/PullTable.tsx";
import { RepoPanel } from "./components/RepoPanel.tsx";
import { ReviewerBreakdown } from "./components/ReviewerBreakdown.tsx";
import { Sidebar, type View } from "./components/Sidebar.tsx";
import { SystemPanel } from "./components/SystemPanel.tsx";
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
import {
  derivePulls,
  deriveRows,
  groupByAction,
  groupByReviewer,
  sortPulls,
  sortRows,
  type PullSortKey,
  type ReviewerMode,
  type SortKey,
} from "./lib/derive.ts";
import { useNow, usePresenceHeartbeat } from "./lib/presence.ts";
import { useLocalState, useWeights } from "./lib/store.ts";
import { useTheme } from "./lib/theme.ts";

type StateFilter = "open" | "closed" | "all";
type PullStateFilter = "open" | "merged" | "closed" | "all";

const VIEW_TITLE: Record<View, string> = {
  triage: "Triage",
  unsure: "Unsure",
  pulls: "Pull requests",
  repo: "Repo",
  system: "System",
};
const GO: Record<string, View> = {
  t: "triage",
  u: "unsure",
  p: "pulls",
  r: "repo",
  s: "system",
};
const FILTER_TRIGGER =
  "h-7 gap-1 border-transparent bg-transparent px-2 text-xs shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent";
const TOGGLE =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground data-active:bg-accent data-active:text-foreground";

/** Two-or-three way switch in the compact header style. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="inline-flex h-6 shrink-0 items-center rounded-md border p-0.5 text-xs"
      role="radiogroup"
      aria-label={label}
    >
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          data-active={value === v || undefined}
          onClick={() => onChange(v)}
          className="h-5 rounded-sm px-2 text-muted-foreground hover:text-foreground data-active:bg-accent data-active:text-foreground"
        >
          {text}
        </button>
      ))}
    </div>
  );
}

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
  const selfId = session.user.userID;
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
  const [pullState, setPullState] = useState<PullStateFilter>("open");
  const [pullSort, setPullSort] = useState<{ key: PullSortKey; dir: "asc" | "desc" }>({
    key: "priority",
    dir: "desc",
  });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [mine, setMine] = useState(false);
  const [showDone, setShowDone] = useState(false);
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
  const listView = view === "triage" || view === "unsure";
  const pullView = view === "pulls";
  const [triageLayout, setTriageLayout] = useLocalState<{ grouped: boolean }>(
    "typeful-triage.triage-layout",
    { grouped: true },
  );
  const [pullLayout, setPullLayout] = useLocalState<{ grouped: boolean; mode: ReviewerMode }>(
    "typeful-triage.pull-layout",
    { grouped: false, mode: "balanced" },
  );
  usePresenceHeartbeat(repoId, listView ? selectedId : null, onSessionRejected);

  const [issues, issuesResult] = useQuery(
    repoId ? queries.issues.byRepo({ repoId, state: stateFilter, search, limit: 500 }) : undefined,
  );
  const [pulls, pullsResult] = useQuery(
    repoId
      ? queries.pulls.byRepo({
          repoId,
          state: pullState,
          search: pullView ? search : "",
          limit: 500,
        })
      : undefined,
  );
  const [reviewers] = useQuery(repoId ? queries.reviewers.byRepo(repoId) : undefined);
  const version = repo?.questions_version ?? 1;
  const rows = useMemo(
    () => deriveRows(issues ?? [], version, weights),
    [issues, version, weights],
  );
  const pullRows = useMemo(
    () => derivePulls(pulls ?? [], version, reviewers ?? []),
    [pulls, version, reviewers],
  );
  const filteredPulls = useMemo(() => {
    const r = reviewOnly ? pullRows.filter((x) => x.needsReview) : pullRows;
    return sortPulls(r, pullSort.key, pullSort.dir);
  }, [pullRows, reviewOnly, pullSort]);
  const pullGroups = useMemo(
    () => (pullLayout.grouped ? groupByReviewer(filteredPulls, pullLayout.mode) : null),
    [pullLayout.grouped, filteredPulls, pullLayout.mode],
  );
  const groupInfo = useMemo(
    () =>
      new Map(
        (reviewers ?? []).map((r) => [r.login, { approvals: r.approvals, open_load: r.open_load }]),
      ),
    [reviewers],
  );
  const openPullCount = useMemo(
    () => pullRows.filter((r) => r.pull.state === "open").length,
    [pullRows],
  );
  // The queue: what nobody has marked done. Everything else is a filter on top of it.
  const queue = useMemo(() => rows.filter((r) => !r.done), [rows]);
  const filtered = useMemo(() => {
    let r = showDone ? rows : queue;
    if (mine) r = r.filter((x) => x.claimedBy === selfId);
    if (category !== "all")
      r = r.filter((x) => (category === "unclassified" ? x.unclassified : x.category === category));
    return sortRows(r, sort.key, sort.dir);
  }, [rows, queue, showDone, mine, selfId, category, sort]);
  const triageGroups = useMemo(
    () => (view === "triage" && triageLayout.grouped ? groupByAction(filtered) : null),
    [view, triageLayout.grouped, filtered],
  );
  const unsureRows = useMemo(
    () =>
      sortRows(
        queue.filter((r) => r.needsReview),
        "confidence",
        "asc",
      ),
    [queue],
  );
  const userMap = useMemo(
    () =>
      new Map(
        users.map((u) => [u.id, { id: u.id, name: u.name, color: u.color } satisfies UserInfo]),
      ),
    [users],
  );
  const issuesByNumber = useMemo(
    () => new Map((issues ?? []).map((i) => [i.number, { id: i.id, title: i.title }])),
    [issues],
  );
  const areaLabels = useMemo(() => (repo?.labels ?? []).map((l) => l.name).sort(), [repo?.labels]);
  const visible = view === "unsure" ? unsureRows : filtered;
  // What j/k walk through, in display order. Decided by the view first: the pull grouping
  // is a persisted preference and must not leak pull ids into the issue views.
  const visibleIds = useMemo(() => {
    if (pullView)
      return pullGroups
        ? pullGroups.flatMap((g) => g.rows.map((r) => r.pull.id))
        : filteredPulls.map((r) => r.pull.id);
    if (triageGroups) return triageGroups.flatMap((g) => g.rows.map((r) => r.issue.id));
    return visible.map((r) => r.issue.id);
  }, [pullGroups, pullView, filteredPulls, triageGroups, visible]);
  const loading = !!repoId && issuesResult?.type !== "complete" && (issues ?? []).length === 0;
  const pullsLoading = !!repoId && pullsResult?.type !== "complete" && (pulls ?? []).length === 0;
  const busy = repo?.sync_status === "running" || !!repo?.workerState?.in_flight;

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "number" || key === "category" ? "asc" : "desc" },
    );
  const onPullSort = (key: PullSortKey) =>
    setPullSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "number" || key === "reviewer" ? "asc" : "desc" },
    );
  const changeView = useCallback((v: View) => {
    setView((prev) => {
      if ((prev === "pulls") !== (v === "pulls")) setSelectedId(null);
      return v;
    });
    setNavOpen(false);
  }, []);
  const openIssue = useCallback((id: string) => {
    setSelectedId(id);
    setView((v) => (v === "triage" || v === "unsure" ? v : "triage"));
    setNavOpen(false);
  }, []);

  // Keyboard: j/k move, Esc closes, / searches, g+t/u/p/r/s switches views. The panel handles the rest.
  const move = useCallback(
    (delta: number) => {
      if (visibleIds.length === 0) return;
      const idx = visibleIds.indexOf(selectedId ?? "");
      const next =
        idx < 0
          ? delta > 0
            ? 0
            : visibleIds.length - 1
          : Math.min(visibleIds.length - 1, Math.max(0, idx + delta));
      const id = visibleIds[next]!;
      setSelectedId(id);
      document
        .querySelector(`[data-issue-id="${id}"], [data-pull-id="${id}"]`)
        ?.scrollIntoView({ block: "nearest" });
    },
    [visibleIds, selectedId],
  );
  /** After an issue leaves the queue, select its neighbour so the flow continues. */
  const advance = useCallback(() => {
    const idx = visibleIds.indexOf(selectedId ?? "");
    if (idx < 0) return;
    const next = visibleIds[idx + 1] ?? visibleIds[idx - 1] ?? null;
    setSelectedId(next);
    if (next)
      document.querySelector(`[data-issue-id="${next}"]`)?.scrollIntoView({ block: "nearest" });
  }, [visibleIds, selectedId]);
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
      counts={{ triage: queue.length, unsure: unsureRows.length, pulls: openPullCount }}
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
          {(listView || pullView) && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {pullView ? filteredPulls.length : visible.length}
            </span>
          )}
          <span className="flex-1" />
          {(listView || pullView) && (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  data-search
                  className="h-7 w-44 border-transparent bg-transparent pl-7 text-xs shadow-none hover:bg-accent focus-visible:border-input focus-visible:bg-background focus-visible:ring-0 dark:bg-transparent"
                  placeholder="Search"
                  aria-label={pullView ? "Search pull requests" : "Search issues"}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {pullView ? (
                <Select value={pullState} onValueChange={(v) => setPullState(v as PullStateFilter)}>
                  <SelectTrigger size="sm" className={FILTER_TRIGGER} aria-label="Pull state">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="merged">Merged</SelectItem>
                    <SelectItem value="closed">Closed</SelectItem>
                    <SelectItem value="all">All</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
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
              )}
              {pullView && (
                <button
                  type="button"
                  data-active={reviewOnly || undefined}
                  onClick={() => setReviewOnly((v) => !v)}
                  className={TOGGLE}
                >
                  Unsure only
                </button>
              )}
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
                    data-active={mine || undefined}
                    onClick={() => setMine((v) => !v)}
                    className={TOGGLE}
                    title="Only issues you claimed"
                  >
                    <Hand className="size-3.5" />
                    Mine
                  </button>
                  <button
                    type="button"
                    data-active={showDone || undefined}
                    onClick={() => setShowDone((v) => !v)}
                    className={TOGGLE}
                    title="Include issues already marked triaged"
                  >
                    <CircleCheck className="size-3.5" />
                    Done
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
                    <span>a</span>
                    <span>looks right, done</span>
                    <span>c</span>
                    <span>claim / release</span>
                    <span>x</span>
                    <span>done / reopen</span>
                    <span>1–6</span>
                    <span>set category</span>
                    <span>/</span>
                    <span>search</span>
                    <span>g then t u p r s</span>
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
              <>
                <div className="sticky top-0 z-20 flex h-8 items-center gap-2 border-b bg-background px-4 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">
                    {triageLayout.grouped
                      ? "Grouped by what a maintainer should do next. Mark an issue done to clear it from the queue."
                      : "One list, sorted your way. Mark an issue done to clear it from the queue."}
                  </span>
                  <Segmented
                    label="Layout"
                    value={triageLayout.grouped ? "grouped" : "list"}
                    options={[
                      ["grouped", "By next step"],
                      ["list", "List"],
                    ]}
                    onChange={(v) => setTriageLayout({ grouped: v === "grouped" })}
                  />
                </div>
                <IssueTable
                  rows={filtered}
                  groups={triageGroups ?? undefined}
                  users={userMap}
                  now={now}
                  sort={sort}
                  onSort={onSort}
                  onOpen={setSelectedId}
                  selectedId={selectedId}
                  loading={loading}
                  emptyText={
                    repoId
                      ? mine
                        ? "You have not claimed anything."
                        : showDone
                          ? "No issues match."
                          : "Queue clear. Nothing left to triage."
                      : "Add a repository to start."
                  }
                />
              </>
            )}
            {view === "unsure" && (
              <>
                <div className="sticky top-0 z-20 flex h-8 items-center border-b bg-background px-4 text-xs text-muted-foreground">
                  <span className="truncate">
                    Where the model was unsure or a person disagreed with it, least confident first.
                    A look from you here teaches the model the team's conventions.
                  </span>
                </div>
                <IssueTable
                  rows={unsureRows}
                  users={userMap}
                  now={now}
                  sort={{ key: "confidence", dir: "asc" }}
                  onSort={() => {}}
                  onOpen={setSelectedId}
                  selectedId={selectedId}
                  loading={loading}
                  emptyText="Nothing the model is unsure about."
                />
              </>
            )}
            {view === "pulls" && (
              <>
                <div className="sticky top-0 z-20 flex h-8 items-center gap-2 border-b bg-background px-4 text-xs text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">
                    {!pullLayout.grouped
                      ? "Ordered by attention: approved and mergeable first, then awaiting review, then changes requested, drafts last."
                      : pullLayout.mode === "balanced"
                        ? "Grouped by the load-balanced assignment: the model's distributions spread across people, a person's pick stays fixed."
                        : "Grouped by the model's first pick (or a person's), ignoring who already has work."}
                  </span>
                  <Segmented
                    label="Layout"
                    value={pullLayout.grouped ? "grouped" : "list"}
                    options={[
                      ["list", "List"],
                      ["grouped", "By reviewer"],
                    ]}
                    onChange={(v) => setPullLayout({ ...pullLayout, grouped: v === "grouped" })}
                  />
                  {pullLayout.grouped && (
                    <Segmented
                      label="Reviewer suggestion"
                      value={pullLayout.mode}
                      options={[
                        ["balanced", "Balanced"],
                        ["model", "Model pick"],
                      ]}
                      onChange={(v) => setPullLayout({ ...pullLayout, mode: v as ReviewerMode })}
                    />
                  )}
                  <ReviewerBreakdown rows={filteredPulls} roster={reviewers ?? []} />
                </div>
                <PullTable
                  rows={filteredPulls}
                  groups={pullGroups ?? undefined}
                  groupInfo={groupInfo}
                  reviewerMode={pullLayout.mode}
                  users={userMap}
                  now={now}
                  sort={pullSort}
                  onSort={onPullSort}
                  onOpen={setSelectedId}
                  selectedId={selectedId}
                  loading={pullsLoading}
                  emptyText={
                    repoId
                      ? repo?.pull_synced_at
                        ? "No pull requests match."
                        : "Pull requests sync after the newest issues; a GITHUB_TOKEN is required."
                      : "Add a repository to start."
                  }
                />
              </>
            )}
            {view === "repo" && (
              <RepoPanel
                rows={rows}
                pullRows={pullRows}
                reviewers={reviewers ?? []}
                users={userMap}
              />
            )}
            {view === "system" && (
              <SystemPanel
                session={session}
                repoId={repoId}
                rows={rows}
                weights={weights}
                setWeights={setWeights}
                visibleIssueIds={filtered.map((r) => r.issue.id)}
                now={now}
              />
            )}
          </section>
          {selectedId && (listView || pullView) && (
            <div className="w-[42%] max-w-2xl min-w-96 shrink-0 max-md:absolute max-md:inset-0 max-md:w-full max-md:max-w-none max-md:min-w-0">
              {pullView ? (
                <PullPanel
                  pullId={selectedId}
                  questionsVersion={version}
                  roster={reviewers ?? []}
                  assigned={pullRows.find((r) => r.pull.id === selectedId)?.assigned ?? null}
                  onClose={() => setSelectedId(null)}
                  now={now}
                />
              ) : (
                <IssuePanel
                  issueId={selectedId}
                  questionsVersion={version}
                  areaLabels={areaLabels}
                  issuesByNumber={issuesByNumber}
                  users={userMap}
                  selfId={selfId}
                  onClose={() => setSelectedId(null)}
                  onAdvance={advance}
                  now={now}
                />
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
