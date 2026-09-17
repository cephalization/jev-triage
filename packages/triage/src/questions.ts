import { choice, score } from "@typesafe-ai/sdk";
import type { ChoiceResponse, ScoreResponse, Questions } from "@typesafe-ai/sdk";
import {
  ACTION_LABELS,
  CATEGORY_LABELS,
  FAMILIES,
  MISSING_LABELS,
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
      ...(e.action ? { next_action: e.action } : {}),
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

/**
 * The next step, phrased as what a maintainer would do, not what the issue is. Each option
 * says what it covers and what belongs elsewhere so the boundaries are the model's, not ours.
 */
const actionCriteria = {
  ask_author: {
    what: "Reply asking the author for something needed before anyone can act: reproduction steps, versions or environment, expected versus actual behaviour, a minimal example, logs, or a concrete proposal",
    not_for:
      "Reports complete enough to reproduce or evaluate, even if a maintainer might have follow-up questions later",
  },
  answer: {
    what: "Reply with an answer, an explanation, or a pointer to documentation: the author is asking how to do something, has a misunderstanding, or reports behaviour that is intended; nothing in the project needs to change",
    not_for: "Questions that expose a real defect or a missing feature",
  },
  investigate: {
    what: "A maintainer should reproduce or debug: a plausible defect with enough detail to try, where the cause and the fix are not yet known",
    not_for: "Reports too thin to attempt (ask_author) or defects already understood (accept)",
  },
  decide: {
    what: "The team must choose a direction first: a proposal, design question, or scope choice where work cannot start until maintainers agree",
    not_for: "Small, uncontroversial requests that can simply be accepted",
  },
  accept: {
    what: "Ready for the backlog: a clear, well-specified bug or request that needs labelling and prioritising and could be worked on today without asking the author anything",
    not_for: "Anything that still needs a reply, a reproduction, or a decision",
  },
  close: {
    what: "Should be closed: already resolved, cannot be reproduced, out of scope, spam, intended behaviour with nothing further to explain, or a duplicate of one of `candidates_for_duplicate`",
    not_for: "Valid reports that merely need work",
  },
  wait: {
    what: "Nothing for a maintainer to do right now: the ball is with the author or a third party, work is already in progress, or the next step cannot be judged from what is shown",
  },
} satisfies Record<(typeof ACTION_LABELS)[number], Record<string, string>>;

const missingCriteria = {
  repro_steps: "Steps to reproduce the problem",
  versions: "Version, platform, or environment details",
  expected_vs_actual: "What was expected and what actually happened",
  minimal_example: "A minimal code sample or reproduction project",
  logs_or_error: "The error message, stack trace, or logs",
  concrete_proposal: "For a request: what specifically should change and why",
  none: "Nothing important is missing; the report is complete enough to act on",
} satisfies Record<(typeof MISSING_LABELS)[number], string>;

export function buildQuestions(issues: readonly IssueForTriage[], repo: RepoForTriage) {
  const questions: Record<string, ReturnType<typeof choice | typeof score>> = {};
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
    questions[questionKey(idx, "urgency")] = score(
      {
        question: `How urgently should maintainers look at ${path}? Consider severity signals, reactions, comments, age_days and whether the problem is spreading.`,
      },
      URGENCY_LEVELS,
    );
    questions[questionKey(idx, "action")] = choice(
      {
        question: `What is the single next step a maintainer of ${repoName} should take on ${path}?`,
        notes: [
          "Judge from the title, body_excerpt, labels, state, comments, reactions, age_days and author_association; the comment thread itself is not shown.",
          "Where `labeled_examples` carry a next_action, follow that team's conventions.",
          "If one of candidates_for_duplicate reports the same underlying problem, the next step is close.",
        ],
      },
      actionCriteria,
    );
    questions[questionKey(idx, "missing")] = choice(
      {
        question: `Suppose a maintainer replies to ${path} asking for more information. What single piece of information matters most?`,
        notes:
          "Asked for every issue regardless of whether a reply is needed; answer `none` when the report is already complete enough to act on.",
      },
      missingCriteria,
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

export type AnyAnswer = ChoiceResponse | ScoreResponse;

export interface IssueAnswers {
  category?: ChoiceResponse;
  area?: ChoiceResponse;
  severity?: ScoreResponse;
  urgency?: ScoreResponse;
  duplicate?: ChoiceResponse;
  action?: ChoiceResponse;
  missing?: ChoiceResponse;
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
