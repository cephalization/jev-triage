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
import { ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { ago, pct } from "../lib/format.ts";
import { PRESENCE_TTL_MS } from "../lib/presence.ts";
import { Avatar } from "./Avatar.tsx";
import { CategoryChip, ProbBars } from "./Marks.tsx";
import { Badge } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Label } from "./ui/label.tsx";
import { ScrollArea } from "./ui/scroll-area.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select.tsx";
import { Separator } from "./ui/separator.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet.tsx";
import { Textarea } from "./ui/textarea.tsx";

const NONE = "__none__";

export function IssueDrawer({
  issueId,
  questionsVersion,
  areaLabels,
  numberToId,
  onClose,
  now,
}: {
  issueId: string | null;
  questionsVersion: number;
  areaLabels: readonly string[];
  numberToId: Map<number, string>;
  onClose: () => void;
  now: number;
}) {
  const z = useZero();
  const [issue, result] = useQuery(issueId ? queries.issues.byId(issueId) : undefined);
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

  const idToNumber = useMemo(
    () => new Map([...numberToId.entries()].map(([n, id]) => [id, n])),
    [numberToId],
  );
  const dupDisplay = (v: string | null) =>
    !v || v === "none" ? "none" : v.startsWith("#") ? v : `#${idToNumber.get(v) ?? "?"}`;
  const severityValue = eff ? numeric(eff.severity) : null;
  const severityIndex =
    severityValue === null ? null : Math.round(severityValue * (SEVERITY_LEVELS.length - 1));

  return (
    <Sheet open={issueId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-2xl">
        {!issue && result.type === "complete" && (
          <SheetHeader>
            <SheetTitle>Not found</SheetTitle>
            <SheetDescription>This issue is not synced.</SheetDescription>
          </SheetHeader>
        )}
        {issue && eff && (
          <>
            <SheetHeader className="pr-10">
              <SheetTitle className="leading-snug">
                <span className="mr-2 text-muted-foreground">#{issue.number}</span>
                {issue.title}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
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
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-1">
                {issue.labels_json.map((l) => (
                  <Badge key={l} variant="secondary" className="font-normal">
                    {l}
                  </Badge>
                ))}
                <span className="ml-auto flex -space-x-1">
                  {issue.presence
                    .filter((p) => p.updated_at > now - PRESENCE_TTL_MS)
                    .map((p) => (
                      <Avatar
                        key={p.user_id}
                        name={p.name}
                        color={p.color}
                        hint={`${p.name} is here`}
                      />
                    ))}
                </span>
              </div>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1 px-4">
              <section className="py-3">
                <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Body</h3>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-sans text-sm">
                  {issue.body || "(empty)"}
                </pre>
              </section>
              <Separator />
              <section className="py-3">
                <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                  Model answers · v{questionsVersion}
                </h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  {CLASSIFICATION_KINDS.map((k) => {
                    const f = eff[k];
                    return (
                      <div key={k} className="rounded-md border p-2">
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="font-medium">{k.replace("_", " ")}</span>
                          <span className="text-muted-foreground">
                            {f.source === "human"
                              ? `human: ${k === "duplicate" ? dupDisplay(f.value) : f.value}`
                              : f.source === "model"
                                ? `conf ${pct(f.confidence)}`
                                : "—"}
                          </span>
                        </div>
                        <ProbBars
                          probabilities={f.probabilities}
                          highlight={f.model?.value ?? null}
                        />
                        {f.disagreement && (
                          <p className="mt-1 text-[11px] text-destructive">
                            model said{" "}
                            {k === "duplicate"
                              ? dupDisplay(f.model?.value ?? null)
                              : f.model?.value}
                            , human said {k === "duplicate" ? dupDisplay(f.value) : f.value}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
              <Separator />
              <section className="py-3">
                <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                  Your feedback
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex flex-col gap-1">
                    <Label>Category</Label>
                    <Select
                      value={eff.category.value ?? NONE}
                      onValueChange={(v) => v !== NONE && give("category", v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Set category" />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map((c) => (
                          <SelectItem key={c} value={c}>
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
                        placeholder={`current: ${dupDisplay(eff.duplicate.value)}`}
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
                    <Label>Note (attached to the next answer you give)</Label>
                    <Textarea
                      rows={2}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Why?"
                    />
                  </div>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Feedback wins immediately for everyone; the model's rows stay for comparison and
                  the issue is queued for recalculation.
                </p>
              </section>
              <Separator />
              <section className="py-3">
                <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                  History
                </h3>
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
              <section className="py-3">
                <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                  Current
                </h3>
                <CategoryChip
                  value={eff.category.value}
                  confidence={eff.category.confidence}
                  source={eff.category.source}
                />
              </section>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
