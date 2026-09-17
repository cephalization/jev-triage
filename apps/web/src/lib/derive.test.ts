import { DEFAULT_WEIGHTS } from "@triage/triage/priority";
import { describe, expect, test } from "vite-plus/test";
import { calibrationPairs, deriveRows, sortRows, type IssueInput } from "./derive.ts";

const base = (n: number, over: Partial<IssueInput> = {}): IssueInput => ({
  id: `I_${n}`,
  repo_id: "r",
  number: n,
  title: `t${n}`,
  body: "",
  state: "open",
  author: "a",
  labels_json: [],
  comments: 0,
  reactions: 0,
  created_at: 1000,
  updated_at: 2000,
  closed_at: null,
  url: "",
  reclassify: false,
  classifying: false,
  classifications: [],
  feedback: [],
  labels: [],
  presence: [],
  ...over,
});
const cls = (kind: string, value: string, confidence = 0.9) => ({
  kind,
  value,
  confidence,
  probabilities_json: { [value]: confidence },
  questions_version: 1,
  created_at: 5,
});

describe("deriveRows", () => {
  test("unclassified issues are flagged and never in review", () => {
    const [r] = deriveRows([base(1)], 1, DEFAULT_WEIGHTS, undefined, 1000);
    expect(r!.unclassified).toBe(true);
    expect(r!.needsReview).toBe(false);
    expect(r!.priority).toBe(0);
  });

  test("low confidence and disagreement land in the review queue with reasons", () => {
    const rows = deriveRows(
      [
        base(1, { classifications: [cls("category", "bug", 0.4)] }),
        base(2, {
          classifications: [cls("category", "bug")],
          feedback: [{ id: "f", kind: "category", value: "docs", user_id: "u", created_at: 9 }],
        }),
        base(3, { classifications: [cls("category", "bug"), cls("duplicate", "I_1", 0.8)] }),
      ],
      1,
      DEFAULT_WEIGHTS,
    );
    expect(rows[0]!.reviewReasons[0]).toMatch(/below 0.6/);
    expect(rows[1]!.category).toBe("docs");
    expect(rows[1]!.reviewReasons[0]).toMatch(/human overrode category/);
    expect(rows[2]!.duplicateOf).toBe("I_1");
    expect(rows[2]!.needsReview).toBe(true);
  });

  test("priority responds to weights and severity", () => {
    const issues = [
      base(1, { classifications: [cls("severity", "1.0000"), cls("urgency", "0.0000")] }),
      base(2, { classifications: [cls("severity", "0.0000"), cls("urgency", "1.0000")] }),
    ];
    const a = deriveRows(issues, 1, { ...DEFAULT_WEIGHTS, severity: 1, urgency: 0 });
    const b = deriveRows(issues, 1, { ...DEFAULT_WEIGHTS, severity: 0, urgency: 1 });
    expect(a[0]!.priority).toBeGreaterThan(a[1]!.priority);
    expect(b[0]!.priority).toBeLessThan(b[1]!.priority);
    expect(sortRows(a, "priority", "desc")[0]!.issue.number).toBe(1);
  });

  test("calibration pairs only where both model and human answered", () => {
    const rows = deriveRows(
      [
        base(1, {
          classifications: [cls("category", "bug", 0.7)],
          feedback: [{ id: "f", kind: "category", value: "bug", user_id: "u", created_at: 9 }],
        }),
        base(2, { classifications: [cls("category", "bug", 0.7)] }),
      ],
      1,
      DEFAULT_WEIGHTS,
    );
    expect(calibrationPairs(rows)).toEqual([{ confidence: 0.7, agreed: true }]);
  });
});
