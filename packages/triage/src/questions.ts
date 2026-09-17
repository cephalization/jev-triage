import { choice, noul, score } from "@typesafe-ai/sdk";
import type { ChoiceResponse, NoulResponse, ScoreResponse, Questions } from "@typesafe-ai/sdk";
import {
  CATEGORY_LABELS,
  FAMILIES,
  NONE,
  SEVERITY_LEVELS,
  URGENCY_LEVELS,
  type Family,
  type IssueForTriage,
  type LabeledExample,
  type RepoForTriage,
} from "./types.ts";

/**
 * One request = one shared state + an independent question matrix (issue × family).
 * Keys are `i<index>__<family>`; the index is the issue's position in `state.issues`
 * so the model can be pointed at `issues[3]` with a backticked path.
 */

export const BODY_EXCERPT_CHARS = 1500;

export function excerpt(text: string, max = BODY_EXCERPT_CHARS): string {
  const t = text.replace(/\r/g, "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function buildState(
  repo: RepoForTriage,
  examples: readonly LabeledExample[],
  issues: readonly IssueForTriage[],
) {
  return {
    repo: {
      owner: repo.owner,
      name: repo.name,
      description: repo.description,
      area_labels: repo.areaLabels,
    },
    labeled_examples: examples.map((e) => ({
      number: e.number,
      title: e.title,
      excerpt: e.excerpt,
      category: e.category,
      ...(e.area ? { area: e.area } : {}),
    })),
    issues: issues.map((i) => ({
      number: i.number,
      title: i.title,
      body_excerpt: excerpt(i.body),
      state: i.state,
      labels: i.labels,
      comments: i.comments,
      reactions: i.reactions,
      age_days: Math.round(i.ageDays),
      author_association: i.authorAssociation,
      candidates_for_duplicate: i.candidates.map((c) => ({ number: c.number, title: c.title })),
    })),
  };
}

export type TriageState = ReturnType<typeof buildState>;

export function questionKey(index: number, family: Family): string {
  return `i${index}__${family}`;
}

export function parseKey(key: string): { index: number; family: Family } | null {
  const m = /^i(\d+)__([a-z_]+)$/.exec(key);
  if (!m) return null;
  const family = m[2] as Family;
  if (!FAMILIES.includes(family)) return null;
  return { index: Number(m[1]), family };
}

const categoryCriteria = {
  bug: "Something is broken, wrong, crashing, or behaving unlike the documentation",
  feature: "A request for new behaviour, an enhancement, or an API addition",
  question:
    "The author is asking how to do something or why something happens; nothing needs changing",
  docs: "The problem or request is about documentation, examples, or the website",
  chore: "Maintenance: dependencies, CI, build, release, refactor, tooling",
  other: "Spam, off-topic, meta discussion, or genuinely none of the above",
} satisfies Record<(typeof CATEGORY_LABELS)[number], string>;

export function buildQuestions(issues: readonly IssueForTriage[], repo: RepoForTriage) {
  const questions: Record<string, ReturnType<typeof choice | typeof noul | typeof score>> = {};
  const areaCriteria: Record<string, string | null> = {};
  for (const a of repo.areaLabels) areaCriteria[a] = null;
  areaCriteria[NONE] = "No listed area label fits this issue";
  const askArea = repo.areaLabels.length > 0;

  issues.forEach((issue, idx) => {
    const path = `\`issues[${idx}]\``;
    const repoName = `${repo.owner}/${repo.name}`;
    questions[questionKey(idx, "category")] = choice(
      {
        question: `What kind of issue is ${path}? Use the title, body_excerpt and labels, and follow the conventions shown in \`labeled_examples\` from the same repository (${repoName}).`,
        notes: "Pick the single best fit. A bug report that also asks a question is a bug.",
      },
      categoryCriteria,
    );
    if (askArea) {
      questions[questionKey(idx, "area")] = choice(
        {
          question: `Which area label from \`repo.area_labels\` best describes what part of the project ${path} concerns?`,
          notes: "Choose `none` if no listed area clearly applies.",
        },
        areaCriteria,
      );
    }
    questions[questionKey(idx, "severity")] = score(
      {
        question: `If ${path} is a defect, how severe is its impact for users? For non-defects, rate the impact of leaving it unaddressed.`,
      },
      SEVERITY_LEVELS,
    );
    questions[questionKey(idx, "needs_info")] = noul(
      `Is ${path} missing information a maintainer would need to reproduce or act on it (versions, steps, expected vs actual, a minimal example, or a concrete proposal)?`,
      {
        true: "Important details are missing; a maintainer would have to ask before doing anything",
        false: "The report or request is complete enough to act on",
      },
    );
    questions[questionKey(idx, "actionable")] = noul(
      `Could a maintainer of ${repoName} start working on ${path} today without asking the author anything?`,
      {
        true: "Clear, scoped, and complete enough to begin",
        false: "Blocked on clarification, a decision, or an external dependency",
      },
    );
    questions[questionKey(idx, "urgency")] = score(
      {
        question: `How urgently should maintainers look at ${path}? Consider severity signals, reactions, comments, age_days and whether the problem is spreading.`,
      },
      URGENCY_LEVELS,
    );
    if (issue.candidates.length > 0) {
      const dupCriteria: Record<string, string | null> = {};
      issue.candidates.forEach((c, ci) => {
        dupCriteria[`candidate_${ci}`] = `#${c.number}: ${c.title}`;
      });
      dupCriteria[NONE] = "None of the candidates report the same underlying problem or request";
      questions[questionKey(idx, "duplicate")] = choice(
        {
          question: `Is ${path} a duplicate of one of its \`candidates_for_duplicate\` (same underlying problem or request, not merely a similar title)?`,
          notes: "Candidates were found by title similarity in code; most are not duplicates.",
        },
        dupCriteria,
      );
    }
  });
  return questions as Questions;
}

export type AnyAnswer = ChoiceResponse | NoulResponse | ScoreResponse;

export interface IssueAnswers {
  category?: ChoiceResponse;
  area?: ChoiceResponse;
  severity?: ScoreResponse;
  needs_info?: NoulResponse;
  actionable?: NoulResponse;
  urgency?: ScoreResponse;
  duplicate?: ChoiceResponse;
}

/** Fold the flat answer map back into per-issue answer records, by batch index. */
export function foldAnswers(
  answers: Readonly<Record<string, AnyAnswer>>,
  count: number,
): IssueAnswers[] {
  const out: IssueAnswers[] = Array.from({ length: count }, () => ({}));
  for (const [key, answer] of Object.entries(answers)) {
    const parsed = parseKey(key);
    if (!parsed || parsed.index >= count) continue;
    const target = out[parsed.index] as Record<string, AnyAnswer>;
    target[parsed.family] = answer;
  }
  return out;
}

export function countQuestions(questions: Questions): number {
  return Object.keys(questions).length;
}
