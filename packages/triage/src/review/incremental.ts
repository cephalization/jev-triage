import { noul } from "@typesafe-ai/sdk";
import type { NoulResponse, Questions } from "@typesafe-ai/sdk";
import { excerptOf } from "./files.ts";
import type { ReviewGroup } from "./groups.ts";
import type { PatchFile } from "./patch.ts";

/**
 * Regeneration keeps what did not change. A previous step whose files all carry the same hunks
 * now is reused whole: name, text and the marks people put on it. Files whose hunks differ only
 * by line offsets, whitespace or a rebase are judged by jev so they do not force a rewrite.
 */

export interface ChangedFile {
  path: string;
  before: PatchFile;
  after: PatchFile;
}

/** Files whose hunk text differs between two patches (same path on both sides). */
export function changedFiles(
  previous: readonly PatchFile[],
  current: readonly PatchFile[],
): ChangedFile[] {
  const before = new Map(previous.map((f) => [f.path, f]));
  const out: ChangedFile[] = [];
  for (const f of current) {
    const b = before.get(f.path);
    if (b && stripOffsets(b.text) !== stripOffsets(f.text))
      out.push({ path: f.path, before: b, after: f });
  }
  return out;
}

/** Hunk headers move with every rebase; compare the bodies. */
export function stripOffsets(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.startsWith("@@") && !l.startsWith("index "))
    .join("\n");
}

export function buildChangeState(changes: readonly ChangedFile[]) {
  return {
    files: changes.map((c) => ({
      path: c.path,
      previous_diff: excerptOf(c.before, 1500),
      current_diff: excerptOf(c.after, 1500),
    })),
  };
}

export function buildChangeQuestions(count: number): Questions {
  const questions: Record<string, ReturnType<typeof noul>> = {};
  for (let i = 0; i < count; i += 1)
    questions[`c${i}__material`] = noul(
      `Does current_diff of \`files[${i}]\` change what a reviewer must understand, compared with previous_diff?`,
      {
        true: "New or different logic, conditions, data flow, names or behaviour",
        false:
          "Only line offsets, whitespace, comments, formatting, or the same change rebased onto other code",
      },
    );
  return questions as Questions;
}

export function foldChanges(answers: Readonly<Record<string, NoulResponse>>, count: number) {
  const out: (number | null)[] = Array.from({ length: count }, () => null);
  for (const [key, a] of Object.entries(answers)) {
    const m = /^c(\d+)__material$/.exec(key);
    if (m && Number(m[1]) < count) out[Number(m[1])] = a.noul;
  }
  return out;
}

/** A change jev is less sure than this about counts as material; better a rewrite than a stale text. */
export const MATERIAL = 0.35;

/**
 * Which previous steps survive: every file still present, none materially changed, and no
 * file added to the pull that jev later places in them (the caller drops those).
 */
export function reusableSteps(
  previousGroups: readonly ReviewGroup[],
  currentPaths: ReadonlySet<string>,
  materiallyChanged: ReadonlySet<string>,
): ReviewGroup[] {
  return previousGroups.filter(
    (g) =>
      g.summary.trim() !== "" &&
      g.files.every((f) => currentPaths.has(f) && !materiallyChanged.has(f)),
  );
}
