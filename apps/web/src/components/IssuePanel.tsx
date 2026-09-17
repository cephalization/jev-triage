import { useQuery, useZero } from "@rocicorp/zero/react";
import {
  CATEGORIES,
  CLASSIFICATION_KINDS,
  effectiveIssue,
  mutators,
  numeric,
  queries,
} from "@triage/schema";
import { SEVERITY_LEVELS } from "@triage/triage/types";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ago, pct } from "../lib/format.ts";
import { PRESENCE_TTL_MS } from "../lib/presence.ts";
import { Avatar } from "./Avatar.tsx";
import { CategoryChip, ProbBars } from "./Marks.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Label } from "./ui/label.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Separator } from "./ui/separator.tsx";
import { Textarea } from "./ui/textarea.tsx";

const NONE = "__none__";

/**
 * Non-modal details panel (split view, Linear-style). The table stays live and clickable;
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
      <aside className="flex h-full flex-col border-l bg-background p-4 text-sm text-muted-foreground">
        {result.type === "complete" ? "This issue is not synced." : "Loading…"}
      </aside>
    );
  }
  if (!eff) return null;

  return (
    <aside className="flex h-full min-h-0 flex-col border-l bg-background">
      <div className="flex items-start gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold leading-snug">
            <span className="mr-2 text-muted-foreground">#{issue.number}</span>
            {issue.title}
          </h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{issue.author}</span>
            <span>· {issue.state}</span>
            <span>· {issue.comments} comments</span>
            <span>· {issue.reactions} reactions</span>
            <span>· opened {ago(issue.created_at, now)}</span>
            <a
              className="inline-flex items-center gap-1 underline"
              href={issue.url}
              target="_blank"
              rel="noreferrer"
            >
              GitHub <ExternalLink className="size-3" />
            </a>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {issue.labels_json.map((l) => (
              <Badge key={l} variant="secondary" className="font-normal">
                {l}
              </Badge>
            ))}
            <CategoryChip
              value={eff.category.value}
              confidence={eff.category.confidence}
              source={eff.category.source}
            />
            {issue.classifying && (
              <Badge variant="outline" className="animate-pulse">
                classifying…
              </Badge>
            )}
            {issue.reclassify && !issue.classifying && <Badge variant="outline">queued</Badge>}
          </div>
        </div>
        <span className="flex -space-x-1">
          {issue.presence
            .filter((p) => p.updated_at > now - PRESENCE_TTL_MS)
            .map((p) => (
              <Avatar key={p.user_id} name={p.name} color={p.color} hint={`${p.name} is here`} />
            ))}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close (Esc)">
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <section className="py-3">
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Your call</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label>
                Category <span className="font-normal text-muted-foreground">(keys 1–6)</span>
              </Label>
              <Select
                value={eff.category.value ?? NONE}
                onValueChange={(v) => v !== NONE && give("category", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Set category" />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c, i) => (
                    <SelectItem key={c} value={c}>
                      <span className="mr-2 text-muted-foreground">{i + 1}</span>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Area</Label>
              <Select
                value={eff.area.value ?? NONE}
                onValueChange={(v) => give("area", v === NONE ? "none" : v)}
              >
                <SelectTrigger>
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
            </div>
            <div className="flex flex-col gap-1">
              <Label>Severity</Label>
              <Select
                value={severityIndex === null ? NONE : String(severityIndex)}
                onValueChange={(v) =>
                  v !== NONE &&
                  give("severity", (Number(v) / (SEVERITY_LEVELS.length - 1)).toFixed(4))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Set severity" />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITY_LEVELS.map((s, i) => (
                    <SelectItem key={s} value={String(i)}>
                      {i} · {s.split(":")[0]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Duplicate of</Label>
              <div className="flex gap-1">
                <input
                  className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                  placeholder={`now: ${dupDisplay(eff.duplicate.value)}`}
                  value={dupNumber}
                  onChange={(e) => setDupNumber(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const n = Number(dupNumber.replace("#", ""));
                    if (!Number.isFinite(n) || n <= 0) return;
                    give("duplicate", numberToId.get(n) ?? `#${n}`);
                    setDupNumber("");
                  }}
                >
                  Mark
                </Button>
                <Button size="sm" variant="ghost" onClick={() => give("duplicate", "none")}>
                  Not a dup
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Optional note, attached to your next answer"
              />
            </div>
          </div>
        </section>
        <Separator />
        <section className="py-3">
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
            Model · v{questionsVersion}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {CLASSIFICATION_KINDS.map((k) => {
              const f = eff[k];
              return (
                <div key={k} className="rounded-md border p-2">
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="font-medium">{k.replace("_", " ")}</span>
                    <span className="text-muted-foreground">
                      {f.source === "human"
                        ? `you/humans: ${k === "duplicate" ? dupDisplay(f.value) : f.value}`
                        : f.source === "model"
                          ? `conf ${pct(f.confidence)}`
                          : "—"}
                    </span>
                  </div>
                  <ProbBars probabilities={f.probabilities} highlight={f.model?.value ?? null} />
                  {f.disagreement && (
                    <p className="mt-1 text-[11px] text-destructive">
                      model said{" "}
                      {k === "duplicate" ? dupDisplay(f.model?.value ?? null) : f.model?.value},
                      human said {k === "duplicate" ? dupDisplay(f.value) : f.value}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
        <Separator />
        <section className="py-3">
          <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Body</h3>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-sans text-sm">
            {issue.body || "(empty)"}
          </pre>
        </section>
        <Separator />
        <section className="py-3">
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">History</h3>
          {issue.feedback.length === 0 && (
            <p className="text-xs text-muted-foreground">No feedback yet.</p>
          )}
          <ul className="flex flex-col gap-2">
            {issue.feedback.map((f) => (
              <li key={f.id} className="flex items-start gap-2 text-xs">
                <Avatar name={f.user?.name ?? "?"} color={f.user?.color ?? "#999"} />
                <div>
                  <span className="font-medium">{f.user?.name ?? f.user_id}</span> set{" "}
                  <span className="font-medium">{f.kind.replace("_", " ")}</span> to{" "}
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
