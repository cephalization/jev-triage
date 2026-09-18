import { z } from "zod";
import type { ReviewGroup } from "./groups.ts";
import { renderPatch, type PatchFile } from "./patch.ts";
import type { ReviewIntent } from "./prompt.ts";

/**
 * The staged generation. Instead of one long serial answer, the agent first names the steps
 * (a short call), jev assigns every file to a step (one parallel request), and the agent then
 * writes each step's narrative in parallel with only that step's files in view. Every prompt
 * here is pure text in, text out; the stages are wired together in the API.
 */

export const STE_RULES = `Write in ASD-STE100 Simplified Technical English: active voice, present tense, one idea per sentence, sentences of 25 words or fewer, simple words ("start" not "initiate", "use" not "utilize"). Plain technical nouns from the codebase are fine.`;

export const STEP_ORDER_RULES = `Step 1 is the change this pull request exists to make: the one its title names, or the one the other changes exist to support. Hardening fixes, small robustness tweaks and enabling refactors that merely serve the core come AFTER it. Follow with the code that adopts or wires the core, then its tests. Mechanical churn (renames, lockfiles, generated output, formatting, import shuffles, trivial config) goes LAST in one step named for what it is (for example "Supporting changes").`;

/** A step as the skeleton names it: what it is for, before any file is placed in it. */
export const stepSkeletonSchema = z.object({
  name: z.string().min(1).max(120),
  /** One sentence: what this step does and why it exists, for whoever assigns files to it. */
  intent: z.string().min(1).max(400),
});
export type StepSkeleton = z.infer<typeof stepSkeletonSchema>;
export const skeletonSchema = z.object({ steps: z.array(stepSkeletonSchema).min(1).max(10) });

export const narrativeSchema = z.object({
  summary: z.string().min(1).max(2000),
  impact: z.string().max(1500).default(""),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocker", "concern", "note"]),
        text: z.string().min(1).max(600),
      }),
    )
    .max(8)
    .default([]),
});
export type Narrative = z.infer<typeof narrativeSchema>;

/** The first JSON object in a reply, fences and prose stripped. */
export function extractJson<T>(output: string, schema: z.ZodType<T>): T {
  let text = output.trim();
  const fenced = /^```(?:json)?\n([\s\S]*?)\n```$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("response contained no JSON object");
  return schema.parse(JSON.parse(text.slice(start, end + 1)));
}

export function renderIntent(intent: ReviewIntent): string {
  return [
    `Title: ${intent.title}`,
    `Author: ${intent.author}`,
    `Branch: ${intent.headRef} into ${intent.baseRef}`,
    intent.body.trim() ? `Description:\n${intent.body.trim()}` : null,
  ]
    .filter((l): l is string => l !== null)
    .join("\n");
}

export interface SkeletonRequest {
  intent: ReviewIntent;
  files: readonly PatchFile[];
  /** jev's ordered proposal, rendered; null when the file pass did not run. */
  classification: string | null;
  /** Steps kept from the previous review because their files did not change. */
  reusedSteps: readonly Pick<ReviewGroup, "name" | "summary" | "files">[];
  /** Paths whose bodies the skeleton need not read (jev said "skim"). */
  skimPaths: ReadonlySet<string>;
  /** The agent has repository tools (list_files, read_file, grep, rank_files). */
  tools: boolean;
}

/** Bodies for the skeleton: skim files as stubs, the rest under a smaller budget. */
export const SKELETON_BODY_BUDGET = 60_000;

export function buildSkeletonPrompt(req: SkeletonRequest, previousError: string | null): string {
  const readable = req.files.filter((f) => !req.skimPaths.has(f.path));
  const rendered = renderPatch(readable.map((f) => f.text).join(""), SKELETON_BODY_BUDGET);
  const manifest = renderPatch(req.files.map((f) => f.text).join(""), 0).manifest;
  const sections = [
    `You are planning a GUIDED code review: an ordered walkthrough that tells the story of this change. Name the steps only; another pass places every file and writes each step's text.

Rules:
- Produce 2 to 6 steps for a small change; a large one (hundreds of files) may need up to 10. Each step is a chapter, in the order the reviewer should read them.
- ${STEP_ORDER_RULES}
- Name each step like a short commit subject that says what it does, never a directory name or a vague label. ${STE_RULES}
- "intent" is one sentence for the pass that assigns files: what belongs in this step and why the step exists.
- Every changed file must have a step it can belong to, including files whose bodies are omitted below and files listed as churn.${
      req.reusedSteps.length > 0
        ? "\n- Steps under <kept> did not change since the last review and will be kept as they are, name and text included; do not rename them, and do not create a step that would take their files. List them in your answer in the position they belong."
        : ""
    }${
      req.tools
        ? "\n- You can read the repository at this pull request's head with the tools (list_files, read_file, grep, rank_files). Use them only where the diff alone does not say what a change is for, and prefer rank_files over reading many files."
        : ""
    }
- Respond with ONLY this JSON shape, no prose and no code fences:
  {"steps":[{"name":"...","intent":"..."}]}`,
    `<intent>\n${renderIntent(req.intent)}\n</intent>`,
  ];
  if (req.classification)
    sections.push(
      `<classification>\nA code pass classified each file before you and proposed this order. Treat it as a proposal: you may merge or reorder.\n${req.classification}\n</classification>`,
    );
  if (req.reusedSteps.length > 0)
    sections.push(
      `<kept>\n${JSON.stringify({ steps: req.reusedSteps.map((s) => ({ name: s.name, files: s.files })) })}\n</kept>`,
    );
  if (previousError)
    sections.push(
      `Your previous response was rejected: ${previousError}. Respond again with ONLY the JSON object.`,
    );
  sections.push(`<files>\n${manifest}\n</files>`);
  const skimmed = req.files.length - readable.length;
  const note = [
    rendered.omitted > 0 ? `${rendered.omitted} shown as stubs for budget` : null,
    skimmed > 0 ? `${skimmed} mechanical files omitted (listed in <files>)` : null,
  ].filter((x): x is string => x !== null);
  sections.push(`<diff>${note.length ? `\n(${note.join("; ")})\n` : "\n"}${rendered.diff}</diff>`);
  return sections.join("\n\n");
}

export interface NarrativeRequest {
  intent: ReviewIntent;
  step: StepSkeleton;
  /** Position and total, so the text can refer to what came before. */
  index: number;
  allSteps: readonly StepSkeleton[];
  files: readonly PatchFile[];
  /** jev's lines for these files, if any. */
  classification: string | null;
  tools: boolean;
}

export const NARRATIVE_BODY_BUDGET = 80_000;

export function buildNarrativePrompt(req: NarrativeRequest, previousError: string | null): string {
  const rendered = renderPatch(req.files.map((f) => f.text).join(""), NARRATIVE_BODY_BUDGET);
  const sections = [
    `You are reviewing one step of a pull request as a senior engineer, for a colleague who has NOT opened the diff. Your job is to do the review, not to tell them where to look. Telling the reader to "read this first" or "check X" is a failure; say what you found.

Write three parts:
1. "summary", 3 to 6 sentences: what this step changes and how it works. Name the mechanism: the new state, contract, data flow or algorithm, and how the pieces connect. Say why this approach, and what behaviour changes for callers or users. Do not narrate the diff line by line.
2. "impact", 1 to 3 sentences: what else this touches. Which callers, contracts, data, configuration or tests depend on what changed, and whether they were updated. Say "nothing outside this step" when that is true.${
      req.tools
        ? " Use grep to find the callers and definitions of changed symbols and read_file to see how they use them; report what you found, not what you assume. rank_files picks the few files worth reading when grep returns many."
        : ""
    }
3. "findings", 0 to 6 items, most important first: the concrete observations you would leave as review comments. A bug, a missing case, an invariant that can break, a contract that changed without its callers, a missing or weak test, a name or an API that will mislead. Each names the file and the symbol or line it is about, and says why it matters. severity "blocker" for what must change before merge, "concern" for what deserves a reply, "note" for what the author should know. An empty list is fine when the step is clean; say so in the summary.

Rules:
- ${STE_RULES}
- Stay inside this step; the other steps are listed so you can refer to them by name without repeating them.
- Never invent what an omitted body contains; reason from its path, status, counts and the intent.
- Respond with ONLY this JSON shape, no prose and no code fences:
  {"summary":"...","impact":"...","findings":[{"severity":"concern","text":"..."}]}`,
    `<intent>\n${renderIntent(req.intent)}\n</intent>`,
    `<steps>\n${req.allSteps.map((s, i) => `${i + 1}. ${s.name}${i === req.index ? " (this step)" : ""}: ${s.intent}`).join("\n")}\n</steps>`,
    `<step>\n${req.index + 1}. ${req.step.name}\n${req.step.intent}\n</step>`,
  ];
  if (req.classification)
    sections.push(`<classification>\n${req.classification}\n</classification>`);
  if (previousError)
    sections.push(
      `Your previous response was rejected: ${previousError}. Respond again with ONLY the JSON object.`,
    );
  sections.push(`<files>\n${rendered.manifest}\n</files>`);
  sections.push(`<diff>\n${rendered.diff}</diff>`);
  return sections.join("\n\n");
}

/** Ask once, and once more with the validation error folded in if the shape was wrong. */
export async function askJson<T>(
  build: (previousError: string | null) => string,
  schema: z.ZodType<T>,
  ask: (prompt: string) => Promise<string>,
): Promise<T> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = await ask(build(lastError));
    try {
      return extractJson(output, schema);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`output failed validation: ${lastError ?? "unknown"}`);
}
