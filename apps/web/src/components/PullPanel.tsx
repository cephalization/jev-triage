import { useQuery, useZero } from "@rocicorp/zero/react";
import { effectiveIssue, mutators, numeric, PULL_KINDS, queries } from "@triage/schema";
import { REVIEW_EFFORT_LEVELS } from "@triage/triage/types";
import type { Assignment } from "@triage/triage/reviewers";
import { ExternalLink, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ago, EFFORT_NAMES, pct, REVIEW_DECISION_NAMES, severityColor } from "../lib/format.ts";
import { Avatar } from "./Avatar.tsx";
import { ProbStrip, ReviewDecisionMark, SectionLabel, StatusIcon, Tag } from "./Marks.tsx";
import { Button } from "./ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";

const NONE = "__none__";
const GHOST_TRIGGER =
  "h-7 w-full border-transparent bg-transparent px-2 shadow-none hover:bg-accent data-[placeholder]:text-muted-foreground dark:bg-transparent dark:hover:bg-accent";

const KIND_LABEL: Record<string, string> = {
  review_effort: "Review effort",
  reviewer: "Reviewer",
};

const REVIEW_STATE: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "requested changes",
  COMMENTED: "commented",
  DISMISSED: "review dismissed",
  PENDING: "started a review",
};

export interface RosterEntry {
  login: string;
  reviews: number;
  approvals: number;
  open_load: number;
}

function effortName(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  return `${EFFORT_NAMES[Math.round(v * (REVIEW_EFFORT_LEVELS.length - 1))]} · ${pct(v)}`;
}

/**
 * Split-view details for a pull request; mirrors IssuePanel's two halves: the tinted Triage
 * section (this app's suggestions, editable) and the plain "On GitHub" section (mirrored).
 */
export function PullPanel({
  pullId,
  questionsVersion,
  roster,
  assigned,
  onClose,
  now,
}: {
  pullId: string;
  questionsVersion: number;
  roster: readonly RosterEntry[];
  assigned: Assignment | null;
  onClose: () => void;
  now: number;
}) {
  const z = useZero();
  const [pull, result] = useQuery(queries.pulls.byId(pullId));
  const [note, setNote] = useState("");
  const eff = useMemo(
    () =>
      pull
        ? effectiveIssue(pull.classifications, pull.feedback, questionsVersion, PULL_KINDS)
        : null,
    [pull, questionsVersion],
  );

  function give(kind: (typeof PULL_KINDS)[number], value: string) {
    if (!pull) return;
    void z.mutate(
      mutators.feedback.set({
        id: crypto.randomUUID(),
        pullId: pull.id,
        repoId: pull.repo_id,
        kind,
        value,
        note: note.trim() || undefined,
      }),
    );
    setNote("");
  }

  if (!pull) {
    return (
      <aside className="flex h-full flex-col items-center justify-center border-l bg-background text-muted-foreground">
        {result.type === "complete" ? "This pull request is not synced." : "Loading…"}
      </aside>
    );
  }
  if (!eff) return null;

  const effort = numeric(eff.review_effort);
  const effortIndex =
    effort === null ? null : Math.round(effort * (REVIEW_EFFORT_LEVELS.length - 1));
  const reviewer = eff.reviewer.value && eff.reviewer.value !== "none" ? eff.reviewer.value : null;
  const rosterLogins = new Set(roster.map((r) => r.login));
  const status = pull.classifying
    ? "classifying"
    : eff.review_effort.source === "none"
      ? "unclassified"
      : eff.review_effort.source === "human" || eff.reviewer.source === "human"
        ? "human"
        : "model";
  const statusText = {
    classifying: "Classifying…",
    unclassified: pull.reclassify ? "Queued for the model" : "Not classified yet",
    human: "Confirmed by a person",
    model: "Suggested by the model",
  }[status];
  const files = Array.isArray(pull.files_json) ? pull.files_json : [];
  const requested = Array.isArray(pull.requested_reviewers_json)
    ? pull.requested_reviewers_json
    : [];
  const labels = Array.isArray(pull.labels_json) ? pull.labels_json : [];
  const reviews = [...pull.reviews].sort((a, b) => b.submitted_at - a.submitted_at);
  const feedback = [...pull.feedback].sort((a, b) => b.created_at - a.created_at);

  return (
    <aside className="flex h-full min-h-0 flex-col border-l bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
        <span className="text-xs text-muted-foreground tabular-nums">#{pull.number}</span>
        <a
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          href={pull.url}
          target="_blank"
          rel="noreferrer"
        >
          Open on GitHub <ExternalLink className="size-3" />
        </a>
        <span className="flex-1" />
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close (Esc)">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-1.5 px-4 pt-4 pb-3">
          <h2 className="text-[0.9375rem] font-semibold text-balance">
            {pull.draft && <Tag className="mr-2 align-middle">draft</Tag>}
            {pull.title}
          </h2>
          <p className="text-xs text-muted-foreground">
            {pull.author} · {pull.state} · opened {ago(pull.created_at, now)}
            {pull.merged_at ? ` · merged ${ago(pull.merged_at, now)}` : ""}
          </p>
        </div>

        <section className="border-y bg-primary/[0.04] px-4 py-3">
          <SectionLabel
            kind="triage"
            trailing={
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <StatusIcon status={status} confidence={eff.review_effort.confidence} />
                {statusText}
              </span>
            }
          >
            Triage
          </SectionLabel>
          <dl className="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1">
            <dt className="text-xs text-muted-foreground">Effort</dt>
            <dd>
              <Select
                value={effortIndex === null ? NONE : String(effortIndex)}
                onValueChange={(v) =>
                  v !== NONE &&
                  give("review_effort", (Number(v) / (REVIEW_EFFORT_LEVELS.length - 1)).toFixed(4))
                }
              >
                <SelectTrigger className={GHOST_TRIGGER} aria-label="Review effort">
                  <SelectValue placeholder="Set review effort" />
                </SelectTrigger>
                <SelectContent>
                  {REVIEW_EFFORT_LEVELS.map((s, i) => (
                    <SelectItem key={s} value={String(i)}>
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: severityColor(i / 3) }}
                      />
                      {EFFORT_NAMES[i]}
                      <span className="text-xs text-muted-foreground [[data-slot=select-value]_&]:hidden">
                        {s.split(";").pop()?.trim()}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </dd>

            <dt className="text-xs text-muted-foreground">Reviewer</dt>
            <dd>
              <Select
                value={reviewer ?? NONE}
                onValueChange={(v) => give("reviewer", v === NONE ? "none" : v)}
              >
                <SelectTrigger className={GHOST_TRIGGER} aria-label="Reviewer">
                  <SelectValue placeholder="Pick a reviewer" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>none</SelectItem>
                  {reviewer && !rosterLogins.has(reviewer) && (
                    <SelectItem value={reviewer}>{reviewer}</SelectItem>
                  )}
                  {roster.map((r) => (
                    <SelectItem key={r.login} value={r.login}>
                      {r.login}
                      <span className="ml-auto text-xs text-muted-foreground tabular-nums [[data-slot=select-value]_&]:hidden">
                        {r.approvals} approvals · {r.open_load} open
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </dd>

            {assigned && assigned.login !== reviewer && (
              <>
                <dt className="text-xs text-muted-foreground">Balanced</dt>
                <dd className="px-2 text-sm">
                  {assigned.login}
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    · spread for load; the model preferred {reviewer ?? "no one"}
                  </span>
                </dd>
              </>
            )}
          </dl>
          <Textarea
            rows={2}
            className="mt-2 min-h-0 resize-none border-transparent bg-transparent px-2 shadow-none hover:bg-accent focus-visible:border-input focus-visible:bg-background dark:bg-transparent"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note to your next change…"
          />
        </section>

        <section className="px-4 py-3">
          <SectionLabel kind="github">On GitHub</SectionLabel>
          <dl className="grid grid-cols-[6.5rem_1fr] items-baseline gap-x-2 gap-y-1 text-sm">
            <dt className="text-xs text-muted-foreground">Review state</dt>
            <dd className="flex items-center gap-2">
              <ReviewDecisionMark
                decision={pull.review_decision}
                draft={pull.draft}
                hasReviews={pull.reviews.length > 0}
              />
              <span>
                {pull.draft
                  ? "Draft"
                  : (REVIEW_DECISION_NAMES[pull.review_decision ?? ""] ??
                    (pull.reviews.length > 0 ? "In review" : "Awaiting review"))}
                {pull.mergeable === "CONFLICTING" && (
                  <span className="text-status-serious"> · conflicts</span>
                )}
              </span>
            </dd>
            {requested.length > 0 && (
              <>
                <dt className="text-xs text-muted-foreground">Requested</dt>
                <dd>{requested.join(", ")}</dd>
              </>
            )}
            <dt className="text-xs text-muted-foreground">Change</dt>
            <dd className="tabular-nums">
              {pull.head_ref} → {pull.base_ref} ·{" "}
              <span className="text-status-good">+{pull.additions}</span>{" "}
              <span className="text-status-critical">−{pull.deletions}</span> in{" "}
              {pull.changed_files} {pull.changed_files === 1 ? "file" : "files"} · {pull.comments}{" "}
              comments
            </dd>
            {labels.length > 0 && (
              <>
                <dt className="self-start pt-1 text-xs text-muted-foreground">Labels</dt>
                <dd className="flex flex-wrap gap-1">
                  {labels.map((l) => (
                    <Tag key={l}>{l}</Tag>
                  ))}
                </dd>
              </>
            )}
          </dl>
          <div className="mt-3 max-h-96 overflow-auto text-sm leading-5 whitespace-pre-wrap text-foreground/90">
            {pull.body || <span className="text-muted-foreground">No description.</span>}
          </div>
          <h3 className="mt-3 mb-1 text-xs font-medium text-muted-foreground">
            Files
            {files.length < pull.changed_files ? ` (${files.length} of ${pull.changed_files})` : ""}
          </h3>
          {files.length === 0 && <p className="text-xs text-muted-foreground">No file list.</p>}
          <ul role="list" className="max-h-48 overflow-auto font-mono text-xs leading-5">
            {files.map((f) => (
              <li key={f} className="truncate text-foreground/80" title={f}>
                {f}
              </li>
            ))}
          </ul>
          <h3 className="mt-3 mb-1 text-xs font-medium text-muted-foreground">Reviews</h3>
          {reviews.length === 0 && <p className="text-xs text-muted-foreground">No reviews yet.</p>}
          <ul role="list" className="flex flex-col gap-1">
            {reviews.map((r) => (
              <li key={r.id} className="text-xs">
                <span className="font-medium">{r.reviewer}</span>
                <span className="text-muted-foreground">
                  {" "}
                  {REVIEW_STATE[r.state] ?? r.state.toLowerCase()} · {ago(r.submitted_at, now)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <details className="group border-t px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-muted-foreground">
            <span>What the model saw</span>
            <span className="font-normal">questions v{questionsVersion}</span>
          </summary>
          <dl className="mt-3 grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-3">
            {PULL_KINDS.map((k) => {
              const f = eff[k];
              const show = (v: string | null | undefined) =>
                k === "review_effort" ? (effortName(v) ?? "—") : (v ?? "—");
              const highlight =
                k === "review_effort" && f.model?.value != null
                  ? String(Math.round(Number(f.model.value) * (REVIEW_EFFORT_LEVELS.length - 1)))
                  : (f.model?.value ?? null);
              return (
                <div key={k} className="contents">
                  <dt className="pt-px text-xs text-muted-foreground">{KIND_LABEL[k]}</dt>
                  <dd className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-medium">{show(f.model?.value)}</span>
                      {f.model?.confidence != null && (
                        <span className="text-muted-foreground tabular-nums">
                          {pct(f.model.confidence)}
                        </span>
                      )}
                      {f.source === "human" && (
                        <span className="text-status-good">→ {show(f.value)} by a person</span>
                      )}
                    </div>
                    <ProbStrip
                      probabilities={f.probabilities}
                      highlight={highlight}
                      format={(key) =>
                        k === "review_effort" ? (EFFORT_NAMES[Number(key)] ?? key) : key
                      }
                    />
                  </dd>
                </div>
              );
            })}
          </dl>
        </details>

        <section className="border-t px-4 py-3">
          <SectionLabel kind="triage">Triage activity</SectionLabel>
          {feedback.length === 0 && (
            <p className="text-xs text-muted-foreground">Nobody has touched this yet.</p>
          )}
          <ul role="list" className="flex flex-col gap-2">
            {feedback.map((f) => (
              <li key={f.id} className="flex items-start gap-2 text-xs">
                <Avatar name={f.user?.name ?? "?"} color={f.user?.color ?? "#999"} size="xs" />
                <div className="min-w-0">
                  <span className="font-medium">{f.user?.name ?? f.user_id}</span>
                  <span className="text-muted-foreground"> set </span>
                  {KIND_LABEL[f.kind]?.toLowerCase() ?? f.kind}
                  <span className="text-muted-foreground"> to </span>
                  <span className="font-medium">
                    {f.kind === "review_effort" ? effortName(f.value) : f.value}
                  </span>
                  <span className="text-muted-foreground"> · {ago(f.created_at, now)}</span>
                  {f.note && <div className="text-muted-foreground">“{f.note}”</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}
