import { describe, expect, test } from "vite-plus/test";
import { assertCoversAll, renderPatch, splitPatch } from "../src/review/index.ts";

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

describe("review coverage", () => {
  test("every file in exactly one step, or a loud failure", () => {
    const groups = [
      { name: "A", summary: "s", files: ["a.ts"] },
      { name: "B", summary: "s", files: ["b.ts"] },
    ];
    expect(() => assertCoversAll(groups, ["a.ts", "b.ts"])).not.toThrow();
    expect(() => assertCoversAll(groups, ["a.ts", "b.ts", "c.ts"])).toThrow(/not placed.*c\.ts/);
    expect(() => assertCoversAll(groups, ["a.ts"])).toThrow(/not in the diff.*b\.ts/);
    expect(() =>
      assertCoversAll([...groups, { name: "C", summary: "s", files: ["a.ts"] }], ["a.ts", "b.ts"]),
    ).toThrow(/two steps/);
  });
});
