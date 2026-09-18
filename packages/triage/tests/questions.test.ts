import { describe, expect, test } from "vite-plus/test";
import {
  buildQuestions,
  buildState,
  countQuestions,
  cut,
  excerpt,
  foldAnswers,
  parseKey,
  questionKey,
} from "../src/questions.ts";
import { ACTION_LABELS, MISSING_LABELS } from "../src/types.ts";
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

  test("labeled examples carry the team's next action only when a person set one", () => {
    const s = buildState(
      repo,
      [
        { number: 1, title: "a", excerpt: "", category: "bug", action: "close" },
        { number: 2, title: "b", excerpt: "", category: "docs" },
      ],
      [],
    );
    expect(s.labeled_examples[0]).toMatchObject({ next_action: "close" });
    expect(s.labeled_examples[1]).not.toHaveProperty("next_action");
  });

  test("excerpt keeps short text intact", () => {
    expect(excerpt("hello")).toBe("hello");
    // A cut that would land between the halves of an emoji backs off one unit; a lone surrogate
    // in the state is rejected by TypeSafe as invalid Unicode.
    const rocket = String.fromCodePoint(0x1f680);
    expect(cut(`abc${rocket}def`, 4)).toBe("abc");
    expect(cut(`abc${rocket}def`, 5)).toBe(`abc${rocket}`);
    expect(cut("abcdef", 4)).toBe("abcd");
    expect(cut("ab", 4)).toBe("ab");
    const body = `${"x".repeat(999)}${rocket} more`;
    expect(excerpt(body, 1000)).toBe(`${"x".repeat(999)}…`);
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

  test("every choice has a none/other/wait outcome", () => {
    const q = buildQuestions([issue(1, [{ id: "I_9", number: 9, title: "t" }])], repo);
    const criteria = (family: Parameters<typeof questionKey>[1]) =>
      (q[questionKey(0, family)] as { criteria: Record<string, unknown> }).criteria;
    expect(criteria("area")).toHaveProperty("none");
    expect(criteria("duplicate")).toHaveProperty("none");
    expect(criteria("category")).toHaveProperty("other");
    expect(criteria("missing")).toHaveProperty("none");
    expect(criteria("action")).toHaveProperty("wait");
  });

  test("action and missing criteria cover exactly the exported labels", () => {
    const q = buildQuestions([issue(1)], repo);
    const keys = (family: Parameters<typeof questionKey>[1]) =>
      Object.keys((q[questionKey(0, family)] as { criteria: Record<string, unknown> }).criteria);
    expect(keys("action")).toEqual([...ACTION_LABELS]);
    expect(keys("missing")).toEqual([...MISSING_LABELS]);
  });

  test("keys round-trip", () => {
    expect(parseKey(questionKey(12, "severity"))).toEqual({ index: 12, family: "severity" });
    expect(parseKey("garbage")).toBeNull();
    expect(parseKey("i1__nope")).toBeNull();
    expect(parseKey("i1__needs_info")).toBeNull();
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
        i1__action: {
          type: "choice",
          choice: "ask_author",
          confidence: 0.6,
          probabilities: { ask_author: 0.6 },
        },
        i7__category: {
          type: "choice",
          choice: "bug",
          confidence: 0.9,
          probabilities: { bug: 0.9 },
        },
        junk: { type: "choice", choice: "x", confidence: 1, probabilities: { x: 1 } },
      },
      2,
    );
    expect(folded[0]!.category?.choice).toBe("bug");
    expect(folded[1]!.action?.choice).toBe("ask_author");
    expect(folded[1]!.category).toBeUndefined();
  });
});
