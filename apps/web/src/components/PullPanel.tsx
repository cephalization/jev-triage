import { useQuery, useZero } from "@rocicorp/zero/react";
import { effectiveIssue, mutators, numeric, PULL_KINDS, queries } from "@triage/schema";
import { REVIEW_EFFORT_LEVELS } from "@triage/triage/types";
import type { Assignment } from "@triage/triage/reviewers";
import { ExternalLink, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ago, EFFORT_NAMES, pct, REVIEW_DECISION_NAMES, severityColor } from "../lib/format.ts";
import { Avatar } from "./Avatar.tsx";
import { Pill, ProbStrip, ReviewDecisionMark, StatusIcon } from "./Marks.tsx";
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

/** Split-view details for a pull request; mirrors IssuePanel. */
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
    unclassified: pull.reclassify ? "Queued" : "Not classified",
    human: "Confirmed by a person",
    model: `Model · ${pct(eff.review_effort.confidence)} confident on effort`,
  }[status];
  const files = Array.isArray(pull.files_json) ? pull.files_json : [];
  const requested = Array.isArray(pull.requested_reviewers_json)
    ? pull.requested_reviewers_json
    : [];
  const labels = Array.isArray(pull.labels_json) ? pull.labels_json : [];
  const activity = [
    ...pull.reviews.map((r) => ({
      key: r.id,
      at: r.submitted_at,
      node: (
        <>
          <span className="font-medium">{r.reviewer}</span>
          <span className="text-muted-foreground">
            {" "}
            {REVIEW_STATE[r.state] ?? r.state.toLowerCase()}
          </span>
        </>
      ),
      name: r.reviewer,
      color: "#8b8d98",
      note: null as string | null,
    })),
    ...pull.feedback.map((f) => ({
      key: f.id,
      at: f.created_at,
      node: (
        <>
          <span className="font-medium">{f.user?.name ?? f.user_id}</span>
          <span className="text-muted-foreground"> set </span>
          {KIND_LABEL[f.kind]?.toLowerCase() ?? f.kind}
          <span className="text-muted-foreground"> to </span>
          <span className="font-medium">
            {f.kind === "review_effort" ? effortName(f.value) : f.value}
          </span>
        </>
      ),
      name: f.user?.name ?? "?",
      color: f.user?.color ?? "#999",
      note: f.note ?? null,
    })),
  ].sort((a, b) => b.at - a.at);

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
          GitHub <ExternalLink className="size-3" />
        </a>
        <span className="flex-1" />
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close (Esc)">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-2 px-4 pt-4 pb-3">
          <h2 className="text-[0.9375rem] font-semibold text-balance">
            {pull.draft && (
              <Pill muted className="mr-2 align-middle">
                draft
              </Pill>
            )}
            {pull.title}
          </h2>
          <p className="text-xs text-muted-foreground">
            {pull.author} · {pull.state} · {pull.head_ref} → {pull.base_ref} ·{" "}
            <span className="text-status-good">+{pull.additions}</span>{" "}
            <span className="text-status-critical">−{pull.deletions}</span> in {pull.changed_files}{" "}
            {pull.changed_files === 1 ? "file" : "files"} · opened {ago(pull.created_at, now)}
            {pull.merged_at ? ` · merged ${ago(pull.merged_at, now)}` : ""}
          </p>
        </div>

        <section className="border-t px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Properties</h3>
          <dl className="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1">
            <dt className="text-xs text-muted-foreground">Status</dt>
            <dd className="flex h-7 items-center gap-2 px-2">
              <StatusIcon status={status} confidence={eff.review_effort.confidence} />
              <span>{statusText}</span>
            </dd>

            <dt className="text-xs text-muted-foreground">Review state</dt>
            <dd className="flex h-7 items-center gap-2 px-2">
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
                <dt className="text-xs text-muted-foreground">Suggested</dt>
                <dd className="px-2 text-sm">
                  {assigned.login}
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    · balanced for load; the model preferred {reviewer ?? "no one"}
                  </span>
                </dd>
              </>
            )}

            {requested.length > 0 && (
              <>
                <dt className="text-xs text-muted-foreground">Requested</dt>
                <dd className="px-2 text-sm">{requested.join(", ")}</dd>
              </>
            )}

            {labels.length > 0 && (
              <>
                <dt className="self-start pt-1.5 text-xs text-muted-foreground">Labels</dt>
                <dd className="flex flex-wrap gap-1 px-2 py-1">
                  {labels.map((l) => (
                    <Pill key={l} muted>
                      {l}
                    </Pill>
                  ))}
                </dd>
              </>
            )}
          </dl>
          <Textarea
            rows={2}
            className="mt-2 min-h-0 resize-none border-transparent bg-transparent px-2 shadow-none hover:bg-accent focus-visible:border-input focus-visible:bg-background dark:bg-transparent"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add a note to your next answer…"
          />
        </section>

        <section className="border-t px-4 py-3">
          <h3 className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>Model</span>
            <span className="font-normal">questions v{questionsVersion}</span>
          </h3>
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-3">
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
        </section>

        <section className="border-t px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
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
        </section>

        <section className="border-t px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Description</h3>
          <div className="max-h-96 overflow-auto text-sm leading-5 whitespace-pre-wrap text-foreground/90">
            {pull.body || <span className="text-muted-foreground">No description.</span>}
          </div>
        </section>

        <section className="border-t px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Activity</h3>
          {activity.length === 0 && (
            <p className="text-xs text-muted-foreground">No reviews or feedback yet.</p>
          )}
          <ul role="list" className="flex flex-col gap-2">
            {activity.map((a) => (
              <li key={a.key} className="flex items-start gap-2 text-xs">
                <Avatar name={a.name} color={a.color} size="xs" />
                <div className="min-w-0">
                  {a.node}
                  <span className="text-muted-foreground"> · {ago(a.at, now)}</span>
                  {a.note && <div className="text-muted-foreground">“{a.note}”</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}
