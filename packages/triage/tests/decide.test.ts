import { describe, expect, test } from "vite-plus/test";
import { decide, normaliseScore } from "../src/decide.ts";
import { THRESHOLDS } from "../src/policy.ts";
import type { IssueAnswers } from "../src/questions.ts";

const choice = (label: string, confidence: number) => ({
  type: "choice" as const,
  choice: label,
  confidence,
  probabilities: { [label]: confidence },
});
const scoreAnswer = (score: number, confidence = 0.8) => ({
  type: "score" as const,
  score,
  confidence,
  legend: {},
  probabilities: {},
});

const candidates = [
  { id: "I_a", number: 10, title: "A" },
  { id: "I_b", number: 11, title: "B" },
];

const full: IssueAnswers = {
  category: choice("bug", 0.82),
  area: choice("cli", 0.7),
  severity: scoreAnswer(2.1),
  urgency: scoreAnswer(1),
  action: choice("investigate", 0.7),
  missing: choice("none", 0.9),
  duplicate: choice("candidate_1", 0.9),
};

describe("decide", () => {
  test("auto-applies confident category, area and action; normalises scores", () => {
    const d = decide(full, candidates);
    expect(d.category).toEqual({ value: "bug", confidence: 0.82, applied: true });
    expect(d.area).toEqual({ value: "cli", confidence: 0.7, applied: true });
    expect(d.severity).toBeCloseTo(0.7);
    expect(d.urgency).toBeCloseTo(0.5);
    expect(d.action).toEqual({ value: "investigate", confidence: 0.7, applied: true });
    expect(d.missing).toEqual({ value: null, confidence: 0.9 });
  });

  test("routes low-confidence category to review", () => {
    const d = decide(
      { ...full, category: choice("bug", 0.45), duplicate: choice("none", 0.9) },
      candidates,
    );
    expect(d.category.applied).toBe(false);
    expect(d.needsReview).toBe(true);
    expect(d.reasons[0]).toMatch(/category confidence/);
  });

  test("an unclear next step needs review but keeps the model's pick", () => {
    const d = decide(
      { ...full, action: choice("ask_author", 0.3), duplicate: choice("none", 0.9) },
      candidates,
    );
    expect(d.action).toEqual({ value: "ask_author", confidence: 0.3, applied: false });
    expect(d.needsReview).toBe(true);
    expect(d.reasons).toEqual([expect.stringMatching(/next step unclear/)]);
  });

  test("missing information is kept as a value; none reads as nothing missing", () => {
    expect(decide({ missing: choice("repro_steps", 0.8) }, []).missing).toEqual({
      value: "repro_steps",
      confidence: 0.8,
    });
    expect(decide({ missing: choice("none", 0.8) }, []).missing.value).toBeNull();
    expect(decide({}, []).missing).toEqual({ value: null, confidence: 0 });
  });

  test("duplicate resolves to the candidate object at or above the threshold", () => {
    const d = decide(full, candidates);
    expect(d.duplicate.of?.number).toBe(11);
    expect(d.needsReview).toBe(true);
  });

  test("duplicate below threshold is kept as a hint but not surfaced", () => {
    const d = decide({ ...full, duplicate: choice("candidate_0", 0.5) }, candidates);
    expect(d.duplicate.of).toBeNull();
    expect(d.duplicate.candidateKey).toBe("candidate_0");
    expect(d.needsReview).toBe(false);
  });

  test("duplicate none and missing answers are handled", () => {
    const d = decide({ duplicate: choice("none", 0.95) }, candidates);
    expect(d.duplicate.of).toBeNull();
    expect(d.category.value).toBeNull();
    expect(d.action.value).toBeNull();
    expect(d.severity).toBeNull();
    expect(d.needsReview).toBe(false);
  });

  test("area none is never applied", () => {
    const d = decide({ area: choice("none", 0.99) }, []);
    expect(d.area.value).toBeNull();
    expect(d.area.applied).toBe(false);
  });

  test("thresholds are overridable without touching answers", () => {
    const strict = { ...THRESHOLDS, categoryAuto: 0.9, actionAuto: 0.9 };
    const d = decide(full, candidates, strict);
    expect(d.category.applied).toBe(false);
    expect(d.action.applied).toBe(false);
  });

  test("normaliseScore clamps", () => {
    expect(normaliseScore(3, 4)).toBe(1);
    expect(normaliseScore(-1, 4)).toBe(0);
    expect(normaliseScore(1, 3)).toBe(0.5);
  });
});
