import { describe, expect, test } from "vite-plus/test";
import {
  buildReviewPrompt,
  extractReviewResult,
  generateReview,
  normalizeGroups,
  renderPatch,
  splitPatch,
} from "../src/review/index.ts";

const file = (path: string, opts: { status?: "A" | "D" | "M"; lines?: number } = {}) => {
  const status = opts.status ?? "M";
  const n = opts.lines ?? 2;
  const mode =
    status === "A" ? "new file mode 100644\n" : status === "D" ? "deleted file mode 100644\n" : "";
  const body = Array.from({ length: n }, (_, i) => `+line ${i}`).join("\n");
  return `diff --git a/${path} b/${path}\n${mode}--- a/${path}\n+++ b/${path}\n@@ -1 +1,${n} @@\n-old\n${body}\n`;
};

describe("patch rendering", () => {
  test("splits files with status and counts", () => {
    const files = splitPatch(
      file("src/a.ts") + file("docs/new.md", { status: "A" }) + file("old.txt", { status: "D" }),
    );
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["src/a.ts", "M", 2, 1],
      ["docs/new.md", "A", 2, 1],
      ["old.txt", "D", 2, 1],
    ]);
  });

  test("manifest is complete while bodies respect the budget", () => {
    const patch =
      file("src/a.ts", { lines: 40 }) +
      file("src/b.ts", { lines: 40 }) +
      file("pnpm-lock.yaml", { lines: 5 });
    const r = renderPatch(patch, 600);
    expect(r.files).toEqual(["src/a.ts", "src/b.ts", "pnpm-lock.yaml"]);
    expect(r.manifest.split("\n")).toHaveLength(3);
    expect(r.diff).toContain("+line 39");
    expect(r.diff).toContain("omitted for length");
    expect(r.diff).toContain("generated or lockfile");
    expect(r.omitted).toBe(2);
  });

  test("deleted files never spend budget", () => {
    const r = renderPatch(file("gone.ts", { status: "D", lines: 100 }));
    expect(r.diff).toContain("deleted file");
    expect(r.omitted).toBe(1);
  });
});

describe("review results", () => {
  test("extracts JSON from fences and prose", () => {
    const json = '{"groups":[{"name":"Core","summary":"It does a thing.","files":["a.ts"]}]}';
    expect(extractReviewResult("```json\n" + json + "\n```").groups[0]!.name).toBe("Core");
    expect(
      extractReviewResult("Sure! Here you go: " + json + " Hope that helps.").groups,
    ).toHaveLength(1);
    expect(() => extractReviewResult("no json here")).toThrow(/no JSON/);
    expect(() => extractReviewResult('{"groups":[]}')).toThrow();
  });

  test("normalizeGroups drops unknown files, keeps first assignment, sweeps the rest", () => {
    const out = normalizeGroups(
      [
        { name: "One", summary: "s", files: ["a.ts", "ghost.ts"] },
        { name: "Two", summary: "s", files: ["a.ts", "b.ts"] },
        { name: "Empty", summary: "s", files: ["ghost.ts"] },
      ],
      ["a.ts", "b.ts", "c.ts"],
    );
    expect(out.map((g) => [g.name, g.files])).toEqual([
      ["One", ["a.ts"]],
      ["Two", ["b.ts"]],
      ["Everything else", ["c.ts"]],
    ]);
  });
});

describe("prompt", () => {
  const req = {
    patch: file("src/core.ts") + file("src/core.test.ts"),
    intent: {
      title: "Add widgets",
      body: "Because.",
      author: "ann",
      headRef: "feat",
      baseRef: "main",
    },
    previousGroups: [{ name: "Old step", summary: "s", files: ["src/core.ts"] }],
    classification: "1. src/core.ts (core logic)",
  };

  test("carries rules, intent, classification, previous groups, manifest and diff", () => {
    const p = buildReviewPrompt(req, null);
    for (const s of [
      "GUIDED code review",
      "<intent>",
      "Title: Add widgets",
      "<classification>",
      "<previous-groups>",
      "Old step",
      "<files>",
      "M +2 -1 src/core.ts",
      "<diff>",
    ])
      expect(p).toContain(s);
    expect(p).not.toContain("previous response was rejected");
    expect(buildReviewPrompt(req, "bad shape")).toContain("rejected: bad shape");
  });

  test("generateReview retries once with the error folded in, then gives up", async () => {
    const prompts: string[] = [];
    const answers = [
      "not json",
      '{"groups":[{"name":"Core","summary":"s","files":["src/core.ts"]}]}',
    ];
    const result = await generateReview(req, async (p) => {
      prompts.push(p);
      return answers.shift()!;
    });
    expect(result.groups[0]!.name).toBe("Core");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("rejected");
    await expect(generateReview(req, async () => "nope")).rejects.toThrow(/failed validation/);
  });
});
