import { CATEGORIES } from "@triage/schema";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CircleCheck, Hand } from "lucide-react";
import { useCallback, useMemo } from "react";
import { IssuePanel } from "../components/IssuePanel.tsx";
import { IssueTable } from "../components/IssueTable.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";
import {
  FILTER_TRIGGER,
  ISSUE_KEYS,
  KeyHelp,
  SearchBox,
  Segmented,
  Strip,
  TOGGLE,
  ViewHeader,
} from "../components/ViewHeader.tsx";
import { useIssueRows, useUserMap } from "../lib/data.ts";
import { groupByAction, sortRows, type SortKey } from "../lib/derive.ts";
import { neighbourOf, scrollRowIntoView, useListKeys } from "../lib/keys.ts";
import { useNow } from "../lib/presence.ts";
import { rootRoute, triageRoute } from "../router.tsx";

/** The queue, grouped by next step, with every filter in the URL. */
export function TriageView() {
  const { session } = rootRoute.useRouteContext();
  const search = triageRoute.useSearch();
  const { issueId } = useParams({ strict: false });
  const selectedId = issueId ?? null;
  const navigate = useNavigate();
  const repoId = search.repo ?? null;
  const now = useNow();
  const users = useUserMap();
  const { repo, version, rows, loading, issuesByNumber } = useIssueRows(repoId, {
    state: search.state,
    search: search.q,
  });

  const filtered = useMemo(() => {
    let r = search.done ? rows : rows.filter((x) => !x.done);
    if (search.mine) r = r.filter((x) => x.claimedBy === session.user.userID);
    if (search.cat !== "all")
      r = r.filter((x) =>
        search.cat === "unclassified" ? x.unclassified : x.category === search.cat,
      );
    return sortRows(r, search.sort, search.dir);
  }, [rows, search.done, search.mine, search.cat, search.sort, search.dir, session.user.userID]);
  const groups = useMemo(
    () => (search.group ? groupByAction(filtered) : null),
    [search.group, filtered],
  );
  const visibleIds = useMemo(
    () =>
      groups
        ? groups.flatMap((g) => g.rows.map((r) => r.issue.id))
        : filtered.map((r) => r.issue.id),
    [groups, filtered],
  );
  const areaLabels = useMemo(() => (repo?.labels ?? []).map((l) => l.name).sort(), [repo?.labels]);

  const setSearch = useCallback(
    (patch: Partial<typeof search>) =>
      void navigate({ to: ".", search: (s) => ({ ...s, ...patch }), replace: true }),
    [navigate],
  );
  const select = useCallback(
    (id: string | null) => {
      if (id)
        void navigate({
          to: "/triage/$issueId",
          params: { issueId: id },
          search: true,
          replace: true,
        });
      else void navigate({ to: "/triage", search: true, replace: true });
    },
    [navigate],
  );
  const close = useCallback(() => select(null), [select]);
  useListKeys({ ids: visibleIds, selectedId, onSelect: select, onClose: close });
  const advance = useCallback(() => {
    const next = neighbourOf(visibleIds, selectedId);
    select(next);
    if (next) scrollRowIntoView(next);
  }, [visibleIds, selectedId, select]);
  const onSort = (key: SortKey) =>
    setSearch(
      search.sort === key
        ? { dir: search.dir === "asc" ? "desc" : "asc" }
        : { sort: key, dir: key === "number" || key === "category" ? "asc" : "desc" },
    );

  return (
    <>
      <ViewHeader title="Triage" count={filtered.length}>
        <SearchBox value={search.q} onChange={(q) => setSearch({ q })} label="Search issues" />
        <Select
          value={search.state}
          onValueChange={(v) => setSearch({ state: v as typeof search.state })}
        >
          <SelectTrigger size="sm" className={FILTER_TRIGGER} aria-label="Issue state">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
        <Select value={search.cat} onValueChange={(cat) => setSearch({ cat })}>
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
          data-active={search.mine || undefined}
          onClick={() => setSearch({ mine: !search.mine })}
          className={TOGGLE}
          title="Only issues you claimed"
        >
          <Hand className="size-3.5" />
          Mine
        </button>
        <button
          type="button"
          data-active={search.done || undefined}
          onClick={() => setSearch({ done: !search.done })}
          className={TOGGLE}
          title="Include issues already marked triaged"
        >
          <CircleCheck className="size-3.5" />
          Done
        </button>
        <KeyHelp rows={ISSUE_KEYS} />
      </ViewHeader>

      <div className="relative flex min-h-0 flex-1">
        <section className="@container min-w-0 flex-1 overflow-auto">
          <Strip>
            <span className="min-w-0 flex-1 truncate">
              {search.group
                ? "Grouped by what a maintainer should do next. Mark an issue done to clear it from the queue."
                : "One list, sorted your way. Mark an issue done to clear it from the queue."}
            </span>
            <Segmented
              label="Layout"
              value={search.group ? "grouped" : "list"}
              options={[
                ["grouped", "By next step"],
                ["list", "List"],
              ]}
              onChange={(v) => setSearch({ group: v === "grouped" })}
            />
          </Strip>
          <IssueTable
            rows={filtered}
            groups={groups ?? undefined}
            users={users}
            now={now}
            sort={{ key: search.sort, dir: search.dir }}
            onSort={onSort}
            onOpen={select}
            selectedId={selectedId}
            loading={loading}
            emptyText={
              repoId
                ? search.mine
                  ? "You have not claimed anything."
                  : search.done
                    ? "No issues match."
                    : "Queue clear. Nothing left to triage."
                : "Add a repository to start."
            }
          />
        </section>
        {selectedId && (
          <div className="w-[42%] max-w-2xl min-w-96 shrink-0 max-md:absolute max-md:inset-0 max-md:w-full max-md:max-w-none max-md:min-w-0">
            <IssuePanel
              issueId={selectedId}
              questionsVersion={version}
              areaLabels={areaLabels}
              issuesByNumber={issuesByNumber}
              users={users}
              selfId={session.user.userID}
              onClose={close}
              onAdvance={advance}
              now={now}
            />
          </div>
        )}
      </div>
    </>
  );
}
