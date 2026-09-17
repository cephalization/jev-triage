import { describe, expect, test } from "vite-plus/test";

// classificationRows imports the db module (which needs env); stub the env before import.
process.env.ZERO_UPSTREAM_DB ??= "postgres://unused";
process.env.AUTH_SECRET ??= "test";
const { classificationRows } = await import("../src/worker/classifier.ts");

describe("classificationRows", () => {
  test("writes one row per answered family with normalised values", () => {
    const issue = {
      id: "I_1",
      number: 1,
      title: "t",
      body: "",
      state: "open",
      labels: [],
      comments: 0,
      reactions: 0,
      ageDays: 1,
      authorAssociation: "NONE",
      candidates: [{ id: "I_2", number: 2, title: "dup" }],
    };
    const rows = classificationRows(
      issue,
      {
        category: {
          type: "choice",
          choice: "bug",
          confidence: 0.9,
          probabilities: { bug: 0.9, other: 0.1 },
        },
        severity: {
          type: "score",
          score: 3,
          confidence: 0.7,
          legend: {},
          probabilities: { 3: 0.7 },
        },
        needs_info: { type: "noul", noul: 0.25 },
        duplicate: {
          type: "choice",
          choice: "candidate_0",
          confidence: 0.95,
          probabilities: { candidate_0: 0.95, none: 0.05 },
        },
      },
      1,
      "jev-test",
      "run1",
      "acme/widgets",
    );
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(Object.keys(byKind).sort()).toEqual(["category", "duplicate", "needs_info", "severity"]);
    expect(byKind.category!.value).toBe("bug");
    expect(byKind.severity!.value).toBe("1.0000");
    expect(byKind.needs_info!.value).toBe("0.2500");
    expect(byKind.needs_info!.confidence).toBeCloseTo(0.75);
    expect(byKind.duplicate!.value).toBe("I_2");
    expect((byKind.duplicate!.probabilities_json as unknown as { value: unknown }).value).toEqual({
      "#2": 0.95,
      none: 0.05,
    });
    expect(rows.every((r) => r.questions_version === 1 && r.model === "jev-test")).toBe(true);
  });

  test("duplicate below threshold stores none", () => {
    const issue = {
      id: "I_1",
      number: 1,
      title: "t",
      body: "",
      state: "open",
      labels: [],
      comments: 0,
      reactions: 0,
      ageDays: 1,
      authorAssociation: "NONE",
      candidates: [{ id: "I_2", number: 2, title: "dup" }],
    };
    const rows = classificationRows(
      issue,
      {
        duplicate: {
          type: "choice",
          choice: "candidate_0",
          confidence: 0.4,
          probabilities: { candidate_0: 0.4, none: 0.6 },
        },
      },
      1,
      "m",
      "r",
      "repo",
    );
    expect(rows[0]!.value).toBe("none");
  });
});
