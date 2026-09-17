import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { IssuePanel } from "../components/IssuePanel.tsx";
import { IssueTable } from "../components/IssueTable.tsx";
import { ISSUE_KEYS, KeyHelp, SearchBox, Strip, ViewHeader } from "../components/ViewHeader.tsx";
import { useIssueRows, useUserMap } from "../lib/data.ts";
import { sortRows } from "../lib/derive.ts";
import { neighbourOf, scrollRowIntoView, useListKeys } from "../lib/keys.ts";
import { useNow } from "../lib/presence.ts";
import { rootRoute, unsureRoute } from "../router.tsx";

/** Where the model was unsure or a person disagreed, least confident first. */
export function UnsureView() {
  const { session } = rootRoute.useRouteContext();
  const search = unsureRoute.useSearch();
  const { issueId } = useParams({ strict: false });
  const selectedId = issueId ?? null;
  const navigate = useNavigate();
  const repoId = search.repo ?? null;
  const now = useNow();
  const users = useUserMap();
  const { repo, version, rows, loading, issuesByNumber } = useIssueRows(repoId, {
    state: "open",
    search: search.q,
  });
  const unsure = useMemo(
    () =>
      sortRows(
        rows.filter((r) => !r.done && r.needsReview),
        "confidence",
        "asc",
      ),
    [rows],
  );
  const ids = useMemo(() => unsure.map((r) => r.issue.id), [unsure]);
  const areaLabels = useMemo(() => (repo?.labels ?? []).map((l) => l.name).sort(), [repo?.labels]);

  const select = useCallback(
    (id: string | null) => {
      if (id)
        void navigate({
          to: "/unsure/$issueId",
          params: { issueId: id },
          search: true,
          replace: true,
        });
      else void navigate({ to: "/unsure", search: true, replace: true });
    },
    [navigate],
  );
  const close = useCallback(() => select(null), [select]);
  useListKeys({ ids, selectedId, onSelect: select, onClose: close });
  const advance = useCallback(() => {
    const next = neighbourOf(ids, selectedId);
    select(next);
    if (next) scrollRowIntoView(next);
  }, [ids, selectedId, select]);

  return (
    <>
      <ViewHeader title="Unsure" count={unsure.length}>
        <SearchBox
          value={search.q}
          onChange={(q) => void navigate({ to: ".", search: (s) => ({ ...s, q }), replace: true })}
          label="Search issues"
        />
        <KeyHelp rows={ISSUE_KEYS} />
      </ViewHeader>
      <div className="relative flex min-h-0 flex-1">
        <section className="@container min-w-0 flex-1 overflow-auto">
          <Strip>
            <span className="truncate">
              Where the model was unsure or a person disagreed with it, least confident first. A
              look from you here teaches the model the team's conventions.
            </span>
          </Strip>
          <IssueTable
            rows={unsure}
            users={users}
            now={now}
            sort={{ key: "confidence", dir: "asc" }}
            onSort={() => {}}
            onOpen={select}
            selectedId={selectedId}
            loading={loading}
            emptyText="Nothing the model is unsure about."
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
