import { useQuery } from "@rocicorp/zero/react";
import { queries } from "@triage/schema";
import { useMemo } from "react";
import type { UserInfo } from "../components/IssueTable.tsx";
import { derivePulls, deriveRows } from "./derive.ts";
import { useWeights } from "./store.ts";

/**
 * Synced data as the views consume it. Zero dedupes identical queries, so the shell (for
 * sidebar counts) and a view (for its list) can both ask for the same rows at no extra cost.
 */

export function useRepos() {
  const [repos] = useQuery(queries.repos.all());
  return repos;
}

export function useRepo(repoId: string | null) {
  const [repo] = useQuery(repoId ? queries.repos.byId(repoId) : undefined);
  return repo ?? null;
}

export function useUserMap(): Map<string, UserInfo> {
  const [users] = useQuery(queries.users.all());
  return useMemo(
    () =>
      new Map(
        users.map((u) => [
          u.id,
          { id: u.id, name: u.name, color: u.color, avatarUrl: u.avatar_url ?? null },
        ]),
      ),
    [users],
  );
}

export function useIssueRows(
  repoId: string | null,
  filter: { state: "open" | "closed" | "all"; search: string },
) {
  const repo = useRepo(repoId);
  const [weights] = useWeights();
  const [issues, result] = useQuery(
    repoId
      ? queries.issues.byRepo({ repoId, state: filter.state, search: filter.search, limit: 500 })
      : undefined,
  );
  const version = repo?.questions_version ?? 1;
  const rows = useMemo(
    () => deriveRows(issues ?? [], version, weights),
    [issues, version, weights],
  );
  const loading = !!repoId && result?.type !== "complete" && (issues ?? []).length === 0;
  const issuesByNumber = useMemo(
    () => new Map((issues ?? []).map((i) => [i.number, { id: i.id, title: i.title }])),
    [issues],
  );
  return { repo, version, issues: issues ?? [], rows, loading, issuesByNumber };
}

export function usePullRows(
  repoId: string | null,
  filter: { state: "open" | "merged" | "closed" | "all"; search: string },
) {
  const repo = useRepo(repoId);
  const [pulls, result] = useQuery(
    repoId
      ? queries.pulls.byRepo({ repoId, state: filter.state, search: filter.search, limit: 500 })
      : undefined,
  );
  const [reviewers] = useQuery(repoId ? queries.reviewers.byRepo(repoId) : undefined);
  const version = repo?.questions_version ?? 1;
  const pullRows = useMemo(
    () => derivePulls(pulls ?? [], version, reviewers ?? []),
    [pulls, version, reviewers],
  );
  const loading = !!repoId && result?.type !== "complete" && (pulls ?? []).length === 0;
  return { repo, version, pullRows, reviewers: reviewers ?? [], loading };
}
