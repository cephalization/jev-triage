import { useMemo } from "react";
import { SystemPanel } from "../components/SystemPanel.tsx";
import { ViewHeader } from "../components/ViewHeader.tsx";
import { useIssueRows } from "../lib/data.ts";
import { useNow } from "../lib/presence.ts";
import { useWeights } from "../lib/store.ts";
import { rootRoute } from "../router.tsx";

export function SystemView() {
  const { session } = rootRoute.useRouteContext();
  const { repo: repoId = null } = rootRoute.useSearch();
  const [weights, setWeights] = useWeights();
  const now = useNow();
  const { rows } = useIssueRows(repoId, { state: "open", search: "" });
  const queueIds = useMemo(() => rows.filter((r) => !r.done).map((r) => r.issue.id), [rows]);
  return (
    <>
      <ViewHeader title="System" />
      <section className="min-w-0 flex-1 overflow-auto">
        <SystemPanel
          session={session}
          repoId={repoId}
          rows={rows}
          weights={weights}
          setWeights={setWeights}
          visibleIssueIds={queueIds}
          now={now}
        />
      </section>
    </>
  );
}
