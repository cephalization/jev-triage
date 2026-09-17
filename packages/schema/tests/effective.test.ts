import { describe, expect, test } from "vite-plus/test";
import { effectiveField, effectiveIssue, numeric } from "../src/effective.ts";
import { CLASSIFICATION_KINDS } from "../src/schema.ts";

const model = (kind: string, value: string, version = 1, created_at = 10, confidence = 0.8) => ({
  kind,
  value,
  confidence,
  probabilities_json: { [value]: confidence },
  questions_version: version,
  created_at,
});
const human = (kind: string, value: string, created_at = 20) => ({
  kind,
  value,
  user_id: "u1",
  created_at,
});

describe("effectiveField", () => {
  test("model value when no feedback", () => {
    const f = effectiveField("category", [model("category", "bug")], [], 1);
    expect(f.value).toBe("bug");
    expect(f.source).toBe("model");
    expect(f.confidence).toBe(0.8);
  });

  test("human feedback wins and flags disagreement", () => {
    const f = effectiveField(
      "category",
      [model("category", "bug")],
      [human("category", "feature")],
      1,
    );
    expect(f.value).toBe("feature");
    expect(f.source).toBe("human");
    expect(f.disagreement).toBe(true);
    expect(f.model?.value).toBe("bug");
  });

  test("agreeing feedback is not a disagreement", () => {
    const f = effectiveField("category", [model("category", "bug")], [human("category", "bug")], 1);
    expect(f.disagreement).toBe(false);
  });

  test("latest row wins regardless of array order", () => {
    const f = effectiveField(
      "category",
      [model("category", "bug", 1, 5), model("category", "docs", 1, 50)],
      [human("category", "chore", 1), human("category", "feature", 99)],
      1,
    );
    expect(f.model?.value).toBe("docs");
    expect(f.value).toBe("feature");
  });

  test("stale questions_version rows are ignored", () => {
    const f = effectiveField("category", [model("category", "bug", 1)], [], 2);
    expect(f.source).toBe("none");
    expect(f.value).toBeNull();
  });

  test("effectiveIssue covers every kind and numeric parses scores", () => {
    const e = effectiveIssue([model("severity", "0.6667")], [], 1, CLASSIFICATION_KINDS);
    expect(Object.keys(e)).toHaveLength(CLASSIFICATION_KINDS.length);
    expect(numeric(e.severity)).toBeCloseTo(0.6667);
    expect(numeric(e.urgency)).toBeNull();
  });
});
