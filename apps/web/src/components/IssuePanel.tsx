import { useQuery, useZero } from "@rocicorp/zero/react";
import {
  CATEGORIES,
  CLASSIFICATION_KINDS,
  effectiveIssue,
  mutators,
  numeric,
  queries,
} from "@triage/schema";
import { SEVERITY_LEVELS, URGENCY_LEVELS } from "@triage/triage/types";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ago, CATEGORY_COLORS, pct, SEVERITY_NAMES, severityColor } from "../lib/format.ts";
import { PRESENCE_TTL_MS } from "../lib/presence.ts";
import { Avatar } from "./Avatar.tsx";
import { CategoryChip, Pill, ProbStrip, StatusIcon } from "./Marks.tsx";
import { Button } from "./ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Textarea } from "./ui/textarea.tsx";

const NONE = "__none__";
const GHOST_TRIGGER =
  "h-7 w-full border-transparent bg-transparent px-2 shadow-none hover:bg-accent data-[placeholder]:text-muted-foreground dark:bg-transparent dark:hover:bg-accent";
const URGENCY_NAMES = ["No hurry", "This week", "Now"] as const;

/** Level-index outcomes ("0".."3") read as rubric names; everything else passes through. */
function outcomeName(kind: string, key: string): string {
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
  if (kind === "needs_info" || kind === "actionable") return `${pct(v)} yes`;
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
  category: "Category",
  area: "Area",
  severity: "Severity",
  needs_info: "Needs info",
  actionable: "Actionable",
  duplicate: "Duplicate",
  urgency: "Urgency",
};

/**
 * Non-modal details panel (split view). The list stays live and clickable;
 * j/k move the selection, Esc closes, 1–6 set the category of the open issue.
 */
export function IssuePanel({
  issueId,
  questionsVersion,
  areaLabels,
  numberToId,
  onClose,
  now,
}: {
  issueId: string;
  questionsVersion: number;
  areaLabels: readonly string[];
  numberToId: Map<number, string>;
  onClose: () => void;
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

  // Keyboard: 1–6 set category (only when focus is not in a text field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < CATEGORIES.length && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        give("category", CATEGORIES[idx]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const idToNumber = useMemo(
    () => new Map([...numberToId.entries()].map(([n, id]) => [id, n])),
    [numberToId],
  );
  const dupDisplay = (v: string | null) =>
    !v || v === "none" ? "none" : v.startsWith("#") ? v : `#${idToNumber.get(v) ?? "?"}`;
  const severityValue = eff ? numeric(eff.severity) : null;
  const severityIndex =
    severityValue === null ? null : Math.round(severityValue * (SEVERITY_LEVELS.length - 1));

  if (!issue) {
    return (
      <aside className="flex h-full flex-col items-center justify-center border-l bg-background text-muted-foreground">
        {result.type === "complete" ? "This issue is not synced." : "Loading…"}
      </aside>
    );
  }
  if (!eff) return null;

  const status = issue.classifying
    ? "classifying"
    : eff.category.source === "none"
      ? "unclassified"
      : eff.category.source === "human"
        ? "human"
        : "model";
  const statusText = {
    classifying: "Classifying…",
    unclassified: issue.reclassify ? "Queued" : "Not classified",
    human: "Confirmed by a person",
    model: `Model · ${pct(eff.category.confidence)} confident`,
  }[status];
  const viewers = issue.presence.filter((p) => p.updated_at > now - PRESENCE_TTL_MS);

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
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Properties</h3>
          <dl className="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1">
            <dt className="text-xs text-muted-foreground">Status</dt>
            <dd className="flex h-7 items-center gap-2 px-2">
              <StatusIcon status={status} confidence={eff.category.confidence} />
              <span>{statusText}</span>
            </dd>

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

            <dt className="text-xs text-muted-foreground">Duplicate of</dt>
            <dd className="flex items-center gap-1">
              <input
                className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-sm hover:bg-accent focus:border-input focus:bg-background focus:outline-none"
                placeholder={dupDisplay(eff.duplicate.value)}
                aria-label="Duplicate of issue number"
                value={dupNumber}
                onChange={(e) => setDupNumber(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const n = Number(dupNumber.replace("#", ""));
                    if (!Number.isFinite(n) || n <= 0) return;
                    give("duplicate", numberToId.get(n) ?? `#${n}`);
                    setDupNumber("");
                  }
                }}
              />
              <Button
                size="xs"
                variant="outline"
                disabled={!dupNumber.trim()}
                onClick={() => {
                  const n = Number(dupNumber.replace("#", ""));
                  if (!Number.isFinite(n) || n <= 0) return;
                  give("duplicate", numberToId.get(n) ?? `#${n}`);
                  setDupNumber("");
                }}
              >
                Mark
              </Button>
              {eff.duplicate.value && eff.duplicate.value !== "none" && (
                <Button size="xs" variant="ghost" onClick={() => give("duplicate", "none")}>
                  Not a dup
                </Button>
              )}
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
            placeholder="Add a note to your next answer…"
          />
        </section>

        <section className="border-t px-4 py-3">
          <h3 className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
            <span>Model</span>
            <span className="font-normal">questions v{questionsVersion}</span>
          </h3>
          <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-3">
            {CLASSIFICATION_KINDS.map((k) => {
              const f = eff[k];
              const show = (v: string | null | undefined) =>
                k === "duplicate" ? dupDisplay(v ?? null) : (scoredName(k, v) ?? v ?? "—");
              return (
                <div key={k} className="contents">
                  <dt className="pt-px text-xs text-muted-foreground">{KIND_LABEL[k]}</dt>
                  <dd className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2 text-xs">
                      {k === "category" ? (
                        <CategoryChip
                          value={f.model?.value ?? null}
                          confidence={f.model?.confidence ?? null}
                          source={f.model ? "model" : "none"}
                        />
                      ) : (
                        <span className="font-medium">{show(f.model?.value)}</span>
                      )}
                      {f.model?.confidence != null && k !== "category" && (
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
                      highlight={scoredKey(k, f.model?.value) ?? f.model?.value ?? null}
                      format={(key) => outcomeName(k, key)}
                    />
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>

        <section className="border-t px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Description</h3>
          <div className="max-h-96 overflow-auto text-sm leading-5 whitespace-pre-wrap text-foreground/90">
            {issue.body || <span className="text-muted-foreground">No description.</span>}
          </div>
        </section>

        <section className="border-t px-4 py-3">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Activity</h3>
          {issue.feedback.length === 0 && (
            <p className="text-xs text-muted-foreground">No feedback yet.</p>
          )}
          <ul role="list" className="flex flex-col gap-2">
            {issue.feedback.map((f) => (
              <li key={f.id} className="flex items-start gap-2 text-xs">
                <Avatar name={f.user?.name ?? "?"} color={f.user?.color ?? "#999"} size="xs" />
                <div className="min-w-0">
                  <span className="font-medium">{f.user?.name ?? f.user_id}</span>
                  <span className="text-muted-foreground"> set </span>
                  {KIND_LABEL[f.kind]?.toLowerCase() ?? f.kind}
                  <span className="text-muted-foreground"> to </span>
                  <span className="font-medium">
                    {f.kind === "duplicate" ? dupDisplay(f.value) : f.value}
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
