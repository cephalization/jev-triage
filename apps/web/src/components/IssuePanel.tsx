import { useQuery, useZero } from "@rocicorp/zero/react";
import {
  CATEGORIES,
  CLASSIFICATION_KINDS,
  effectiveIssue,
  mutators,
  numeric,
  queries,
} from "@triage/schema";
import { ACTION_LABELS, SEVERITY_LEVELS, URGENCY_LEVELS } from "@triage/triage/types";
import { cn } from "cn";
import { Check, CircleCheck, ExternalLink, Hand, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { whyLine } from "../lib/derive.ts";
import {
  ACTION_META,
  ACTION_ORDER,
  ago,
  CATEGORY_COLORS,
  MISSING_NAMES,
  pct,
  SEVERITY_NAMES,
  severityColor,
  URGENCY_NAMES,
} from "../lib/format.ts";
import { viewersOf } from "../lib/presence.ts";
import { Avatar } from "./Avatar.tsx";
import type { UserInfo } from "./IssueTable.tsx";
import { ActionPill, CategoryChip, Pill, ProbStrip, StatusIcon } from "./Marks.tsx";
import { Button } from "./ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";

const NONE = "__none__";
const GHOST_TRIGGER =
  "h-7 w-full border-transparent bg-transparent px-2 shadow-none hover:bg-accent data-[placeholder]:text-muted-foreground dark:bg-transparent dark:hover:bg-accent";

/** Level-index outcomes ("0".."3") read as rubric names; everything else passes through. */
function outcomeName(kind: string, key: string): string {
  if (kind === "action") return ACTION_META[key]?.label ?? key;
  if (kind === "missing") return MISSING_NAMES[key] ?? key;
  const i = Number(key);
  if (!Number.isInteger(i)) return key;
  if (kind === "severity") return SEVERITY_NAMES[i] ?? key;
  if (kind === "urgency") return URGENCY_NAMES[i] ?? key;
  return key;
}

/** The model's expected-value answer for a scored family, as "Critical · 96%". */
function scoredName(kind: string, value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  if (kind === "severity")
    return `${SEVERITY_NAMES[Math.round(v * (SEVERITY_LEVELS.length - 1))]} · ${pct(v)}`;
  if (kind === "urgency")
    return `${URGENCY_NAMES[Math.round(v * (URGENCY_LEVELS.length - 1))]} · ${pct(v)}`;
  return null;
}

/** The outcome key ("0".."3") the model's expected value rounds to, so the strip can highlight it. */
function scoredKey(kind: string, value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  if (kind === "severity") return String(Math.round(v * (SEVERITY_LEVELS.length - 1)));
  if (kind === "urgency") return String(Math.round(v * (URGENCY_LEVELS.length - 1)));
  return null;
}

const KIND_LABEL: Record<string, string> = {
  action: "Next step",
  category: "Category",
  area: "Area",
  severity: "Severity",
  urgency: "Urgency",
  missing: "Missing",
  duplicate: "Duplicate",
};

/**
 * Non-modal details panel (split view). The list stays live and clickable; j/k move the
 * selection, Esc closes. In the panel: 1–6 set the category, a accepts the suggestion,
 * c claims, x marks done.
 */
export function IssuePanel({
  issueId,
  questionsVersion,
  areaLabels,
  issuesByNumber,
  users,
  selfId,
  onClose,
  onAdvance,
  now,
}: {
  issueId: string;
  questionsVersion: number;
  areaLabels: readonly string[];
  /** Synced issues by number, for duplicate candidates and typed numbers. */
  issuesByNumber: Map<number, { id: string; title: string }>;
  users: Map<string, UserInfo>;
  selfId: string;
  onClose: () => void;
  /** Called after the issue leaves the queue so the selection can move on. */
  onAdvance: () => void;
  now: number;
}) {
  const z = useZero();
  const [issue, result] = useQuery(queries.issues.byId(issueId));
  const [note, setNote] = useState("");
  const [dupNumber, setDupNumber] = useState("");
  const eff = useMemo(
    () =>
      issue
        ? effectiveIssue(
            issue.classifications,
            issue.feedback,
            questionsVersion,
            CLASSIFICATION_KINDS,
          )
        : null,
    [issue, questionsVersion],
  );
  const idToNumber = useMemo(
    () => new Map([...issuesByNumber.entries()].map(([n, v]) => [v.id, n])),
    [issuesByNumber],
  );

  function give(kind: (typeof CLASSIFICATION_KINDS)[number], value: string) {
    if (!issue) return;
    void z.mutate(
      mutators.feedback.set({
        id: crypto.randomUUID(),
        issueId: issue.id,
        repoId: issue.repo_id,
        kind,
        value,
        note: note.trim() || undefined,
      }),
    );
    setNote("");
  }

  const done = issue?.triage?.status === "done";
  const claimedBy = issue?.triage?.claimed_by ?? null;
  const mine = claimedBy === selfId;

  function claim() {
    if (!issue) return;
    void z.mutate(
      mutators.triage.claim({ issueId: issue.id, repoId: issue.repo_id, claim: !mine }),
    );
  }
  function setDone(next: boolean) {
    if (!issue) return;
    void z.mutate(
      mutators.triage.setStatus({
        issueId: issue.id,
        repoId: issue.repo_id,
        status: next ? "done" : "open",
      }),
    );
    if (next) onAdvance();
  }
  /** Confirm what the model suggested for the decision fields, then leave the queue. */
  function accept() {
    if (!issue || !eff) return;
    const values: { id: string; kind: (typeof CLASSIFICATION_KINDS)[number]; value: string }[] = [];
    for (const kind of ["action", "category", "area", "duplicate"] as const) {
      const f = eff[kind];
      if (f.source === "model" && f.value)
        values.push({ id: crypto.randomUUID(), kind, value: f.value });
    }
    void z.mutate(mutators.triage.accept({ issueId: issue.id, repoId: issue.repo_id, values }));
    onAdvance();
  }

  // Keyboard: 1–6 category, a accept, c claim, x done (never while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          t.getAttribute("role") === "combobox")
      )
        return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < CATEGORIES.length) {
        e.preventDefault();
        give("category", CATEGORIES[idx]!);
      } else if (e.key === "a" && !done) {
        e.preventDefault();
        accept();
      } else if (e.key === "c") {
        e.preventDefault();
        claim();
      } else if (e.key === "x") {
        e.preventDefault();
        setDone(!done);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const dupDisplay = (v: string | null) =>
    !v || v === "none" ? "none" : v.startsWith("#") ? v : `#${idToNumber.get(v) ?? "?"}`;
  const markDuplicate = (raw: string) => {
    const n = Number(raw.replace("#", ""));
    if (!Number.isFinite(n) || n <= 0) return;
    give("duplicate", issuesByNumber.get(n)?.id ?? `#${n}`);
    setDupNumber("");
  };

  if (!issue) {
    return (
      <aside className="flex h-full flex-col items-center justify-center border-l bg-background text-muted-foreground">
        {result.type === "complete" ? "This issue is not synced." : "Loading…"}
      </aside>
    );
  }
  if (!eff) return null;

  const severityValue = numeric(eff.severity);
  const severityIndex =
    severityValue === null ? null : Math.round(severityValue * (SEVERITY_LEVELS.length - 1));
  const action = eff.action.value;
  const missing = eff.missing.value === "none" ? null : eff.missing.value;
  const dup = eff.duplicate.value && eff.duplicate.value !== "none" ? eff.duplicate.value : null;
  const why = whyLine({
    category: eff.category.value,
    categorySource: eff.category.source,
    severity: severityValue,
    urgency: numeric(eff.urgency),
    action,
    missing,
    duplicateOf: dup,
    reactions: issue.reactions,
    comments: issue.comments,
    ageDays: (now - issue.created_at) / 86_400_000,
  });
  const confirmedBy = eff.action.human ? users.get(eff.action.human.user_id)?.name : null;
  const status = issue.classifying
    ? "classifying"
    : eff.action.source === "none" && eff.category.source === "none"
      ? "unclassified"
      : eff.action.source === "human"
        ? "human"
        : "model";
  const statusText = {
    classifying: "Classifying…",
    unclassified: issue.reclassify ? "Queued for the model" : "Not classified yet",
    human: `Confirmed${confirmedBy ? ` by ${confirmedBy}` : ""}`,
    model: eff.action.model ? "Suggested by the model" : "Partly classified",
  }[status];
  // Duplicate candidates the model weighed, best first, with titles when we have them.
  const candidates = Object.entries(eff.duplicate.probabilities)
    .filter(([k]) => k !== "none" && k.startsWith("#"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, p]) => {
      const n = Number(k.slice(1));
      return { key: k, number: n, p, title: issuesByNumber.get(n)?.title ?? null };
    });
  const viewers = viewersOf(issue.presence, now).filter((v) => v.user_id !== claimedBy);
  const owner = claimedBy ? users.get(claimedBy) : undefined;
  const events = [
    ...issue.feedback.map((f) => ({
      key: f.id,
      at: f.created_at,
      name: f.user?.name ?? f.user_id,
      color: f.user?.color ?? "#999",
      text: (
        <>
          <span className="text-muted-foreground">set </span>
          {KIND_LABEL[f.kind]?.toLowerCase() ?? f.kind}
          <span className="text-muted-foreground"> to </span>
          <span className="font-medium">
            {f.kind === "duplicate"
              ? dupDisplay(f.value)
              : f.kind === "action"
                ? (ACTION_META[f.value]?.label ?? f.value)
                : f.value}
          </span>
        </>
      ),
      note: f.note ?? null,
    })),
    ...(issue.triage?.done_at && issue.triage.done_by
      ? [
          {
            key: "done",
            at: issue.triage.done_at,
            name: users.get(issue.triage.done_by)?.name ?? "someone",
            color: users.get(issue.triage.done_by)?.color ?? "#999",
            text: <span className="text-muted-foreground">marked it triaged</span>,
            note: null,
          },
        ]
      : []),
    ...(issue.triage?.claimed_at && claimedBy
      ? [
          {
            key: "claim",
            at: issue.triage.claimed_at,
            name: owner?.name ?? "someone",
            color: owner?.color ?? "#999",
            text: <span className="text-muted-foreground">took it</span>,
            note: null,
          },
        ]
      : []),
  ].sort((a, b) => b.at - a.at);

  return (
    <aside className="flex h-full min-h-0 flex-col border-l bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
        <span className="text-xs text-muted-foreground tabular-nums">#{issue.number}</span>
        <a
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          href={issue.url}
          target="_blank"
          rel="noreferrer"
        >
          GitHub <ExternalLink className="size-3" />
        </a>
        <span className="flex-1" />
        <span className="flex -space-x-1">
          {viewers.map((p) => (
            <Avatar key={p.user_id} name={p.name} color={p.color} hint={`${p.name} is here`} />
          ))}
        </span>
        <Button
          size="xs"
          variant={mine ? "secondary" : "ghost"}
          onClick={claim}
          aria-pressed={mine}
          title={mine ? "Release (c)" : owner ? `${owner.name} has it; take it (c)` : "Take it (c)"}
        >
          {owner && !mine ? (
            <Avatar size="xs" name={owner.name} color={owner.color} />
          ) : (
            <Hand className="size-3" />
          )}
          {mine ? "Mine" : owner ? owner.name : "Claim"}
        </Button>
        <Button
          size="xs"
          variant={done ? "secondary" : "ghost"}
          onClick={() => setDone(!done)}
          title={done ? "Back to the queue (x)" : "Mark triaged (x)"}
        >
          {done ? <RotateCcw className="size-3" /> : <CircleCheck className="size-3" />}
          {done ? "Reopen" : "Done"}
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close (Esc)">
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-2 px-4 pt-4 pb-3">
          <h2 className="text-[0.9375rem] font-semibold text-balance">{issue.title}</h2>
          <p className="text-xs text-muted-foreground">
            {issue.author} · {issue.state} · {issue.comments} comments · {issue.reactions} reactions
            · opened {ago(issue.created_at, now)}
          </p>
        </div>

        <section className="border-t px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <StatusIcon status={status} confidence={eff.action.confidence} />
            <h3 className="text-xs font-medium text-muted-foreground">{statusText}</h3>
            {done && <Pill muted>triaged</Pill>}
          </div>
          {why && <p className="mb-3 text-sm text-foreground/80">{why}</p>}
          <dl className="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1">
            <dt className="text-xs text-muted-foreground">Next step</dt>
            <dd>
              <Select value={action ?? NONE} onValueChange={(v) => v !== NONE && give("action", v)}>
                <SelectTrigger className={GHOST_TRIGGER} aria-label="Next step">
                  <SelectValue placeholder="Set the next step" />
                </SelectTrigger>
                <SelectContent>
                  {ACTION_ORDER.map((a) => (
                    <SelectItem key={a} value={a}>
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: ACTION_META[a]!.color }}
                      />
                      {ACTION_META[a]!.label}
                      <span className="ml-auto max-w-56 truncate text-xs text-muted-foreground [[data-slot=select-value]_&]:hidden">
                        {ACTION_META[a]!.description}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </dd>
            {action === "ask_author" && (
              <>
                <dt className="text-xs text-muted-foreground">Ask for</dt>
                <dd className="px-2 text-sm">
                  {missing ? (
                    <>
                      {MISSING_NAMES[missing] ?? missing}
                      {eff.missing.source === "model" && eff.missing.confidence != null && (
                        <span className="text-xs text-muted-foreground">
                          {" "}
                          · {pct(eff.missing.confidence)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">nothing specific</span>
                  )}
                </dd>
              </>
            )}

            <dt className="text-xs text-muted-foreground">
              Category <span className="kbd ml-1">1–6</span>
            </dt>
            <dd>
              <Select
                value={eff.category.value ?? NONE}
                onValueChange={(v) => v !== NONE && give("category", v)}
              >
                <SelectTrigger className={GHOST_TRIGGER} aria-label="Category">
                  <SelectValue placeholder="Set category" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c, i) => (
                    <SelectItem key={c} value={c}>
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: CATEGORY_COLORS[c] }}
                      />
                      {c}
                      <span className="ml-auto text-xs text-muted-foreground [[data-slot=select-value]_&]:hidden">
                        {i + 1}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </dd>

            <dt className="text-xs text-muted-foreground">Area</dt>
            <dd>
              <Select
                value={eff.area.value ?? NONE}
                onValueChange={(v) => give("area", v === NONE ? "none" : v)}
              >
                <SelectTrigger className={GHOST_TRIGGER} aria-label="Area">
                  <SelectValue placeholder="Set area" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>none</SelectItem>
                  {areaLabels.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </dd>

            <dt className="text-xs text-muted-foreground">Severity</dt>
            <dd>
              <Select
                value={severityIndex === null ? NONE : String(severityIndex)}
                onValueChange={(v) =>
                  v !== NONE &&
                  give("severity", (Number(v) / (SEVERITY_LEVELS.length - 1)).toFixed(4))
                }
              >
                <SelectTrigger className={GHOST_TRIGGER} aria-label="Severity">
                  <SelectValue placeholder="Set severity" />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITY_LEVELS.map((s, i) => (
                    <SelectItem key={s} value={String(i)}>
                      <span
                        className="size-2 rounded-full"
                        style={{ backgroundColor: severityColor(i / 3) }}
                      />
                      {SEVERITY_NAMES[i]}
                      <span className="text-xs text-muted-foreground [[data-slot=select-value]_&]:hidden">
                        {s.split(":")[0]}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </dd>

            <dt className="self-start pt-1.5 text-xs text-muted-foreground">Duplicate of</dt>
            <dd className="flex flex-col gap-1 py-0.5">
              {dup && (
                <div className="flex items-center gap-2 px-2 text-sm">
                  <span className="font-medium">{dupDisplay(dup)}</span>
                  {eff.duplicate.source === "human" && (
                    <Check className="size-3 text-status-good" strokeWidth={3} />
                  )}
                  <Button size="xs" variant="ghost" onClick={() => give("duplicate", "none")}>
                    Not a duplicate
                  </Button>
                </div>
              )}
              {candidates.length > 0 && (
                <ul role="list" className="flex flex-col">
                  {candidates.map((c) => (
                    <li key={c.key} className="flex items-center gap-2 px-2 text-xs">
                      <span className="text-muted-foreground tabular-nums">#{c.number}</span>
                      <span className="min-w-0 flex-1 truncate" title={c.title ?? undefined}>
                        {c.title ?? <span className="text-muted-foreground">not synced</span>}
                      </span>
                      <span className="text-muted-foreground tabular-nums">{pct(c.p)}</span>
                      {c.key !== dupDisplay(dup) && (
                        <Button size="xs" variant="ghost" onClick={() => markDuplicate(c.key)}>
                          Mark
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-1">
                <input
                  className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-sm hover:bg-accent focus:border-input focus:bg-background focus:outline-none"
                  placeholder={dup ? "Another number…" : "Issue number…"}
                  aria-label="Duplicate of issue number"
                  value={dupNumber}
                  onChange={(e) => setDupNumber(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") markDuplicate(dupNumber);
                  }}
                />
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!dupNumber.trim()}
                  onClick={() => markDuplicate(dupNumber)}
                >
                  Mark
                </Button>
              </div>
            </dd>

            {issue.labels.length > 0 && (
              <>
                <dt className="self-start pt-1.5 text-xs text-muted-foreground">Labels</dt>
                <dd className="flex flex-wrap gap-1 px-2 py-1">
                  {issue.labels.map((l) => (
                    <Pill key={l.id} color={`#${l.color}`} muted>
                      {l.name}
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
            placeholder="Add a note to your next change…"
          />
          {!done && status === "model" && (
            <div className="mt-2 flex items-center gap-2">
              <Button size="xs" onClick={accept}>
                <Check className="size-3" strokeWidth={3} />
                Looks right, done
              </Button>
              <span className="kbd">a</span>
              <span className="text-xs text-muted-foreground">
                confirms the next step and category, then leaves the queue
              </span>
            </div>
          )}
        </section>

        <section className="border-t px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Description</h3>
          <div className="max-h-96 overflow-auto text-sm leading-5 whitespace-pre-wrap text-foreground/90">
            {issue.body || <span className="text-muted-foreground">No description.</span>}
          </div>
        </section>

        <details className="group border-t px-4 py-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-muted-foreground">
            <span>What the model saw</span>
            <span className="font-normal">questions v{questionsVersion}</span>
          </summary>
          <dl className="mt-3 grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-3">
            {CLASSIFICATION_KINDS.map((k) => {
              const f = eff[k];
              const show = (v: string | null | undefined) =>
                k === "duplicate"
                  ? dupDisplay(v ?? null)
                  : (scoredName(k, v) ?? (v ? outcomeName(k, v) : "—"));
              return (
                <div key={k} className="contents">
                  <dt className="pt-px text-xs text-muted-foreground">{KIND_LABEL[k]}</dt>
                  <dd className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2 text-xs">
                      {k === "category" ? (
                        <CategoryChip
                          value={f.model?.value ?? null}
                          source={f.model ? "model" : "none"}
                        />
                      ) : k === "action" ? (
                        <ActionPill
                          value={f.model?.value ?? null}
                          source={f.model ? "model" : "none"}
                        />
                      ) : (
                        <span className="font-medium">{show(f.model?.value)}</span>
                      )}
                      {f.model?.confidence != null && (
                        <span className="text-muted-foreground tabular-nums">
                          {pct(f.model.confidence)}
                        </span>
                      )}
                      {f.source === "human" && (
                        <span className={cn("text-status-good", f.disagreement || "opacity-70")}>
                          → {show(f.value)} by a person
                        </span>
                      )}
                    </div>
                    <ProbStrip
                      probabilities={f.probabilities}
                      highlight={scoredKey(k, f.model?.value) ?? f.model?.value ?? null}
                      format={(key) => outcomeName(k, key)}
                    />
                  </dd>
                </div>
              );
            })}
          </dl>
        </details>

        <section className="border-t px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Activity</h3>
          {events.length === 0 && (
            <p className="text-xs text-muted-foreground">Nobody has touched this yet.</p>
          )}
          <ul role="list" className="flex flex-col gap-2">
            {events.map((e) => (
              <li key={e.key} className="flex items-start gap-2 text-xs">
                <Avatar name={e.name} color={e.color} size="xs" />
                <div className="min-w-0">
                  <span className="font-medium">{e.name}</span> {e.text}
                  <span className="text-muted-foreground"> · {ago(e.at, now)}</span>
                  {e.note && <div className="text-muted-foreground">“{e.note}”</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
}

export const ACTION_KEYS = ACTION_LABELS;
