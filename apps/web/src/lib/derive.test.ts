import { DEFAULT_WEIGHTS } from "@triage/triage/priority";
import { describe, expect, test } from "vite-plus/test";
import {
  activeUsers,
  calibrationPairs,
  derivePulls,
  deriveRows,
  groupByAction,
  groupByReviewer,
  sortRows,
  whyLine,
  type IssueInput,
  type PullInput,
} from "./derive.ts";

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

  test("next step, missing info and triage state come through", () => {
    const rows = deriveRows(
      [
        base(1, {
          classifications: [
            cls("category", "bug"),
            cls("action", "ask_author", 0.7),
            cls("missing", "repro_steps", 0.8),
          ],
          triage: { status: "open", claimed_by: "bob" },
        }),
        base(2, {
          classifications: [cls("action", "accept", 0.3), cls("missing", "none")],
          feedback: [{ id: "f", kind: "action", value: "close", user_id: "u", created_at: 9 }],
          triage: { status: "done", done_by: "u" },
        }),
        base(3, { classifications: [cls("action", "investigate", 0.2)] }),
      ],
      1,
      DEFAULT_WEIGHTS,
      undefined,
      5000,
    );
    expect(rows[0]).toMatchObject({
      action: "ask_author",
      actionSource: "model",
      missing: "repro_steps",
      claimedBy: "bob",
      done: false,
    });
    expect(rows[0]!.why).toBe("Likely bug · missing repro steps");
    expect(rows[1]).toMatchObject({
      action: "close",
      actionSource: "human",
      missing: null,
      done: true,
    });
    expect(rows[1]!.reviewReasons).toEqual([expect.stringMatching(/overrode next step/)]);
    expect(rows[2]!.reviewReasons).toEqual([expect.stringMatching(/next step unclear/)]);
  });

  test("groupByAction follows the fixed section order and puts unclassified last", () => {
    const rows = deriveRows(
      [
        base(1),
        base(2, { classifications: [cls("action", "close")] }),
        base(3, { classifications: [cls("action", "ask_author")] }),
        base(4, { classifications: [cls("action", "close")] }),
        base(5, { classifications: [cls("action", "bogus")] }),
      ],
      1,
      DEFAULT_WEIGHTS,
    );
    expect(groupByAction(rows).map((g) => [g.action, g.rows.map((r) => r.issue.number)])).toEqual([
      ["ask_author", [3]],
      ["close", [2, 4]],
      [null, [1, 5]],
    ]);
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

describe("activeUsers", () => {
  const p = (user: string, updated_at: number, issue_id: string | null = null) => ({
    client_id: `${user}-${updated_at}`,
    user_id: user,
    name: user,
    color: "#000",
    issue_id,
    updated_at,
  });

  test("drops stale rows and collapses tabs to one entry per user", () => {
    const out = activeUsers([p("bob", 100), p("bob", 90, "I1"), p("old", 10)], 120, 45);
    expect(out.map((u) => u.user_id)).toEqual(["bob"]);
    expect(out[0]!.updated_at).toBe(100);
  });

  test("keeps the issue a user has open in any tab", () => {
    expect(activeUsers([p("bob", 100), p("bob", 90, "I1")], 120, 45)[0]!.issue_id).toBe("I1");
    expect(activeUsers([p("bob", 90), p("bob", 100, "I2")], 120, 45)[0]!.issue_id).toBe("I2");
    expect(activeUsers([p("bob", 100, "I1"), p("bob", 110, "I2")], 120, 45)[0]!.issue_id).toBe(
      "I2",
    );
  });

  test("sorts by name", () => {
    expect(activeUsers([p("zed", 100), p("amy", 100)], 120, 45).map((u) => u.name)).toEqual([
      "amy",
      "zed",
    ]);
  });
});

const pullBase = (n: number, over: Partial<PullInput> = {}): PullInput => ({
  id: `PR_${n}`,
  repo_id: "r",
  number: n,
  title: `pr${n}`,
  body: "",
  state: "open",
  draft: false,
  author: "alice",
  head_ref: "feat",
  base_ref: "main",
  additions: 10,
  deletions: 2,
  changed_files: 1,
  files_json: ["src/a.ts"],
  labels_json: [],
  requested_reviewers_json: [],
  review_decision: null,
  mergeable: "MERGEABLE",
  comments: 0,
  created_at: 1000,
  updated_at: 2000,
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
const reviewerCls = (
  probabilities: Record<string, number>,
  confidence = 0.6,
  value = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]![0],
) => ({
  kind: "reviewer",
  value,
  confidence,
  probabilities_json: probabilities,
  questions_version: 1,
  created_at: 5,
});

describe("derivePulls", () => {
  const roster = [
    { login: "bob", reviews: 10, approvals: 8, open_load: 0 },
    { login: "carol", reviews: 5, approvals: 4, open_load: 0 },
  ];

  test("unclassified pulls still get an attention score; approved ones rank first", () => {
    const rows = derivePulls(
      [pullBase(1), pullBase(2, { review_decision: "APPROVED" }), pullBase(3, { draft: true })],
      1,
      roster,
    );
    expect(rows[0]!.unclassified).toBe(true);
    expect(rows[1]!.priority).toBeGreaterThan(rows[0]!.priority);
    expect(rows[0]!.priority).toBeGreaterThan(rows[2]!.priority);
    expect(rows.every((r) => r.assigned === null)).toBe(true);
  });

  test("balances the model's reviewer picks across people and keeps human picks fixed", () => {
    const probs = { bob: 0.6, carol: 0.4 };
    const rows = derivePulls(
      [
        pullBase(1, { classifications: [cls("review_effort", "0.3"), reviewerCls(probs)] }),
        pullBase(2, { classifications: [cls("review_effort", "0.3"), reviewerCls(probs)] }),
        pullBase(3, { classifications: [cls("review_effort", "0.3"), reviewerCls(probs)] }),
        pullBase(4, {
          classifications: [reviewerCls(probs)],
          feedback: [{ id: "f", kind: "reviewer", value: "bob", user_id: "u", created_at: 9 }],
        }),
      ],
      1,
      roster,
    );
    const byId = new Map(rows.map((r) => [r.pull.id, r]));
    expect(byId.get("PR_4")!.assigned).toEqual({ login: "bob", probability: 1, balanced: false });
    expect(byId.get("PR_4")!.reviewerSource).toBe("human");
    const model = ["PR_1", "PR_2", "PR_3"].map((id) => byId.get(id)!.assigned!.login);
    expect(model.filter((l) => l === "carol").length).toBeGreaterThanOrEqual(1);
    expect(model.filter((l) => l === "bob").length).toBeGreaterThanOrEqual(1);
    expect(rows.find((r) => r.assigned?.balanced)).toBeDefined();
  });

  test("low reviewer confidence and no-match answers need review", () => {
    const rows = derivePulls(
      [
        pullBase(1, {
          classifications: [reviewerCls({ bob: 0.35, carol: 0.3, none: 0.35 }, 0.35, "bob")],
        }),
        pullBase(2, { classifications: [reviewerCls({ none: 0.9, bob: 0.1 }, 0.9)] }),
      ],
      1,
      roster,
    );
    expect(rows[0]!.reviewReasons[0]).toMatch(/reviewer confidence/);
    expect(rows[1]!.reviewer).toBeNull();
    expect(rows[1]!.reviewReasons[0]).toMatch(/no known reviewer/);
    expect(rows[1]!.assigned).toBeNull();
  });
});

describe("groupByReviewer", () => {
  const roster = [
    { login: "bob", reviews: 10, approvals: 8, open_load: 0 },
    { login: "carol", reviews: 5, approvals: 4, open_load: 0 },
  ];
  const probs = { bob: 0.6, carol: 0.4 };
  const rows = derivePulls(
    [
      pullBase(1, { classifications: [reviewerCls(probs)] }),
      pullBase(2, { classifications: [reviewerCls(probs)] }),
      pullBase(3, { classifications: [reviewerCls(probs)] }),
      pullBase(4),
    ],
    1,
    roster,
  );

  test("model mode groups by the raw pick; balanced mode by the assignment; unassigned last", () => {
    const model = groupByReviewer(rows, "model");
    expect(model.map((g) => [g.login, g.rows.length])).toEqual([
      ["bob", 3],
      [null, 1],
    ]);
    const balanced = groupByReviewer(rows, "balanced");
    expect(balanced.map((g) => g.login)).toEqual(["bob", "carol", null]);
    expect(balanced[0]!.rows.length + balanced[1]!.rows.length).toBe(3);
  });
});

describe("whyLine", () => {
  const empty = {
    category: null,
    categorySource: "none" as const,
    severity: null,
    urgency: null,
    action: null,
    missing: null,
    duplicateOf: null,
    reactions: 0,
    comments: 0,
    ageDays: 0,
  };

  test("composes only what is known", () => {
    expect(whyLine(empty)).toBe("");
    expect(
      whyLine({
        ...empty,
        category: "bug",
        categorySource: "model",
        severity: 0.7,
        urgency: 0.9,
        reactions: 14,
        comments: 1,
        ageDays: 40.4,
      }),
    ).toBe(
      "Likely bug · blocks a workflow · needs attention now · 14 reactions · 1 comment · open 40d",
    );
  });

  test("confirmed categories drop the hedge; questions read naturally", () => {
    expect(whyLine({ ...empty, category: "question", categorySource: "human" })).toBe("A question");
    expect(whyLine({ ...empty, category: "question", categorySource: "model" })).toBe(
      "Likely a question",
    );
  });

  test("missing info only matters when the next step is to ask", () => {
    expect(whyLine({ ...empty, action: "ask_author", missing: "versions" })).toBe(
      "missing versions",
    );
    expect(whyLine({ ...empty, action: "accept", missing: "versions" })).toBe("");
    expect(whyLine({ ...empty, duplicateOf: "I_9" })).toBe("possible duplicate");
  });
});
