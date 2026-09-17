import { describe, expect, test } from "vite-plus/test";
import {
  buildQuestions,
  buildState,
  countQuestions,
  excerpt,
  foldAnswers,
  parseKey,
  questionKey,
} from "../src/questions.ts";
import type { IssueForTriage, RepoForTriage } from "../src/types.ts";

const repo: RepoForTriage = {
  owner: "acme",
  name: "widgets",
  description: "Widgets for everyone",
  areaLabels: ["cli", "docs-site"],
};

const issue = (n: number, candidates: IssueForTriage["candidates"] = []): IssueForTriage => ({
  id: `I_${n}`,
  number: n,
  title: `Issue ${n}`,
  body: "x".repeat(2000),
  state: "open",
  labels: ["bug"],
  comments: 2,
  reactions: 5,
  ageDays: 3.7,
  authorAssociation: "NONE",
  candidates,
});

describe("state", () => {
  test("truncates bodies and keys issues by batch index", () => {
    const s = buildState(repo, [], [issue(1)]);
    expect(s.issues[0]!.body_excerpt.length).toBeLessThanOrEqual(1501);
    expect(s.issues[0]!.age_days).toBe(4);
    expect(s.repo.area_labels).toEqual(["cli", "docs-site"]);
  });

  test("excerpt keeps short text intact", () => {
    expect(excerpt("hello")).toBe("hello");
  });
});

describe("questions", () => {
  test("asks 6 questions per issue without duplicate candidates, 7 with", () => {
    const q = buildQuestions(
      [issue(1), issue(2, [{ id: "I_9", number: 9, title: "Issue 9" }])],
      repo,
    );
    expect(countQuestions(q)).toBe(13);
    expect(q[questionKey(1, "duplicate")]).toBeDefined();
    expect(q[questionKey(0, "duplicate")]).toBeUndefined();
  });

  test("skips the area question when the repo has no area labels", () => {
    const q = buildQuestions([issue(1)], { ...repo, areaLabels: [] });
    expect(q[questionKey(0, "area")]).toBeUndefined();
    expect(countQuestions(q)).toBe(5);
  });

  test("every choice has a none/other outcome", () => {
    const q = buildQuestions([issue(1, [{ id: "I_9", number: 9, title: "t" }])], repo);
    const area = q[questionKey(0, "area")] as { criteria: Record<string, unknown> };
    const dup = q[questionKey(0, "duplicate")] as { criteria: Record<string, unknown> };
    const cat = q[questionKey(0, "category")] as { criteria: Record<string, unknown> };
    expect(area.criteria).toHaveProperty("none");
    expect(dup.criteria).toHaveProperty("none");
    expect(cat.criteria).toHaveProperty("other");
  });

  test("keys round-trip", () => {
    expect(parseKey(questionKey(12, "severity"))).toEqual({ index: 12, family: "severity" });
    expect(parseKey("garbage")).toBeNull();
    expect(parseKey("i1__nope")).toBeNull();
  });

  test("foldAnswers groups by issue and ignores unknown keys", () => {
    const folded = foldAnswers(
      {
        i0__category: {
          type: "choice",
          choice: "bug",
          confidence: 0.9,
          probabilities: { bug: 0.9 },
        },
        i1__needs_info: { type: "noul", noul: 0.2 },
        i7__category: {
          type: "choice",
          choice: "bug",
          confidence: 0.9,
          probabilities: { bug: 0.9 },
        },
        junk: { type: "noul", noul: 1 },
      },
      2,
    );
    expect(folded[0]!.category?.choice).toBe("bug");
    expect(folded[1]!.needs_info?.noul).toBe(0.2);
    expect(folded[1]!.category).toBeUndefined();
  });
});
