import { describe, expect, test } from "vite-plus/test";
import {
  anchorLines,
  askJson,
  buildAssignQuestions,
  buildAssignState,
  buildChangeQuestions,
  buildNarrativePrompt,
  buildSkeletonPrompt,
  changedFiles,
  extractJson,
  foldAssignments,
  foldChanges,
  groupsFromAssignments,
  narrativeSchema,
  narrativeSchemaFor,
  numberedDiff,
  reusableSteps,
  skeletonSchema,
  splitPatch,
  stripOffsets,
  type ClassifiedFile,
} from "../src/review/index.ts";

const intent = {
  title: "Add widgets",
  body: "Because.",
  author: "ann",
  headRef: "f",
  baseRef: "m",
};
const file = (path: string, body: string, at = 1) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -${at} +${at},2 @@\n-old\n${body}\n`;
const patch =
  file("src/core.ts", "+core") +
  file("src/core.test.ts", "+test") +
  file("pnpm-lock.yaml", "+lock");
const files = splitPatch(patch);
const steps = [
  { name: "Add the widget", intent: "The new widget itself." },
  { name: "Tests", intent: "Tests for the widget." },
];

describe("skeleton and narrative prompts", () => {
  test("skeleton lists every file, omits skim bodies, carries the proposal and kept steps", () => {
    const p = buildSkeletonPrompt(
      {
        intent,
        files,
        classification: "1. src/core.ts: role core",
        reusedSteps: [{ name: "Tests", summary: "Old text.", files: ["src/core.test.ts"] }],
        skimPaths: new Set(["pnpm-lock.yaml"]),
        tools: true,
      },
      null,
    );
    expect(p).toContain('{"steps":[{"name":"...","intent":"..."}]}');
    expect(p).toContain("M +1 -1 pnpm-lock.yaml");
    expect(p).toContain("1 mechanical files omitted");
    expect(p).toContain("<classification>");
    expect(p).toContain("<kept>");
    expect(p).toContain("rank_files");
    expect(p).not.toContain("+lock");
    expect(
      buildSkeletonPrompt(
        {
          intent,
          files,
          classification: null,
          reusedSteps: [],
          skimPaths: new Set(),
          tools: false,
        },
        "bad",
      ),
    ).toContain("rejected: bad");
  });

  test("narrative sees only its step's files, numbered, and the other steps by name", () => {
    const p = buildNarrativePrompt(
      {
        intent,
        step: steps[0]!,
        index: 0,
        allSteps: steps,
        files: [files[0]!],
        classification: null,
        tools: false,
      },
      null,
    );
    expect(p).toContain("1. Add the widget (this step)");
    expect(p).toContain("2. Tests:");
    expect(p).toContain("          1 |+core");
    expect(p).toContain("    1       |-old");
    expect(p).not.toContain("+test");
    expect(p).not.toContain("rank_files");
    expect(p).toContain('"annotations"');
    expect(p).toContain('"kind":"bug"');
    expect(p).toContain("ONE paragraph");
    const parsed = narrativeSchema.parse({
      summary: "s",
      annotations: [{ path: "src/core.ts", kind: "question", text: "why?" }],
    });
    expect(parsed.annotations[0]).toEqual({
      path: "src/core.ts",
      side: "new",
      line: 0,
      kind: "question",
      text: "why?",
    });
    expect(narrativeSchema.parse({ summary: "s" }).annotations).toEqual([]);
  });

  test("numbered diff and anchors follow the hunk headers", () => {
    const f = splitPatch(
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +12,4 @@\n keep\n-gone\n+new1\n+new2\n tail\n",
    )[0]!;
    expect(numberedDiff(f).split("\n").slice(3)).toEqual([
      "@@ -10,3 +12,4 @@",
      "   10    12 | keep",
      "   11       |-gone",
      "         13 |+new1",
      "         14 |+new2",
      "   12    15 | tail",
      "",
    ]);
    const a = anchorLines(f);
    expect([...a.old]).toEqual([10, 11, 12]);
    expect([...a.new]).toEqual([12, 13, 14, 15]);
  });

  test("narrativeSchemaFor rejects anchors that are not in the step's diff", () => {
    const schema = narrativeSchemaFor([files[0]!]);
    const ok = (a: object) => schema.safeParse({ summary: "s", annotations: [a] });
    expect(ok({ path: "src/core.ts", side: "new", line: 1, kind: "bug", text: "t" }).success).toBe(
      true,
    );
    expect(ok({ path: "src/core.ts", side: "old", line: 1, kind: "nit", text: "t" }).success).toBe(
      true,
    );
    expect(ok({ path: "src/core.ts", line: 0, kind: "consideration", text: "t" }).success).toBe(
      true,
    );
    const wrongLine = ok({ path: "src/core.ts", side: "new", line: 7, kind: "bug", text: "t" });
    expect(wrongLine.success).toBe(false);
    if (!wrongLine.success)
      expect(wrongLine.error.issues[0]!.message).toContain(
        "new line 7 of src/core.ts is not in the diff",
      );
    const wrongSide = ok({ path: "src/core.ts", side: "old", line: 2, kind: "bug", text: "t" });
    expect(wrongSide.success).toBe(false);
    const wrongFile = ok({ path: "src/other.ts", line: 0, kind: "bug", text: "t" });
    expect(wrongFile.success).toBe(false);
    if (!wrongFile.success)
      expect(wrongFile.error.issues[0]!.message).toContain("not one of this step's files");
  });

  test("extractJson and askJson validate and retry once", async () => {
    expect(
      extractJson('```json\n{"steps":[{"name":"a","intent":"b"}]}\n```', skeletonSchema).steps,
    ).toHaveLength(1);
    const answers = ["nope", '{"steps":[{"name":"a","intent":"b"}]}'];
    const prompts: string[] = [];
    const out = await askJson(
      (prev) => `prompt ${prev ?? ""}`,
      skeletonSchema,
      async (p) => {
        prompts.push(p);
        return answers.shift()!;
      },
    );
    expect(out.steps[0]!.name).toBe("a");
    expect(prompts[1]).toContain("contained no JSON");
    await expect(
      askJson(
        () => "p",
        skeletonSchema,
        async () => "x",
      ),
    ).rejects.toThrow(/failed validation/);
  });
});

describe("assignment", () => {
  test("questions offer every step plus none; answers fold by index", () => {
    const q = buildAssignQuestions(2, steps) as Record<
      string,
      { criteria: Record<string, string> }
    >;
    expect(Object.keys(q)).toEqual(["s0__step", "s1__step"]);
    expect(Object.keys(q.s0__step!.criteria)).toEqual(["step_1", "step_2", "none"]);
    expect(buildAssignState(intent, steps, files).files[0]!.diff_excerpt).toContain("+core");
    const folded = foldAssignments(
      {
        s0__step: { type: "choice", choice: "step_1", confidence: 0.9, probabilities: {} },
        s1__step: { type: "choice", choice: "none", confidence: 0.5, probabilities: {} },
      } as never,
      3,
    );
    expect(folded).toEqual([
      { step: 0, confidence: 0.9 },
      { step: null, confidence: 0.5 },
      { step: null, confidence: null },
    ]);
  });

  test("groups follow the steps, drop empty ones, sweep the unplaced, order by entry and risk", () => {
    const classified: ClassifiedFile[] = [
      {
        path: "src/core.ts",
        status: "M",
        added: 1,
        removed: 1,
        signal: {
          role: "core",
          roleConfidence: 1,
          risk: 0.3,
          attention: 0.5,
          entry: 0.9,
          probabilities: {},
        },
      },
    ];
    const groups = groupsFromAssignments(
      steps,
      files,
      [
        { step: 0, confidence: 1 },
        { step: 0, confidence: 1 },
        { step: null, confidence: null },
      ],
      classified,
    );
    expect(groups.map((g) => g.name)).toEqual(["Add the widget", "Supporting changes"]);
    expect(groups[0]!.files).toEqual(["src/core.ts", "src/core.test.ts"]);
    expect(groups[1]!.files).toEqual(["pnpm-lock.yaml"]);
    expect(groups[0]!.summary).toBe("");
  });
});

describe("incremental regeneration", () => {
  test("changedFiles ignores hunk offsets and index lines", () => {
    const before = splitPatch(file("a.ts", "+x", 10) + file("b.ts", "+y"));
    const after = splitPatch(file("a.ts", "+x", 42) + file("b.ts", "+z"));
    expect(changedFiles(before, after).map((c) => c.path)).toEqual(["b.ts"]);
    expect(stripOffsets("@@ -1 +1 @@\nindex abc\n+x")).toBe("+x");
    expect(Object.keys(buildChangeQuestions(2))).toEqual(["c0__material", "c1__material"]);
    expect(foldChanges({ c1__material: { type: "noul", noul: 0.2 } } as never, 2)).toEqual([
      null,
      0.2,
    ]);
  });

  test("reusableSteps keeps steps whose files are all present and unchanged", () => {
    const prev = [
      { name: "A", summary: "text", files: ["a.ts"] },
      { name: "B", summary: "text", files: ["b.ts", "a.ts"] },
      { name: "C", summary: "text", files: ["gone.ts"] },
      { name: "D", summary: "", files: ["a.ts"] },
    ];
    const kept = reusableSteps(prev, new Set(["a.ts", "b.ts"]), new Set(["b.ts"]));
    expect(kept.map((g) => g.name)).toEqual(["A"]);
  });
});
