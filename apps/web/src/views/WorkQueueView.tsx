import { useQuery, useZero } from "@rocicorp/zero/react";
import { useNavigate } from "@tanstack/react-router";
import { mutators, queries } from "@triage/schema";
import { cn } from "cn";
import { ArrowRight, Check, CircleDot, Clock, GitPullRequest } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IssuePanel } from "../components/IssuePanel.tsx";
import { PullPanel } from "../components/PullPanel.tsx";
import { Button } from "../components/ui/button.tsx";
import { Segmented, ViewHeader } from "../components/ViewHeader.tsx";
import type { Session } from "../lib/auth.ts";
import { useRepo, useUserMap } from "../lib/data.ts";
import { derivePulls, deriveRows } from "../lib/derive.ts";
import { scrollRowIntoView, useListKeys } from "../lib/keys.ts";
import { useNow } from "../lib/presence.ts";
import { useWeights } from "../lib/store.ts";
import { buildWorkQueue, type WorkItem } from "../lib/work-queue.ts";
import { rootRoute, workRoute } from "../router.tsx";

export function WorkQueueView() {
  const { session } = rootRoute.useRouteContext();
  const search = workRoute.useSearch();
  // Reset local error and pending state when changing repositories.
  return <Queue key={search.repo ?? ""} session={session} />;
}

function Queue({ session }: { session: Session }) {
  const search = workRoute.useSearch();
  const navigate = useNavigate();
  const z = useZero();
  const repoId = search.repo ?? null;
  const repo = useRepo(repoId);
  const [data, result] = useQuery(repoId ? queries.workQueue.byRepo(repoId) : undefined);
  const [states, stateResult] = useQuery(repoId ? queries.workQueue.state(repoId) : undefined);
  const [weights] = useWeights();
  const now = useNow();
  const users = useUserMap();
  const version = data?.questions_version ?? 1;
  const issues = useMemo(
    () => deriveRows(data?.issues ?? [], version, weights),
    [data, version, weights],
  );
  const pulls = useMemo(
    () => derivePulls(data?.pulls ?? [], version, data?.reviewers ?? []),
    [data, version],
  );
  const items = useMemo(
    () => buildWorkQueue(issues, pulls, session.user, states ?? [], now),
    [issues, pulls, session.user, states, now],
  );
  const visible = items.filter((i) => i.status === search.bucket);
  const selected =
    search.item === "" ? undefined : (visible.find((i) => i.key === search.item) ?? visible[0]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const loading =
    !!repoId && ((!data && result.type !== "complete") || stateResult.type !== "complete");
  const select = useCallback(
    (item: string) => {
      if (item) scrollRowIntoView(item);
      void navigate({ to: "/work", search: (s) => ({ ...s, item }), replace: true });
    },
    [navigate],
  );
  const close = useCallback(() => select(""), [select]);
  // Pin the current item: live priority changes must not swap out what someone is reading.
  useEffect(() => {
    if (!loading && selected && selected.key !== search.item) select(selected.key);
  }, [loading, selected, search.item, select]);
  const advance = () => {
    const index = visible.findIndex((i) => i.key === selected?.key);
    select(visible[index + 1]?.key ?? visible[0]?.key ?? "");
  };
  useListKeys({
    ids: visible.map((i) => i.key),
    selectedId: selected?.key ?? null,
    onSelect: select,
    onClose: close,
  });

  async function disposition(item: WorkItem, status: WorkItem["status"]) {
    if (!repoId || pending || loading) return;
    setPending(true);
    setError(null);
    try {
      const result = await z.mutate(
        mutators.workQueue.set({
          repoId,
          subjectKind: item.kind,
          subjectId: item.id,
          subjectUpdatedAt: item.updatedAt,
          status,
        }),
      ).server;
      if (result.type === "error") throw new Error(result.error.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your queue. Try again.");
    } finally {
      setPending(false);
    }
  }

  const issuesByNumber = new Map(
    (data?.issues ?? []).map((i) => [i.number, { id: i.id, title: i.title }]),
  );
  return (
    <>
      <ViewHeader title="Work queue" count={items.filter((i) => i.status === "ready").length}>
        <span className="text-xs text-muted-foreground max-sm:hidden">
          For @{session.user.login}
        </span>
      </ViewHeader>
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
        <Segmented
          label="Queue status"
          value={search.bucket}
          options={[
            ["ready", "Ready"],
            ["snoozed", "Snoozed"],
            ["handled", "Handled"],
          ]}
          onChange={(bucket) =>
            void navigate({
              to: "/work",
              search: (s) => ({ ...s, bucket, item: undefined }),
              replace: true,
            })
          }
        />
        <p className="text-xs text-muted-foreground">
          Urgent first, then your work, then where you can help.
        </p>
      </div>
      {error && (
        <p role="alert" className="border-b px-4 py-2 text-destructive">
          {error}
        </p>
      )}
      <div className="relative flex min-h-0 flex-1">
        <section
          aria-label="Work items"
          className={cn("overflow-y-auto", selected ? "w-80 shrink-0 max-md:hidden" : "flex-1")}
        >
          <div className="border-b px-4 py-3 text-xs text-muted-foreground">
            {loading
              ? "Loading your queue…"
              : `${visible.length} ${search.bucket === "ready" ? "up next" : search.bucket}`}{" "}
            · j / k to move
          </div>
          {!loading && visible.length === 0 && (
            <div className="p-8 text-muted-foreground">
              <h2 className="mb-2 font-medium text-foreground">
                {!repoId
                  ? "Pick a repository to begin"
                  : search.bucket === "ready"
                    ? "Nothing needs your attention right now"
                    : `No ${search.bucket} work`}
              </h2>
              <p>
                {repoId
                  ? "Waiting work, other people's claims and closed items stay out of this queue. Use Triage or Pull requests to browse everything."
                  : "Add a repository from the sidebar to build your queue."}
              </p>
            </div>
          )}
          {visible.map((item) => (
            <button
              key={item.key}
              type="button"
              data-issue-id={item.kind === "issue" ? item.key : undefined}
              data-pull-id={item.kind === "pull" ? item.key : undefined}
              aria-current={item.key === selected?.key ? "true" : undefined}
              onClick={() => select(item.key)}
              className={cn(
                "flex w-full gap-3 border-b px-4 py-4 text-left hover:bg-accent/50",
                item.key === selected?.key && "bg-accent",
              )}
            >
              {item.kind === "pull" ? (
                <GitPullRequest className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              ) : (
                <CircleDot className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0">
                <span className="mb-1 block text-xs text-muted-foreground">
                  {item.kind === "pull" ? "PR" : "Issue"} #{item.number}
                </span>
                <span className="block font-medium">{item.title}</span>
                <span className="mt-2 block text-xs text-primary">{item.action}</span>
                <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                  {item.reason}
                </span>
              </span>
            </button>
          ))}
        </section>
        {selected && (
          <section
            aria-label="Current work item"
            className="flex min-w-0 flex-1 flex-col border-l max-md:border-l-0"
          >
            <div className="shrink-0 border-b px-5 py-4">
              <div className="mb-1 text-xs text-muted-foreground">Suggested next step</div>
              <h2 className="font-medium">{selected.action}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{selected.reason}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {search.bucket === "ready" ? (
                  <>
                    <Button
                      size="sm"
                      disabled={pending || loading}
                      onClick={() => void disposition(selected, "handled")}
                    >
                      <Check /> Handled
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || loading}
                      onClick={() => void disposition(selected, "snoozed")}
                    >
                      <Clock /> Snooze 1 day
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    disabled={pending || loading}
                    onClick={() => void disposition(selected, "ready")}
                  >
                    Return to queue
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={visible.length < 2} onClick={advance}>
                  Next <ArrowRight />
                </Button>
                <Button size="sm" variant="ghost" className="md:hidden" onClick={close}>
                  Show queue
                </Button>
              </div>
              <p className="mt-2 text-2xs text-muted-foreground">
                Personal queue only. Reply, approve and merge on GitHub. Handled work returns after
                a GitHub update.
              </p>
            </div>
            <div className="min-h-0 flex-1">
              {selected.kind === "issue" ? (
                <IssuePanel
                  key={selected.key}
                  issueId={selected.id}
                  questionsVersion={version}
                  areaLabels={(repo?.labels ?? []).map((l) => l.name)}
                  issuesByNumber={issuesByNumber}
                  users={users}
                  selfId={session.user.userID}
                  handoffStep={selected}
                  onClose={close}
                  onAdvance={advance}
                  now={now}
                />
              ) : (
                <PullPanel
                  key={selected.key}
                  pullId={selected.id}
                  questionsVersion={version}
                  roster={data?.reviewers ?? []}
                  assigned={pulls.find((p) => p.pull.id === selected.id)?.assigned ?? null}
                  session={session}
                  handoffStep={selected}
                  hasReviewDefault={!!repo?.review_provider_id && !!repo?.review_model}
                  onClose={close}
                  now={now}
                />
              )}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
