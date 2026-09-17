import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { PullPanel } from "../components/PullPanel.tsx";
import { PullTable } from "../components/PullTable.tsx";
import { ReviewerBreakdown } from "../components/ReviewerBreakdown.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";
import {
  FILTER_TRIGGER,
  KeyHelp,
  LIST_KEYS,
  SearchBox,
  Segmented,
  Strip,
  TOGGLE,
  ViewHeader,
} from "../components/ViewHeader.tsx";
import { usePullRows } from "../lib/data.ts";
import { groupByReviewer, sortPulls, type PullSortKey } from "../lib/derive.ts";
import { useListKeys } from "../lib/keys.ts";
import { useNow } from "../lib/presence.ts";
import { pullsRoute } from "../router.tsx";

/** Open pull requests by attention, or grouped by suggested reviewer. */
export function PullsView() {
  const search = pullsRoute.useSearch();
  const { pullId } = useParams({ strict: false });
  const selectedId = pullId ?? null;
  const navigate = useNavigate();
  const repoId = search.repo ?? null;
  const now = useNow();
  const { repo, version, pullRows, reviewers, loading } = usePullRows(repoId, {
    state: search.state,
    search: search.q,
  });

  const filtered = useMemo(() => {
    const r = search.unsure ? pullRows.filter((x) => x.needsReview) : pullRows;
    return sortPulls(r, search.sort, search.dir);
  }, [pullRows, search.unsure, search.sort, search.dir]);
  const grouped = search.by === "reviewer";
  const groups = useMemo(
    () => (grouped ? groupByReviewer(filtered, search.mode) : null),
    [grouped, filtered, search.mode],
  );
  const groupInfo = useMemo(
    () =>
      new Map(reviewers.map((r) => [r.login, { approvals: r.approvals, open_load: r.open_load }])),
    [reviewers],
  );
  const ids = useMemo(
    () =>
      groups ? groups.flatMap((g) => g.rows.map((r) => r.pull.id)) : filtered.map((r) => r.pull.id),
    [groups, filtered],
  );

  const setSearch = useCallback(
    (patch: Partial<typeof search>) =>
      void navigate({ to: ".", search: (s) => ({ ...s, ...patch }), replace: true }),
    [navigate],
  );
  const select = useCallback(
    (id: string | null) => {
      if (id)
        void navigate({
          to: "/pulls/$pullId",
          params: { pullId: id },
          search: true,
          replace: true,
        });
      else void navigate({ to: "/pulls", search: true, replace: true });
    },
    [navigate],
  );
  const close = useCallback(() => select(null), [select]);
  useListKeys({ ids, selectedId, onSelect: select, onClose: close });
  const onSort = (key: PullSortKey) =>
    setSearch(
      search.sort === key
        ? { dir: search.dir === "asc" ? "desc" : "asc" }
        : { sort: key, dir: key === "number" || key === "reviewer" ? "asc" : "desc" },
    );

  return (
    <>
      <ViewHeader title="Pull requests" count={filtered.length}>
        <SearchBox
          value={search.q}
          onChange={(q) => setSearch({ q })}
          label="Search pull requests"
        />
        <Select
          value={search.state}
          onValueChange={(v) => setSearch({ state: v as typeof search.state })}
        >
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
        <button
          type="button"
          data-active={search.unsure || undefined}
          onClick={() => setSearch({ unsure: !search.unsure })}
          className={TOGGLE}
        >
          Unsure only
        </button>
        <KeyHelp rows={LIST_KEYS} />
      </ViewHeader>

      <div className="relative flex min-h-0 flex-1">
        <section className="@container min-w-0 flex-1 overflow-auto">
          <Strip>
            <span className="min-w-0 flex-1 truncate">
              {!grouped
                ? "Ordered by attention: approved and mergeable first, then awaiting review, then changes requested, drafts last."
                : search.mode === "balanced"
                  ? "Grouped by the load-balanced assignment: the model's distributions spread across people, a person's pick stays fixed."
                  : "Grouped by the model's first pick (or a person's), ignoring who already has work."}
            </span>
            <Segmented
              label="Layout"
              value={search.by}
              options={[
                ["list", "List"],
                ["reviewer", "By reviewer"],
              ]}
              onChange={(by) => setSearch({ by })}
            />
            {grouped && (
              <Segmented
                label="Reviewer suggestion"
                value={search.mode}
                options={[
                  ["balanced", "Balanced"],
                  ["model", "Model pick"],
                ]}
                onChange={(mode) => setSearch({ mode })}
              />
            )}
            <ReviewerBreakdown rows={filtered} roster={reviewers} />
          </Strip>
          <PullTable
            rows={filtered}
            groups={groups ?? undefined}
            groupInfo={groupInfo}
            reviewerMode={search.mode}
            now={now}
            sort={{ key: search.sort, dir: search.dir }}
            onSort={onSort}
            onOpen={select}
            selectedId={selectedId}
            loading={loading}
            emptyText={
              repoId
                ? repo?.pull_synced_at
                  ? "No pull requests match."
                  : "Pull requests sync after the newest issues; a GITHUB_TOKEN is required."
                : "Add a repository to start."
            }
          />
        </section>
        {selectedId && (
          <div className="w-[42%] max-w-2xl min-w-96 shrink-0 max-md:absolute max-md:inset-0 max-md:w-full max-md:max-w-none max-md:min-w-0">
            <PullPanel
              pullId={selectedId}
              questionsVersion={version}
              roster={reviewers}
              assigned={pullRows.find((r) => r.pull.id === selectedId)?.assigned ?? null}
              onClose={close}
              now={now}
            />
          </div>
        )}
      </div>
    </>
  );
}
