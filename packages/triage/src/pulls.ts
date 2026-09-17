import { choice, score } from "@typesafe-ai/sdk";
import type { ChoiceResponse, Questions, ScoreResponse } from "@typesafe-ai/sdk";
import { excerpt } from "./questions.ts";
import {
  NONE,
  PULL_FAMILIES,
  REVIEW_EFFORT_LEVELS,
  type PullFamily,
  type PullForTriage,
  type RepoForTriage,
} from "./types.ts";

/**
 * Pull request questions: one shared state, an independent matrix (pull × family).
 * Keys are `p<index>__<family>`. Two families:
 *  - review_effort: a Score over REVIEW_EFFORT_LEVELS, read from the diff shape and description;
 *  - reviewer: a Choice over code-ranked candidates (+ none). Code shortlists by path overlap;
 *    the model judges fit from what the pull changes vs. what each candidate has reviewed.
 * Load balancing is deliberately not asked: it is applied in code from the probabilities.
 */

export const FILES_IN_STATE = 30;
export const CANDIDATE_TITLES = 3;
export const CANDIDATE_DIRS = 6;

export function buildPullState(repo: RepoForTriage, pulls: readonly PullForTriage[]) {
  return {
    repo: { owner: repo.owner, name: repo.name, description: repo.description },
    pulls: pulls.map((p) => ({
      number: p.number,
      title: p.title,
      body_excerpt: excerpt(p.body, 1000),
      draft: p.draft,
      author: p.author,
      labels: p.labels,
      base_branch: p.baseRef,
      additions: p.additions,
      deletions: p.deletions,
      changed_files: p.changedFiles,
      files: p.files.slice(0, FILES_IN_STATE),
      age_days: Math.round(p.ageDays),
      requested_reviewers: p.requestedReviewers,
      review_decision: p.reviewDecision ?? "none yet",
      candidates_for_reviewer: p.candidates.map((c) => ({
        login: c.login,
        reviews: c.reviews,
        approvals: c.approvals,
        reviews_directories: c.dirs.slice(0, CANDIDATE_DIRS),
        recently_approved: c.recentTitles.slice(0, CANDIDATE_TITLES),
        path_overlap_with_this_pull: Number(c.pathOverlap.toFixed(2)),
        already_requested: c.requested,
        last_review_days_ago: c.lastReviewDays === null ? null : Math.round(c.lastReviewDays),
      })),
    })),
  };
}

export type PullState = ReturnType<typeof buildPullState>;

export function pullQuestionKey(index: number, family: PullFamily): string {
  return `p${index}__${family}`;
}

export function parsePullKey(key: string): { index: number; family: PullFamily } | null {
  const m = /^p(\d+)__([a-z_]+)$/.exec(key);
  if (!m) return null;
  const family = m[2] as PullFamily;
  if (!PULL_FAMILIES.includes(family)) return null;
  return { index: Number(m[1]), family };
}

export function buildPullQuestions(pulls: readonly PullForTriage[], repo: RepoForTriage) {
  const questions: Record<string, ReturnType<typeof choice | typeof score>> = {};
  const repoName = `${repo.owner}/${repo.name}`;
  pulls.forEach((pull, idx) => {
    const path = `\`pulls[${idx}]\``;
    questions[pullQuestionKey(idx, "review_effort")] = score(
      {
        question: `How much reviewer time does ${path} in ${repoName} need before it could be merged responsibly? Judge from the title, body_excerpt, files, additions, deletions and changed_files.`,
        notes:
          "Size is only a hint: a large generated or mechanical diff (lockfiles, snapshots, renames, formatting) is trivial, while a small change to core logic, concurrency, data formats or security can be major. Drafts are judged as if ready.",
      },
      REVIEW_EFFORT_LEVELS,
    );
    if (pull.candidates.length > 0) {
      const criteria: Record<string, string | null> = {};
      pull.candidates.forEach((c, ci) => {
        criteria[`candidate_${ci}`] =
          `${c.login}: ${c.reviews} reviews (${c.approvals} approvals), usually in ${c.dirs.slice(0, 4).join(", ") || "no recorded directories"}`;
      });
      criteria[NONE] = "No listed candidate has reviewed code related to this pull request";
      questions[pullQuestionKey(idx, "reviewer")] = choice(
        {
          question: `Which of ${path}.candidates_for_reviewer is best placed to review ${path}? Match what the pull changes (files, title, body_excerpt) against each candidate's reviews_directories and recently_approved titles.`,
          notes:
            "Judge expertise only; workload is balanced elsewhere. Candidates were shortlisted by code from directory overlap and most have some overlap; prefer the one whose recent reviews are closest in subject. Being already_requested is a hint, not a decision.",
        },
        criteria,
      );
    }
  });
  return questions as Questions;
}

export interface PullAnswers {
  review_effort?: ScoreResponse;
  reviewer?: ChoiceResponse;
}

export function foldPullAnswers(
  answers: Readonly<Record<string, ChoiceResponse | ScoreResponse>>,
  count: number,
): PullAnswers[] {
  const out: PullAnswers[] = Array.from({ length: count }, () => ({}));
  for (const [key, answer] of Object.entries(answers)) {
    const parsed = parsePullKey(key);
    if (!parsed || parsed.index >= count) continue;
    const target = out[parsed.index] as Record<string, ChoiceResponse | ScoreResponse>;
    target[parsed.family] = answer;
  }
  return out;
}
