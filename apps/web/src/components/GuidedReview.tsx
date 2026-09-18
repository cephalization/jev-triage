import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { generateGuidedReview } from "../lib/api.ts";
import type { Session } from "../lib/auth.ts";
import { ago, reviewPhaseText } from "../lib/format.ts";
import { SectionLabel } from "./Marks.tsx";
import { Button } from "./ui/button.tsx";

export interface GuidedReviewRow {
  id: string;
  status: string;
  head_sha: string | null;
  phase: string | null;
  model: string;
  groups_json: { name: string; summary: string; files: string[] }[];
  file_count: number;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
  created_at: number;
  finished_at: number | null;
}

/**
 * The guided review's corner of the pull panel: a link into the review screen when one exists,
 * the call to action when none does, and the shared run's progress in between. The steps
 * themselves live on the review screen. A run this tab started opens that screen by itself
 * when it finishes.
 */
/** A review is stale when GitHub reports a different head commit than the one it read. */
export function isStale(review: { head_sha: string | null }, headSha: string | null): boolean {
  return !!review.head_sha && !!headSha && review.head_sha !== headSha;
}

export function GuidedReview({
  pullId,
  headSha,
  reviews,
  hasDefault,
  session,
  now,
}: {
  pullId: string;
  /** The pull request's current head commit, from the last sync. */
  headSha: string | null;
  /** Newest first. */
  reviews: readonly GuidedReviewRow[];
  /** The repo has a default provider and model. */
  hasDefault: boolean;
  session: Session;
  now: number;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = reviews[0] ?? null;
  const ready = reviews.find((r) => r.status === "ready") ?? null;
  const running = latest?.status === "queued" || latest?.status === "running";
  const steps = Array.isArray(ready?.groups_json) ? ready.groups_json.length : 0;
  const stale = ready !== null && isStale(ready, headSha);

  // Set when this tab asked for the run; cleared once its result has opened.
  const started = useRef(false);
  useEffect(() => {
    if (!started.current || running || !latest || latest.status !== "ready") return;
    started.current = false;
    void navigate({
      to: "/pulls/$pullId/review",
      params: { pullId },
      search: (s) => ({ repo: s.repo }),
    });
  }, [running, latest, navigate, pullId]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      await generateGuidedReview(session.token, pullId);
      started.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-t px-4 py-3">
      <SectionLabel
        kind="triage"
        trailing={
          ready && (
            <span className="text-xs text-muted-foreground">
              {steps} steps · {ready.model} · {ago(ready.finished_at, now)}
            </span>
          )
        }
      >
        Guided review
      </SectionLabel>

      {!ready && !running && (
        <p className="mb-2 text-xs text-muted-foreground text-pretty">
          An ordered walkthrough of this change: the core first, supporting changes after, churn
          last. Generated once and shared with everyone.
        </p>
      )}
      {latest?.status === "failed" && (
        <p className="mb-2 text-xs text-destructive text-pretty">{latest.error}</p>
      )}
      {stale && !running && (
        <p className="mb-2 text-xs text-status-warning text-pretty">
          New commits since this review ({ready.head_sha!.slice(0, 7)} → {headSha!.slice(0, 7)}). It
          still reads; regenerate when you want the new changes folded in.
        </p>
      )}
      {running && (
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
          <span className="text-pretty">
            {reviewPhaseText(latest.phase)} with {latest.model}. The review opens when it is ready.
          </span>
        </div>
      )}

      <div className="flex items-center gap-2">
        {ready && (
          <Button size="xs" asChild>
            <Link to="/pulls/$pullId/review" params={{ pullId }} search={(s) => ({ repo: s.repo })}>
              Open review <ArrowRight />
            </Link>
          </Button>
        )}
        <Button
          size="xs"
          variant={ready && !stale ? "ghost" : "default"}
          onClick={start}
          disabled={busy || running || !hasDefault}
        >
          {ready
            ? "Regenerate"
            : latest?.status === "failed"
              ? "Try again"
              : "Generate guided review"}
        </Button>
        {!hasDefault && (
          <span className="text-xs text-muted-foreground">
            Pick a provider and model in System → Guided reviews first.
          </span>
        )}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    </section>
  );
}
