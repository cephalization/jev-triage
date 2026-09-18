import { choice, noul, score } from "@typesafe-ai/sdk";
import type { ChoiceResponse, NoulResponse, Questions, ScoreResponse } from "@typesafe-ai/sdk";
import type { ReviewGroup } from "./groups.ts";
import type { PatchFile } from "./patch.ts";
import type { ReviewIntent } from "./prompt.ts";

/**
 * jev over the diff. The agent writes the narrative; System One supplies structure it can rely
 * on, cheaply and reproducibly: per changed file, what role it plays in the change, how risky
 * it is, how closely a reviewer must read it, and whether understanding starts here. Code turns
 * those answers into an ordered proposal the agent receives as <classification>, and into a
 * complete review of its own when the agent fails.
 *
 * Bump when a question changes meaning or a family is added or removed. Independent of the
 * issue and pull versions: file rows belong to one review and are never re-asked.
 */
export const REVIEW_FILE_QUESTIONS_VERSION = 1;

export const FILE_ROLES = {
  core: "The change this pull request exists to make: new behaviour, the fix, the algorithm or contract the title names",
  supporting:
    "Code changed so the core can land: call sites adopting it, wiring, plumbing, small refactors, type changes",
  tests: "Test code or fixtures",
  docs: "Documentation, comments-only changes, changelogs, READMEs",
  config:
    "Configuration, build, CI, dependency manifests, tooling and environment files (not lockfiles)",
  generated:
    "Generated or vendored output, lockfiles, snapshots, minified bundles, compiled assets",
  formatting: "Formatting, renames, import reordering or whitespace only; behaviour is unchanged",
} as const;
export type FileRole = keyof typeof FILE_ROLES;
export const FILE_ROLE_ORDER = Object.keys(FILE_ROLES) as FileRole[];

/** Ordered rubric: what could go wrong if this file's change is wrong. Situations, not degrees. */
export const FILE_RISK_LEVELS = [
  "Nothing user-visible can break: text, comments, formatting, generated output, test-only code",
  "A localised bug in one feature that tests or a quick check would catch",
  "A bug that changes behaviour for many callers or is hard to notice: shared logic, error handling, defaults",
  "Data loss, security, concurrency, migrations, money, or an interface others depend on",
] as const;

/** Ordered rubric: how a reviewer should read this file. */
export const FILE_ATTENTION_LEVELS = [
  "Skim the header: the diff is mechanical or generated and the counts say enough",
  "Read once: straightforward change that follows from the rest",
  "Read carefully: new logic, conditions or state whose correctness is not obvious from the diff alone",
] as const;

export const FILE_FAMILIES = ["role", "risk", "attention", "entry"] as const;
export type FileFamily = (typeof FILE_FAMILIES)[number];

/** Files per System One request; state carries a body excerpt per file, so keep batches small. */
export const FILES_PER_REQUEST = 16;
export const FILE_EXCERPT_CHARS = 1200;

export function buildFileState(intent: ReviewIntent, files: readonly PatchFile[]) {
  return {
    pull_request: {
      title: intent.title,
      description: intent.body.slice(0, 1500),
      branch: `${intent.headRef} into ${intent.baseRef}`,
      changed_files: files.length,
    },
    files: files.map((f) => ({
      path: f.path,
      status: f.status === "A" ? "added" : f.status === "D" ? "deleted" : "modified",
      added_lines: f.added,
      removed_lines: f.removed,
      diff_excerpt: excerptOf(f),
    })),
  };
}

/** The hunk text after the headers, cut to a budget, so the model sees code and not only paths. */
export function excerptOf(f: PatchFile, chars = FILE_EXCERPT_CHARS): string {
  const at = f.text.indexOf("\n@@");
  const body = at === -1 ? "" : f.text.slice(at + 1);
  return body.length > chars
    ? `${body.slice(0, chars)}\n… (${body.length - chars} more chars)`
    : body;
}

export function fileQuestionKey(index: number, family: FileFamily): string {
  return `f${index}__${family}`;
}

export function parseFileKey(key: string): { index: number; family: FileFamily } | null {
  const m = /^f(\d+)__([a-z]+)$/.exec(key);
  if (!m) return null;
  const family = m[2] as FileFamily;
  if (!FILE_FAMILIES.includes(family)) return null;
  return { index: Number(m[1]), family };
}

export function buildFileQuestions(count: number): Questions {
  const questions: Record<string, ReturnType<typeof choice | typeof score | typeof noul>> = {};
  for (let i = 0; i < count; i += 1) {
    const path = `\`files[${i}]\``;
    questions[fileQuestionKey(i, "role")] = choice(
      {
        question: `What role does ${path} play in this pull request? Judge from its path, status, line counts and diff_excerpt against the pull_request title and description.`,
        notes:
          "Exactly one role. A file is core only if the pull request exists to make its change; code that adopts or wires the core is supporting. Lockfiles and snapshots are generated even when large.",
      },
      FILE_ROLES,
    );
    questions[fileQuestionKey(i, "risk")] = score(
      {
        question: `If the change in ${path} is wrong, what is the worst plausible consequence? Judge from the diff_excerpt and path.`,
        notes:
          "Judge the blast radius of this file alone, not the pull request as a whole. A deleted file carries the risk of what depended on it.",
      },
      FILE_RISK_LEVELS,
    );
    questions[fileQuestionKey(i, "attention")] = score(
      {
        question: `How should a reviewer read ${path}?`,
        notes:
          "Size is only a hint: a large mechanical diff is a skim; a ten-line change to a condition may need careful reading.",
      },
      FILE_ATTENTION_LEVELS,
    );
    questions[fileQuestionKey(i, "entry")] = noul(
      `Does understanding this pull request start with ${path}? True when a reviewer who reads this file first will understand what the other files are for.`,
      {
        true: "This file defines the new behaviour, type, contract or algorithm the other changes serve",
        false: "This file follows from something defined elsewhere, or is churn",
      },
    );
  }
  return questions as Questions;
}

export interface FileAnswers {
  role?: ChoiceResponse;
  risk?: ScoreResponse;
  attention?: ScoreResponse;
  entry?: NoulResponse;
}

export function foldFileAnswers(
  answers: Readonly<Record<string, ChoiceResponse | ScoreResponse | NoulResponse>>,
  count: number,
): FileAnswers[] {
  const out: FileAnswers[] = Array.from({ length: count }, () => ({}));
  for (const [key, answer] of Object.entries(answers)) {
    const parsed = parseFileKey(key);
    if (!parsed || parsed.index >= count) continue;
    const target = out[parsed.index] as Record<string, unknown>;
    target[parsed.family] = answer;
  }
  return out;
}

/** What code keeps of the answers: normalised to 0..1 so thresholds read the same everywhere. */
export interface FileSignal {
  role: FileRole;
  roleConfidence: number | null;
  /** 0..1 over FILE_RISK_LEVELS. */
  risk: number | null;
  /** 0..1 over FILE_ATTENTION_LEVELS. */
  attention: number | null;
  /** Probability that the review starts here. */
  entry: number | null;
  probabilities: Record<string, Record<string, number>>;
}

const unit = (s: ScoreResponse | undefined, levels: number): number | null =>
  s ? Math.min(1, Math.max(0, s.score / (levels - 1))) : null;

export function decideFile(a: FileAnswers): FileSignal {
  const role =
    a.role && (a.role.choice as string) in FILE_ROLES ? (a.role.choice as FileRole) : "supporting";
  return {
    role,
    roleConfidence: a.role?.confidence ?? null,
    risk: unit(a.risk, FILE_RISK_LEVELS.length),
    attention: unit(a.attention, FILE_ATTENTION_LEVELS.length),
    entry: a.entry?.noul ?? null,
    probabilities: {
      ...(a.role ? { role: a.role.probabilities as Record<string, number> } : {}),
      ...(a.risk ? { risk: a.risk.probabilities as Record<string, number> } : {}),
      ...(a.attention ? { attention: a.attention.probabilities as Record<string, number> } : {}),
    },
  };
}

export interface ClassifiedFile {
  path: string;
  status: PatchFile["status"];
  added: number;
  removed: number;
  signal: FileSignal;
}

/** A file the review should open with: the model says so, or it is core and risky. */
export const ENTRY_POINT = 0.6;

/** Where each role lands in the walkthrough; lower reads first. */
const ROLE_RANK: Record<FileRole, number> = {
  core: 0,
  supporting: 1,
  tests: 2,
  docs: 3,
  config: 4,
  generated: 5,
  formatting: 5,
};

const SEED_STEPS: { rank: number; name: string; summary: string }[] = [
  {
    rank: 0,
    name: "The core change",
    summary:
      "The files that make the change this pull request exists for. Read these first; the rest of the change serves them.",
  },
  {
    rank: 1,
    name: "Code that adopts the change",
    summary: "Call sites, wiring and small refactors that let the core land.",
  },
  { rank: 2, name: "Tests", summary: "Tests and fixtures for the change." },
  { rank: 3, name: "Documentation", summary: "Documentation and comment changes." },
  {
    rank: 4,
    name: "Configuration and build",
    summary: "Configuration, dependency manifests, build and CI changes.",
  },
  {
    rank: 5,
    name: "Supporting changes",
    summary: "Generated output, lockfiles, formatting and renames. Skim these.",
  },
];

/** Within a step: entry points first, then the riskiest, then the ones to read most carefully. */
export function compareFiles(a: ClassifiedFile, b: ClassifiedFile): number {
  const ea = (a.signal.entry ?? 0) >= ENTRY_POINT ? 1 : 0;
  const eb = (b.signal.entry ?? 0) >= ENTRY_POINT ? 1 : 0;
  if (ea !== eb) return eb - ea;
  const r = (b.signal.risk ?? 0) - (a.signal.risk ?? 0);
  if (Math.abs(r) > 0.05) return r;
  const t = (b.signal.attention ?? 0) - (a.signal.attention ?? 0);
  if (Math.abs(t) > 0.05) return t;
  return a.path.localeCompare(b.path);
}

/**
 * The ordered proposal from the answers alone: core first, adoption next, tests, docs, config,
 * churn last. Used as the agent's <classification> and served as the review when the agent
 * fails, so a review always exists.
 */
export function groupSeed(files: readonly ClassifiedFile[]): ReviewGroup[] {
  const byRank = new Map<number, ClassifiedFile[]>();
  for (const f of files) {
    const rank = ROLE_RANK[f.signal.role];
    byRank.set(rank, [...(byRank.get(rank) ?? []), f]);
  }
  const out: ReviewGroup[] = [];
  for (const step of SEED_STEPS) {
    const members = byRank.get(step.rank);
    if (!members || members.length === 0) continue;
    out.push({
      name: step.name,
      summary: step.summary,
      files: [...members].sort(compareFiles).map((f) => f.path),
    });
  }
  return out;
}

const riskName = (v: number | null) =>
  v === null ? "unknown" : ["low", "moderate", "high", "critical"][Math.round(v * 3)]!;
const attentionName = (v: number | null) =>
  v === null ? "unknown" : ["skim", "read", "read carefully"][Math.round(v * 2)]!;

/** The proposal as the agent reads it: one line per file in the proposed order, with the why. */
export function renderClassification(files: readonly ClassifiedFile[]): string {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const lines: string[] = [];
  let n = 0;
  for (const g of groupSeed(files)) {
    lines.push(`## ${g.name}`);
    for (const path of g.files) {
      const f = byPath.get(path)!;
      n += 1;
      const s = f.signal;
      const flags = [
        `role ${s.role}${s.roleConfidence !== null ? ` (${Math.round(s.roleConfidence * 100)}%)` : ""}`,
        `risk ${riskName(s.risk)}`,
        `attention ${attentionName(s.attention)}`,
        (s.entry ?? 0) >= ENTRY_POINT ? "entry point" : null,
      ].filter((x): x is string => x !== null);
      lines.push(`${n}. ${path}: ${flags.join(", ")}`);
    }
  }
  return lines.join("\n");
}
