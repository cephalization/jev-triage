import { describe, expect, test } from "vite-plus/test";
import { decidePull } from "../src/decide.ts";
import { pullAttention } from "../src/priority.ts";
import {
  buildPullQuestions,
  buildPullState,
  foldPullAnswers,
  parsePullKey,
  pullQuestionKey,
} from "../src/pulls.ts";
import type { PullForTriage, RepoForTriage, ReviewerCandidate } from "../src/types.ts";

const repo: RepoForTriage = {
  owner: "acme",
  name: "widgets",
  description: "Widgets for everyone",
  areaLabels: [],
};

const candidate = (login: string, over: Partial<ReviewerCandidate> = {}): ReviewerCandidate => ({
  login,
  reviews: 10,
  approvals: 8,
  dirs: ["src/api", "src/core"],
  recentTitles: ["Fix api routing", "Add core cache"],
  openLoad: 1,
  lastReviewDays: 3,
  pathOverlap: 0.7,
  requested: false,
  ...over,
});

const pull = (n: number, candidates: ReviewerCandidate[] = []): PullForTriage => ({
  id: `PR_${n}`,
  number: n,
  title: `Pull ${n}`,
  body: "y".repeat(3000),
  state: "open",
  draft: false,
  author: "alice",
  labels: ["enhancement"],
  additions: 120,
  deletions: 30,
  changedFiles: 4,
  files: Array.from({ length: 60 }, (_, i) => `src/api/file${i}.ts`),
  baseRef: "main",
  ageDays: 2.2,
  requestedReviewers: ["bob"],
  reviewDecision: null,
  candidates,
});

const choice = (label: string, confidence: number, probabilities?: Record<string, number>) => ({
  type: "choice" as const,
  choice: label,
  confidence,
  probabilities: probabilities ?? { [label]: confidence },
});
const scoreAnswer = (score: number) => ({
  type: "score" as const,
  score,
  confidence: 0.8,
  legend: {},
  probabilities: {},
});

describe("pull state and questions", () => {
  test("state truncates bodies and file lists, keeps candidate summaries", () => {
    const s = buildPullState(repo, [pull(1, [candidate("bob", { requested: true })])]);
    const p = s.pulls[0]!;
    expect(p.body_excerpt.length).toBeLessThanOrEqual(1201);
    expect(p.files).toHaveLength(30);
    expect(p.review_decision).toBe("none yet");
    expect(p.candidates_for_reviewer[0]).toMatchObject({
      login: "bob",
      already_requested: true,
      path_overlap_with_this_pull: 0.7,
      last_review_days_ago: 3,
    });
  });

  test("asks effort always and reviewer only with candidates", () => {
    const q = buildPullQuestions([pull(1), pull(2, [candidate("bob")])], repo);
    expect(Object.keys(q)).toHaveLength(3);
    expect(q[pullQuestionKey(0, "reviewer")]).toBeUndefined();
    const rv = q[pullQuestionKey(1, "reviewer")] as { criteria: Record<string, unknown> };
    expect(rv.criteria).toHaveProperty("candidate_0");
    expect(rv.criteria).toHaveProperty("none");
  });

  test("keys round-trip and fold by pull index", () => {
    expect(parsePullKey(pullQuestionKey(3, "reviewer"))).toEqual({ index: 3, family: "reviewer" });
    expect(parsePullKey("i3__reviewer")).toBeNull();
    const folded = foldPullAnswers(
      {
        p0__review_effort: scoreAnswer(1),
        p1__reviewer: choice("candidate_0", 0.6),
        junk: scoreAnswer(0),
      },
      2,
    );
    expect(folded[0]!.review_effort?.score).toBe(1);
    expect(folded[1]!.reviewer?.choice).toBe("candidate_0");
  });
});

describe("decidePull", () => {
  const candidates = [candidate("bob"), candidate("carol")];

  test("normalises effort and resolves a confident reviewer to the candidate", () => {
    const d = decidePull(
      {
        review_effort: scoreAnswer(2.4),
        reviewer: choice("candidate_1", 0.62, { candidate_1: 0.62, candidate_0: 0.3, none: 0.08 }),
      },
      candidates,
    );
    expect(d.effort).toBeCloseTo(0.8);
    expect(d.effortLevel).toBe(2);
    expect(d.reviewer.candidate?.login).toBe("carol");
    expect(d.reviewer.applied).toBe(true);
    expect(d.reviewerProbabilities).toEqual({ carol: 0.62, bob: 0.3, none: 0.08 });
    expect(d.needsReview).toBe(false);
  });

  test("a low-confidence pick is kept but flagged", () => {
    const d = decidePull({ reviewer: choice("candidate_0", 0.35) }, candidates);
    expect(d.reviewer.candidate?.login).toBe("bob");
    expect(d.reviewer.applied).toBe(false);
    expect(d.needsReview).toBe(true);
    expect(d.reasons[0]).toMatch(/reviewer confidence/);
  });

  test("none and missing answers", () => {
    const d = decidePull({ reviewer: choice("none", 0.9) }, candidates);
    expect(d.reviewer.candidate).toBeNull();
    expect(d.effort).toBeNull();
    expect(d.reasons[0]).toMatch(/no candidate/);
    expect(decidePull({}, []).needsReview).toBe(false);
  });
});

describe("pullAttention", () => {
  const base = {
    draft: false,
    reviewDecision: null,
    hasReviews: false,
    mergeable: "MERGEABLE",
    ageNorm: 0.5,
    effort: 0.5,
  };
  test("orders approved > awaiting review > changes requested > draft", () => {
    const approved = pullAttention({ ...base, reviewDecision: "APPROVED" });
    const waiting = pullAttention(base);
    const changes = pullAttention({ ...base, reviewDecision: "CHANGES_REQUESTED" });
    const draft = pullAttention({ ...base, draft: true });
    expect(approved).toBeGreaterThan(waiting);
    expect(waiting).toBeGreaterThan(changes);
    expect(changes).toBeGreaterThan(draft);
  });
  test("quick, old, conflict-free reviews come first among those waiting", () => {
    const quickOld = pullAttention({ ...base, effort: 0.1, ageNorm: 1 });
    const slowNew = pullAttention({ ...base, effort: 0.9, ageNorm: 0 });
    const conflicting = pullAttention({ ...base, mergeable: "CONFLICTING" });
    expect(quickOld).toBeGreaterThan(slowNew);
    expect(conflicting).toBeLessThan(pullAttention(base));
  });
});
