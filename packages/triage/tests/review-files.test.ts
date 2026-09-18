import { describe, expect, test } from "vite-plus/test";
import {
  buildFileQuestions,
  buildFileState,
  decideFile,
  excerptOf,
  FILE_ATTENTION_LEVELS,
  FILE_RISK_LEVELS,
  foldFileAnswers,
  groupSeed,
  parseFileKey,
  renderClassification,
  splitPatch,
  type ClassifiedFile,
  type FileSignal,
} from "../src/review/index.ts";

const intent = { title: "Add widgets", body: "Because.", author: "a", headRef: "f", baseRef: "m" };
const patch =
  "diff --git a/src/core.ts b/src/core.ts\n--- a/src/core.ts\n+++ b/src/core.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n" +
  "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1 +1 @@\n-a\n+b\n";

const signal = (over: Partial<FileSignal>): FileSignal => ({
  role: "supporting",
  roleConfidence: 0.8,
  risk: 0.3,
  attention: 0.5,
  entry: 0.1,
  probabilities: {},
  ...over,
});
const cf = (path: string, over: Partial<FileSignal>): ClassifiedFile => ({
  path,
  status: "M",
  added: 1,
  removed: 1,
  signal: signal(over),
});

describe("file questions", () => {
  test("state carries an excerpt per file and the intent", () => {
    const files = splitPatch(patch);
    const state = buildFileState(intent, files);
    expect(state.pull_request.title).toBe("Add widgets");
    expect(state.files[0]).toMatchObject({
      path: "src/core.ts",
      status: "modified",
      added_lines: 2,
    });
    expect(state.files[0]!.diff_excerpt).toContain("+new");
    expect(excerptOf(files[0]!, 10)).toMatch(/more chars\)$/);
  });

  test("four families per file, keyed by index", () => {
    const q = buildFileQuestions(2);
    expect(Object.keys(q).sort()).toEqual([
      "f0__attention",
      "f0__entry",
      "f0__risk",
      "f0__role",
      "f1__attention",
      "f1__entry",
      "f1__risk",
      "f1__role",
    ]);
    expect(parseFileKey("f3__risk")).toEqual({ index: 3, family: "risk" });
    expect(parseFileKey("p0__risk")).toBeNull();
    expect(parseFileKey("f0__nope")).toBeNull();
  });

  test("fold and decide normalise scores to 0..1 and default an unknown role", () => {
    const folded = foldFileAnswers(
      {
        f0__role: { type: "choice", choice: "core", confidence: 0.9, probabilities: { core: 0.9 } },
        f0__risk: {
          type: "score",
          score: FILE_RISK_LEVELS.length - 1,
          confidence: 0.7,
          probabilities: { "3": 1 },
          legend: {} as never,
        },
        f0__attention: {
          type: "score",
          score: 1,
          confidence: 0.6,
          probabilities: { "1": 1 },
          legend: {} as never,
        },
        f0__entry: { type: "noul", noul: 0.8 },
        f1__role: { type: "choice", choice: "mystery", confidence: 0.2, probabilities: {} },
        f9__role: { type: "choice", choice: "core", confidence: 1, probabilities: {} },
      } as never,
      2,
    );
    const a = decideFile(folded[0]!);
    expect(a).toMatchObject({ role: "core", risk: 1, entry: 0.8 });
    expect(a.attention).toBeCloseTo(1 / (FILE_ATTENTION_LEVELS.length - 1));
    expect(a.probabilities.role).toEqual({ core: 0.9 });
    expect(decideFile(folded[1]!)).toMatchObject({ role: "supporting", risk: null, entry: null });
  });
});

describe("group seed", () => {
  const files = [
    cf("pnpm-lock.yaml", { role: "generated", risk: 0, attention: 0 }),
    cf("src/api.ts", { role: "supporting" }),
    cf("src/core.test.ts", { role: "tests" }),
    cf("src/core.ts", { role: "core", risk: 0.6, entry: 0.9 }),
    cf("src/types.ts", { role: "core", risk: 0.9, entry: 0.2 }),
    cf("README.md", { role: "docs" }),
    cf(".github/ci.yml", { role: "config" }),
    cf("src/fmt.ts", { role: "formatting" }),
  ];

  test("orders core, adoption, tests, docs, config, churn; entry points lead their step", () => {
    const groups = groupSeed(files);
    expect(groups.map((g) => g.name)).toEqual([
      "The core change",
      "Code that adopts the change",
      "Tests",
      "Documentation",
      "Configuration and build",
      "Supporting changes",
    ]);
    expect(groups[0]!.files).toEqual(["src/core.ts", "src/types.ts"]);
    expect(groups.at(-1)!.files).toEqual(["src/fmt.ts", "pnpm-lock.yaml"]);
    expect(groups.flatMap((g) => g.files).sort()).toEqual(files.map((f) => f.path).sort());
  });

  test("skips empty steps", () => {
    expect(groupSeed([cf("a.ts", { role: "tests" })]).map((g) => g.name)).toEqual(["Tests"]);
  });

  test("renders the proposal with the why per file", () => {
    const text = renderClassification(files);
    expect(text).toContain("## The core change");
    expect(text).toContain(
      "1. src/core.ts: role core (80%), risk high, attention read, entry point",
    );
    expect(text).toContain("pnpm-lock.yaml: role generated (80%), risk low, attention skim");
    expect(text).not.toContain(
      "src/api.ts: role supporting (80%), risk low, attention read, entry point",
    );
  });
});
