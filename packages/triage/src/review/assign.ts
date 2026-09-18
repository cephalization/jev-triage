import { choice } from "@typesafe-ai/sdk";
import type { ChoiceResponse, Questions } from "@typesafe-ai/sdk";
import { excerptOf, type ClassifiedFile } from "./files.ts";
import type { ReviewGroup } from "./groups.ts";
import type { PatchFile } from "./patch.ts";
import type { ReviewIntent } from "./prompt.ts";
import type { StepSkeleton } from "./stages.ts";

/**
 * jev places every changed file in one of the steps the skeleton named. One Choice per file
 * over the step names, all in one request, so a hundred files take one round trip. The agent
 * never spends output tokens on bookkeeping again.
 */

export const NONE_STEP = "none";
export const SWEEP_STEP: Pick<ReviewGroup, "name" | "summary"> = {
  name: "Supporting changes",
  summary: "Generated output, lockfiles, formatting and configuration. Skim these.",
};

export const FILES_PER_ASSIGN_REQUEST = 24;

export function buildAssignState(
  intent: ReviewIntent,
  steps: readonly StepSkeleton[],
  files: readonly PatchFile[],
) {
  return {
    pull_request: { title: intent.title, description: intent.body.slice(0, 1000) },
    steps: steps.map((s, i) => ({ number: i + 1, name: s.name, intent: s.intent })),
    files: files.map((f) => ({
      path: f.path,
      status: f.status === "A" ? "added" : f.status === "D" ? "deleted" : "modified",
      added_lines: f.added,
      removed_lines: f.removed,
      diff_excerpt: excerptOf(f, 800),
    })),
  };
}

export const stepKey = (i: number) => `step_${i + 1}`;

export function buildAssignQuestions(count: number, steps: readonly StepSkeleton[]): Questions {
  const criteria: Record<string, string> = {};
  steps.forEach((s, i) => {
    criteria[stepKey(i)] = `${s.name}: ${s.intent}`;
  });
  criteria[NONE_STEP] = "No step fits: mechanical churn none of the steps is about";
  const questions: Record<string, ReturnType<typeof choice>> = {};
  for (let i = 0; i < count; i += 1) {
    questions[`s${i}__step`] = choice(
      {
        question: `Which step of the review does \`files[${i}]\` belong to? Judge from its path and diff_excerpt against each step's intent and the pull_request.`,
        notes:
          "Exactly one step. A file belongs with the step it matters to most; a test belongs with the step that tests it only when there is no tests step. Prefer a named step over none.",
      },
      criteria,
    );
  }
  return questions as Questions;
}

export interface StepAssignment {
  /** Index into the steps, or null for none. */
  step: number | null;
  confidence: number | null;
}

export function foldAssignments(
  answers: Readonly<Record<string, ChoiceResponse>>,
  count: number,
): StepAssignment[] {
  const out: StepAssignment[] = Array.from({ length: count }, () => ({
    step: null,
    confidence: null,
  }));
  for (const [key, answer] of Object.entries(answers)) {
    const m = /^s(\d+)__step$/.exec(key);
    if (!m) continue;
    const i = Number(m[1]);
    if (i >= count) continue;
    const s = /^step_(\d+)$/.exec(String(answer.choice));
    out[i] = { step: s ? Number(s[1]) - 1 : null, confidence: answer.confidence };
  }
  return out;
}

/**
 * Groups from the skeleton plus the assignments. Files jev could not place, and files with no
 * answer, go to the sweep step (created at the end when needed). Empty steps disappear; the
 * skeleton may have named a step no file belongs to.
 */
export function groupsFromAssignments(
  steps: readonly StepSkeleton[],
  files: readonly PatchFile[],
  assignments: readonly StepAssignment[],
  classified: readonly ClassifiedFile[] = [],
): { name: string; summary: string; files: string[] }[] {
  const byPath = new Map(classified.map((c) => [c.path, c]));
  const members: string[][] = steps.map(() => []);
  const swept: string[] = [];
  files.forEach((f, i) => {
    const a = assignments[i];
    if (a && a.step !== null && a.step < steps.length) members[a.step]!.push(f.path);
    else swept.push(f.path);
  });
  const out = steps
    .map((s, i) => ({ name: s.name, summary: "", files: sortForReading(members[i]!, byPath) }))
    .filter((g) => g.files.length > 0);
  if (swept.length > 0) {
    const existing = out.find((g) => g.name === SWEEP_STEP.name);
    if (existing) existing.files.push(...sortForReading(swept, byPath));
    else out.push({ ...SWEEP_STEP, files: sortForReading(swept, byPath) });
  }
  return out;
}

/** Within a step: entry points first, then the riskiest, so the first diff shown is the one to read. */
function sortForReading(paths: string[], byPath: Map<string, ClassifiedFile>): string[] {
  return [...paths].sort((a, b) => {
    const sa = byPath.get(a)?.signal;
    const sb = byPath.get(b)?.signal;
    const ea = (sa?.entry ?? 0) >= 0.6 ? 1 : 0;
    const eb = (sb?.entry ?? 0) >= 0.6 ? 1 : 0;
    if (ea !== eb) return eb - ea;
    const r = (sb?.risk ?? 0) - (sa?.risk ?? 0);
    if (Math.abs(r) > 0.05) return r;
    return a.localeCompare(b);
  });
}
