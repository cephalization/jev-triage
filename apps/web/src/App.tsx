import { useQuery } from "@rocicorp/zero/react";
import { CATEGORIES, queries } from "@triage/schema";
import { LogOut } from "lucide-react";
import { useMemo, useState } from "react";
import { IssueDrawer } from "./components/IssueDrawer.tsx";
import { IssueTable, type UserInfo } from "./components/IssueTable.tsx";
import { OnlineUsers } from "./components/Presence.tsx";
import { RepoBar } from "./components/RepoBar.tsx";
import { Settings } from "./components/Settings.tsx";
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
import { Switch } from "./components/ui/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.tsx";
import type { Session } from "./lib/auth.ts";
import { deriveRows, sortRows, type SortKey } from "./lib/derive.ts";
import { useNow, usePresenceHeartbeat } from "./lib/presence.ts";
import { useLocalState, useWeights } from "./lib/store.ts";

type StateFilter = "open" | "closed" | "all";

export function App({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [repos] = useQuery(queries.repos.all());
  const [{ repoId: storedRepo }, setStoredRepo] = useLocalState<{ repoId: string | null }>(
    "typeful-triage.repo",
    { repoId: null },
  );
  const repoId =
    storedRepo && repos.some((r) => r.id === storedRepo) ? storedRepo : (repos[0]?.id ?? null);
  const [repo] = useQuery(repoId ? queries.repos.byId(repoId) : undefined);
  const [users] = useQuery(queries.users.all());
  const [stateFilter, setStateFilter] = useState<StateFilter>("open");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "priority",
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

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "number" || key === "category" ? "asc" : "desc" },
    );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center gap-4 border-b px-4 py-2">
        <h1 className="text-base font-semibold">typeful-triage</h1>
        <span className="text-xs text-muted-foreground">
          {issuesResult?.type === "complete" ? "synced" : "syncing…"}
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
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <TabsList>
            <TabsTrigger value="triage">Triage</TabsTrigger>
            <TabsTrigger value="review">Review queue ({reviewRows.length})</TabsTrigger>
            <TabsTrigger value="stats">Stats</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          {(tab === "triage" || tab === "review") && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Input
                className="w-56"
                placeholder="Search title or body (server-side ILIKE)"
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
        <TabsContent value="triage" className="min-h-0 flex-1 overflow-auto">
          <IssueTable
            rows={filtered}
            users={userMap}
            now={now}
            sort={sort}
            onSort={onSort}
            onOpen={setSelectedId}
            selectedId={selectedId}
            numberToId={numberToId}
          />
        </TabsContent>
        <TabsContent value="review" className="min-h-0 flex-1 overflow-auto">
          <p className="px-4 pt-3 text-xs text-muted-foreground">
            Lowest confidence first. Items land here when the model is unsure, when a human
            disagreed, or when a duplicate is suspected.
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
          />
        </TabsContent>
        <TabsContent value="stats">
          <StatsPanel repoId={repoId} rows={rows} />
        </TabsContent>
        <TabsContent value="settings">
          <Settings
            repoId={repoId}
            weights={weights}
            setWeights={setWeights}
            visibleIssueIds={filtered.map((r) => r.issue.id)}
            now={now}
          />
        </TabsContent>
      </Tabs>
      <IssueDrawer
        issueId={selectedId}
        questionsVersion={version}
        areaLabels={areaLabels}
        numberToId={numberToId}
        onClose={() => setSelectedId(null)}
        now={now}
      />
    </div>
  );
}
