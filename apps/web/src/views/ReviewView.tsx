import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { mutators, queries } from "@triage/schema";
import { splitPatch } from "@triage/triage/review";
import { cn } from "cn";
import { ArrowLeft, Check, ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AvatarStack } from "../components/Avatar.tsx";
import { collapseReason, Counts, DiffFile, FileName, splitPath } from "../components/DiffFile.tsx";
import { SectionLabel, Tag } from "../components/Marks.tsx";
import { Button } from "../components/ui/button.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { KeyHelp, ViewHeader } from "../components/ViewHeader.tsx";
import { isStale } from "../components/GuidedReview.tsx";
import { fetchReviewPatch, generateGuidedReview } from "../lib/api.ts";
import { ago, compact, reviewPhaseText } from "../lib/format.ts";
import { isTyping } from "../lib/keys.ts";
import { useNow } from "../lib/presence.ts";
import { reviewRoute, rootRoute } from "../router.tsx";

/**
 * The guided review of one pull request: a rail of ordered steps on the left, that step's
 * diffs on the right. The review is shared (one generation, everyone reads the same steps);
 * the checkmarks are personal, and the rail shows who has finished what.
 */

const REVIEW_KEYS = [
  ["] / n", "next step"],
  ["[ / p", "previous step"],
  ["m", "mark reviewed, advance"],
  ["Esc", "back to the pull request"],
] as const;

const ROLE_NAMES: Record<string, string> = {
  core: "core",
  supporting: "adopts the change",
  tests: "tests",
  docs: "docs",
  config: "config",
  generated: "generated",
  formatting: "formatting",
};

interface Step {
  name: string;
  summary: string;
  files: string[];
  /** The synthetic "changed since generation" step cannot be marked. */
  markable: boolean;
}

export function ReviewView() {
  const { session } = rootRoute.useRouteContext();
  const { pullId } = reviewRoute.useParams();
  const search = reviewRoute.useSearch();
  const navigate = reviewRoute.useNavigate();
  const z = useZero();
  const now = useNow();
  const [pull, result] = useQuery(queries.guidedReviews.byPull(pullId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reviews = pull?.guidedReviews ?? [];
  const latest = reviews[0] ?? null;
  const running = latest?.status === "queued" || latest?.status === "running";
  // The newest ready review, or the skeleton of a first run once its steps are named.
  const ready = useMemo(() => {
    const done = reviews.find((r) => r.status === "ready") ?? null;
    if (done) return done;
    return latest && running && (latest.groups_json?.length ?? 0) > 0 ? latest : null;
  }, [reviews, latest, running]);

  // The patch is server-side; fetch it once per ready review and parse it for the renderer.
  const [patch, setPatch] = useState<{ id: string; text: string } | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  useEffect(() => {
    if (!ready || patch?.id === ready.id) return;
    let cancelled = false;
    fetchReviewPatch(session.token, ready.id)
      .then((text) => {
        if (!cancelled) setPatch({ id: ready.id, text });
      })
      .catch((e: unknown) => {
        if (!cancelled) setPatchError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [ready, patch?.id, session.token]);

  const parsed = useMemo(() => {
    if (!patch) return { byPath: new Map<string, FileDiffMetadata>(), counts: new Map() };
    const byPath = new Map<string, FileDiffMetadata>();
    for (const p of parsePatchFiles(patch.text, `review-${patch.id}`))
      for (const f of p.files) byPath.set(f.name || f.prevName || "", f);
    const counts = new Map(
      splitPatch(patch.text).map((f) => [f.path, { added: f.added, removed: f.removed }]),
    );
    return { byPath, counts };
  }, [patch]);
  const fileRows = useMemo(
    () => new Map((ready?.files ?? []).map((f) => [f.path, f])),
    [ready?.files],
  );

  const steps = useMemo<Step[]>(() => {
    if (!ready) return [];
    const groups = Array.isArray(ready.groups_json) ? ready.groups_json : [];
    const out: Step[] = groups.map((g) => ({ ...g, markable: true }));
    // Files GitHub lists now that the review never saw: a last step until someone regenerates.
    const placed = new Set(groups.flatMap((g) => g.files));
    const stale = (pull?.files_json ?? []).filter((p) => !placed.has(p));
    if (stale.length > 0)
      out.push({
        name: "Changed since generation",
        summary: "These files changed after the review was generated. Regenerate to fold them in.",
        files: stale,
        markable: false,
      });
    return out;
  }, [ready, pull?.files_json]);

  const current = Math.min(Math.max(1, search.step), Math.max(1, steps.length)) - 1;
  const step = steps[current] ?? null;
  const goTo = useCallback(
    (index: number) =>
      void navigate({
        to: ".",
        search: (s) => ({ ...s, step: Math.min(Math.max(1, index + 1), steps.length || 1) }),
        replace: true,
      }),
    [navigate, steps.length],
  );
  const back = useCallback(
    () =>
      void navigate({
        to: "/pulls/$pullId",
        params: { pullId },
        // Only the repository rides along, as with every view switch.
        search: (s) => ({ repo: s.repo }),
      }),
    [navigate, pullId],
  );

  // Progress: mine drives the checkmarks; everyone's shows in the rail.
  const progress = pull?.reviewProgress ?? [];
  const mine = useMemo(
    () =>
      new Set(progress.filter((p) => p.user_id === session.user.userID).map((p) => p.step_name)),
    [progress, session.user.userID],
  );
  const others = useMemo(() => {
    const m = new Map<
      string,
      { key: string; name: string; color: string; src?: string | null }[]
    >();
    for (const p of progress) {
      if (p.user_id === session.user.userID || !p.user) continue;
      m.set(p.step_name, [
        ...(m.get(p.step_name) ?? []),
        { key: p.user_id, name: p.user.name, color: p.user.color, src: p.user.avatar_url ?? null },
      ]);
    }
    return m;
  }, [progress, session.user.userID]);
  const mark = useCallback(
    (s: Step, reviewed: boolean) => {
      if (!ready || !s.markable) return;
      void z.mutate(
        mutators.review.markStep({ pullId, reviewId: ready.id, stepName: s.name, reviewed }),
      );
    },
    [z, pullId, ready],
  );
  const markAndAdvance = useCallback(() => {
    if (!step) return;
    const done = mine.has(step.name);
    mark(step, !done);
    if (!done && current < steps.length - 1) goTo(current + 1);
  }, [step, mine, mark, current, steps.length, goTo]);

  // The diff pane starts at the top of each step.
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    pane.current?.scrollTo({ top: 0 });
  }, [current, ready?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
      if (e.key === "Escape") back();
      else if (e.key === "]" || e.key === "n") goTo(current + 1);
      else if (e.key === "[" || e.key === "p") goTo(current - 1);
      else if (e.key === "m") markAndAdvance();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, goTo, current, markAndAdvance]);

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      await generateGuidedReview(session.token, pullId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const loading = result.type !== "complete" && !pull;
  const doneCount = steps.filter((s) => s.markable && mine.has(s.name)).length;
  const stale = !!ready && isStale(ready, pull?.head_sha ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col animate-in fade-in slide-in-from-bottom-2 duration-300 motion-reduce:animate-none">
      <ViewHeader title="Guided review">
        {ready && (
          <span className="truncate text-xs text-muted-foreground">
            {ready.source === "seed" ? "classified order" : ready.model} ·{" "}
            {compact(ready.input_tokens)} in / {compact(ready.output_tokens)} out
            {ready.creator ? ` · by ${ready.creator.name}` : ""} · {ago(ready.finished_at, now)}
            {running && ` · ${reviewPhaseText(latest?.phase).toLowerCase()}…`}
          </span>
        )}
        <Button
          size="xs"
          variant={stale ? "default" : "outline"}
          onClick={regenerate}
          disabled={busy || running}
        >
          {ready ? "Regenerate" : "Generate"}
        </Button>
        <KeyHelp rows={REVIEW_KEYS} />
      </ViewHeader>

      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <Button variant="ghost" size="icon-xs" onClick={back} aria-label="Back to the pull request">
          <ArrowLeft />
        </Button>
        {pull ? (
          <>
            <span className="text-muted-foreground tabular-nums">#{pull.number}</span>
            <span className="min-w-0 flex-1 truncate font-medium">{pull.title}</span>
            <Tag className="font-mono">{pull.head_ref}</Tag>
            <a
              href={pull.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              GitHub <ExternalLink className="size-3" />
            </a>
          </>
        ) : (
          <span className="text-muted-foreground">{loading ? "Loading…" : "Not synced."}</span>
        )}
      </div>

      {error && <p className="border-b px-4 py-2 text-xs text-destructive">{error}</p>}
      {stale && !running && (
        <p className="border-b bg-muted/40 px-4 py-2 text-xs text-pretty">
          <span className="text-status-warning">New commits since this review</span>
          <span className="text-muted-foreground">
            {" "}
            ({ready.head_sha!.slice(0, 7)} → {pull!.head_sha!.slice(0, 7)}). The steps below
            describe the older diff; regenerate when you want the new changes folded in.
          </span>
        </p>
      )}
      {ready?.source === "seed" && ready.error && (
        <p className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground text-pretty">
          The model failed to write the walkthrough ({ready.error}). These steps are the code's
          classified order; regenerate to try again.
        </p>
      )}

      {!ready ? (
        <Empty pull={pull} latest={latest} running={running} loading={loading} />
      ) : (
        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <aside className="flex w-80 shrink-0 flex-col border-r max-md:w-full max-md:max-h-[45%] max-md:border-r-0 max-md:border-b">
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
              <p className="font-mono text-xs text-muted-foreground tabular-nums">
                {String(current + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
                {doneCount > 0 && ` · ${doneCount} reviewed`}
              </p>
              {step && (
                <>
                  <h2 className="text-base font-semibold text-balance">{step.name}</h2>
                  {step.summary ? (
                    <p className="text-sm leading-6 text-foreground/80 text-pretty">
                      {step.summary}
                    </p>
                  ) : (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
                      Writing this step…
                    </p>
                  )}
                  <div className="flex flex-col gap-1">
                    {step.files.map((path) => {
                      const c = parsed.counts.get(path) ?? fileRows.get(path);
                      const row = fileRows.get(path);
                      return (
                        <button
                          key={path}
                          type="button"
                          className="flex w-full flex-col gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-accent"
                          onClick={() =>
                            document
                              .getElementById(`diff-${path}`)
                              ?.scrollIntoView({ behavior: "smooth", block: "start" })
                          }
                        >
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-xs">
                              {splitPath(path)[0]}
                            </span>
                            {c && <Counts added={c.added} removed={c.removed} />}
                          </span>
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
                              {splitPath(path)[1] ?? "\u00a0"}
                            </span>
                            {row && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">
                                    <Tag>{ROLE_NAMES[row.role] ?? row.role}</Tag>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-64">
                                  <FileWhy row={row} />
                                </TooltipContent>
                              </Tooltip>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5 border-t px-3 py-2">
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="Previous step"
                disabled={current === 0}
                onClick={() => goTo(current - 1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="outline"
                size="icon-xs"
                aria-label="Next step"
                disabled={current >= steps.length - 1}
                onClick={() => goTo(current + 1)}
              >
                <ChevronRight />
              </Button>
              {step?.markable && (
                <Button
                  size="xs"
                  variant={mine.has(step.name) ? "secondary" : "default"}
                  className="flex-1"
                  onClick={markAndAdvance}
                >
                  <Check className={cn(!mine.has(step.name) && "opacity-50")} />
                  {mine.has(step.name) ? "Reviewed" : "Mark reviewed"}
                </Button>
              )}
            </div>
            <nav className="flex max-h-[30%] shrink-0 flex-col gap-px overflow-y-auto border-t px-2 py-2">
              <SectionLabel kind="triage">Steps</SectionLabel>
              {steps.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent",
                    i === current ? "bg-accent text-foreground" : "text-muted-foreground",
                  )}
                  onClick={() => goTo(i)}
                >
                  <span className="w-5 shrink-0 font-mono tabular-nums">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{s.name}</span>
                  <AvatarStack people={others.get(s.name) ?? []} size="xs" max={3} />
                  {mine.has(s.name) && (
                    <Check className="size-3.5 shrink-0 text-status-good" strokeWidth={2.5} />
                  )}
                </button>
              ))}
            </nav>
          </aside>

          <div ref={pane} className="min-w-0 flex-1 overflow-y-auto">
            <div className="flex flex-col gap-4 p-4">
              {patchError && <p className="text-xs text-destructive">{patchError}</p>}
              {!patch && !patchError && (
                <p className="text-xs text-muted-foreground">Loading the diff…</p>
              )}
              {step?.files.map((path) => {
                const file = parsed.byPath.get(path);
                const c = parsed.counts.get(path);
                const row = fileRows.get(path);
                return (
                  <div key={path} id={`diff-${path}`} className="scroll-mt-4">
                    {file ? (
                      <DiffFile
                        path={path}
                        file={file}
                        added={c?.added ?? 0}
                        removed={c?.removed ?? 0}
                        reason={collapseReason(
                          path,
                          (c?.added ?? 0) + (c?.removed ?? 0),
                          row?.attention ?? null,
                        )}
                      />
                    ) : (
                      patch && (
                        <div className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                          <FileName path={path} />
                          <span>not in the reviewed diff</span>
                        </div>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The tooltip behind a file's role tag: jev's answers, the reason it sits where it does. */
function FileWhy({
  row,
}: {
  row: {
    role: string;
    role_confidence?: number | null;
    risk?: number | null;
    attention?: number | null;
    entry?: number | null;
  };
}) {
  const level = (v: number | null | undefined, names: readonly string[]) =>
    v === null || v === undefined ? "—" : names[Math.round(v * (names.length - 1))];
  return (
    <div className="flex flex-col gap-0.5">
      <div className="font-medium">
        {ROLE_NAMES[row.role] ?? row.role}
        {row.role_confidence != null && ` · ${Math.round(row.role_confidence * 100)}%`}
      </div>
      <div className="text-muted-foreground">
        risk {level(row.risk, ["low", "moderate", "high", "critical"])} ·{" "}
        {level(row.attention, ["skim", "read", "read carefully"])}
        {(row.entry ?? 0) >= 0.6 && " · entry point"}
      </div>
    </div>
  );
}

function Empty({
  pull,
  latest,
  running,
  loading,
}: {
  pull: { files_json: string[] } | null | undefined;
  latest: { status: string; error?: string | null; model: string; phase?: string | null } | null;
  running: boolean;
  loading: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
      {running ? (
        <>
          <span className="size-4 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
          <p className="font-medium">{reviewPhaseText(latest?.phase)}…</p>
          <p className="max-w-md text-sm text-muted-foreground text-pretty">
            The steps appear as soon as they are named; their text fills in after. Generating with{" "}
            {latest?.model}.
          </p>
        </>
      ) : latest?.status === "failed" ? (
        <>
          <p className="font-medium">The review failed</p>
          <p className="max-w-md text-sm text-destructive text-pretty">{latest.error}</p>
        </>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <p className="font-medium">No guided review yet</p>
          <p className="max-w-md text-sm text-muted-foreground text-pretty">
            An ordered walkthrough of this change: the core first, supporting changes after, churn
            last. Generated once and shared with everyone.
          </p>
          {pull && (
            <p className="font-mono text-xs text-muted-foreground">
              {pull.files_json.length} changed files
            </p>
          )}
        </>
      )}
    </div>
  );
}

export { splitPath };
