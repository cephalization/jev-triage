import { describe, expect, test } from "vite-plus/test";
import { derivePulls, type PullInput } from "../lib/derive.ts";
import { breakdown } from "./ReviewerBreakdown.tsx";

const pull = (n: number, over: Partial<PullInput> = {}): PullInput => ({
  id: `PR_${n}`,
  repo_id: "r",
  number: n,
  title: `pr${n}`,
  body: "",
  state: "open",
  draft: false,
  author: "alice",
  head_ref: "f",
  base_ref: "main",
  additions: 1,
  deletions: 1,
  changed_files: 1,
  files_json: [],
  labels_json: [],
  requested_reviewers_json: [],
  review_decision: null,
  mergeable: null,
  comments: 0,
  created_at: 1,
  updated_at: 2,
  closed_at: null,
  merged_at: null,
  url: "",
  reclassify: false,
  classifying: false,
  classifications: [],
  feedback: [],
  reviews: [],
  ...over,
});
const pick = (probabilities: Record<string, number>) => ({
  kind: "reviewer",
  value: "bob",
  confidence: 0.6,
  probabilities_json: probabilities,
  questions_version: 1,
  created_at: 5,
});

describe("breakdown", () => {
  test("counts balanced, model and human picks per person, no-suggestion last", () => {
    const roster = [
      { login: "bob", reviews: 9, approvals: 7, open_load: 0 },
      { login: "carol", reviews: 4, approvals: 3, open_load: 0 },
    ];
    const rows = derivePulls(
      [
        pull(1, { classifications: [pick({ bob: 0.6, carol: 0.4 })] }),
        pull(2, { classifications: [pick({ bob: 0.6, carol: 0.4 })] }),
        pull(3, { classifications: [pick({ bob: 0.6, carol: 0.4 })] }),
        pull(4, {
          feedback: [{ id: "f", kind: "reviewer", value: "carol", user_id: "u", created_at: 9 }],
        }),
        pull(5),
      ],
      1,
      roster,
    );
    const lines = breakdown(rows, roster);
    const bob = lines.find((l) => l.login === "bob")!;
    const carol = lines.find((l) => l.login === "carol")!;
    expect(bob.model).toBe(3);
    expect(bob.balanced + carol.balanced).toBe(4);
    expect(carol.balanced).toBeGreaterThanOrEqual(2);
    expect(carol.human).toBe(1);
    expect(bob.approvals).toBe(7);
    expect(lines[lines.length - 1]!.login).toBeNull();
    expect(lines[lines.length - 1]!.balanced).toBe(1);
  });
});
