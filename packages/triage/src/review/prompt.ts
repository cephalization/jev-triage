import { type ReviewGroup, extractReviewResult, type ReviewResult } from "./groups.ts";
import { renderPatch } from "./patch.ts";

/** What the reviewer's colleague knows going in. */
export interface ReviewIntent {
  title: string;
  /** Pull request description, already trimmed to a sensible length. */
  body: string;
  author: string;
  headRef: string;
  baseRef: string;
}

export interface ReviewRequest {
  patch: string;
  intent: ReviewIntent;
  /** Groups from the previous review of this pull, so unchanged steps keep their names. */
  previousGroups: readonly ReviewGroup[] | null;
  /**
   * A code-produced ordering proposal (phase 4 fills this from jev's per-file answers). The
   * model may merge or reorder but must place every file.
   */
  classification?: string | null;
}

export const RULES = `You are writing a GUIDED code review: an ordered walkthrough that tells the story of this change before the reviewer opens a single file. You are the reviewer's senior colleague explaining how the change works and why, not a changelog generator and not an index of files to look at.

Rules:
- Produce 2 to 6 steps ("groups") for a small change; a large one (hundreds of files) may need up to 10. Prefer one more real step over a catch-all. Each step is a chapter of the review in the order the reviewer should read them.
- Step 1 is the change this pull request exists to make: the one its title names, or the one the other changes exist to support. Hardening fixes, small robustness tweaks and enabling refactors that merely serve the core come AFTER it; a two-file fix is never step 1 of a large change. Follow with the code that adopts or wires the core, then its tests. Mechanical churn (renames, lockfiles, generated output, formatting, import shuffles, trivial config) goes LAST in one step named for what it is (for example "Supporting changes") so the reviewer can skim it.
- Write step names and summaries in ASD-STE100 Simplified Technical English: active voice, present tense, one idea per sentence, sentences of 25 words or fewer, simple words ("start" not "initiate", "use" not "utilize"). Plain technical nouns from the codebase are fine.
- Name each step like a short commit subject that says what it does, never a directory name or a vague label.
- Each summary is 3 to 5 sentences for a reviewer who has NOT opened the diff. Explain the change first: the problem this step solves, how the new code works (the mechanism: the new state, contract, data flow or algorithm, and how the pieces connect) and why this approach. Only then say what to scrutinize: the invariant that must hold, the edge case that could break, the decision worth questioning. A summary that is only directions ("review X", "check Y") is a failure. Do not narrate the diff line by line.
- <files> lists EVERY changed file with its status (A added, M modified, D deleted) and line counts, and is never truncated. Every one of those files appears in exactly one step, with the path exactly as listed, including files whose body is omitted. Group body-less files by path, status and the step whose area they belong to; a deleted file belongs with the step that retires or replaces it.
- In <diff>, an omitted body is marked with a stub line. Never invent what an omitted body contains; reason from its path, status, counts and the intent.
- Keep one behaviour's source, wiring and config together in one step; a file belongs with the step it matters to most.
- Respond with ONLY this JSON shape, no prose and no code fences:
  {"groups":[{"name":"...","summary":"...","files":["path/one.ts"]}]}`;

export function buildReviewPrompt(req: ReviewRequest, previousError: string | null): string {
  const rendered = renderPatch(req.patch);
  const intent = [
    `Title: ${req.intent.title}`,
    `Author: ${req.intent.author}`,
    `Branch: ${req.intent.headRef} into ${req.intent.baseRef}`,
    req.intent.body.trim() ? `Description:\n${req.intent.body.trim()}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
  const sections = [RULES, `<intent>\n${intent}\n</intent>`];
  if (req.classification)
    sections.push(
      `<classification>\nA code pass classified each file before you. Treat it as a proposal for order and grouping: you may merge or reorder, but place every file.\n${req.classification}\n</classification>`,
    );
  if (req.previousGroups && req.previousGroups.length > 0)
    sections.push(
      `<previous-groups>\nA prior review grouped this change as follows. Keep the names and membership of steps whose files did not change; the reviewers' progress marks are keyed to them. A prior step that breaks the rules above (a catch-all, churn mixed into a behavioural step, a supporting fix ahead of the core) is fair to restructure.\n${JSON.stringify({ groups: req.previousGroups })}\n</previous-groups>`,
    );
  if (previousError)
    sections.push(
      `Your previous response was rejected: ${previousError}. Respond again with ONLY the JSON object.`,
    );
  sections.push(`<files>\n${rendered.manifest}\n</files>`);
  const note =
    rendered.omitted > 0
      ? `\n(${rendered.omitted} file${rendered.omitted === 1 ? "" : "s"} shown as stubs; all are listed in <files> and must still be grouped.)\n`
      : "\n";
  sections.push(`<diff>${note}${rendered.diff}</diff>`);
  return sections.join("\n\n");
}

/** Ask once, and once more with the validation error folded in if the shape was wrong. */
export async function generateReview(
  req: ReviewRequest,
  ask: (prompt: string) => Promise<string>,
): Promise<ReviewResult> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = await ask(buildReviewPrompt(req, lastError));
    try {
      return extractReviewResult(output);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`review output failed validation: ${lastError ?? "unknown"}`);
}
