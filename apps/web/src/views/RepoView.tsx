import { RepoPanel } from "../components/RepoPanel.tsx";
import { ViewHeader } from "../components/ViewHeader.tsx";
import { useIssueRows, usePullRows, useUserMap } from "../lib/data.ts";
import { rootRoute } from "../router.tsx";

export function RepoView() {
  const { repo: repoId = null } = rootRoute.useSearch();
  const users = useUserMap();
  const { rows } = useIssueRows(repoId, { state: "open", search: "" });
  const { pullRows, reviewers } = usePullRows(repoId, { state: "open", search: "" });
  return (
    <>
      <ViewHeader title="Repo" />
      <section className="min-w-0 flex-1 overflow-auto">
        <RepoPanel rows={rows} pullRows={pullRows} reviewers={reviewers} users={users} />
      </section>
    </>
  );
}
