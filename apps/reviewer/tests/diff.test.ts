import { describe, expect, test } from "vite-plus/test";
import { splitPatch } from "@triage/triage/review";
import { buildPatch, changedPaths, contentHash, fileChunk, type Manifest } from "../src/diff.ts";

const manifest = (
  files: Record<string, string>,
  skipped: Record<string, [number, string]> = {},
): Manifest => ({
  files: new Map(
    Object.entries(files).map(([p, t]) => [p, { size: t.length, hash: contentHash(t) }]),
  ),
  skipped: new Map(Object.entries(skipped).map(([p, [size, reason]]) => [p, { size, reason }])),
});

describe("snapshot diff", () => {
  test("changed paths: modified by hash, added, deleted, skipped by size, mixed sides", () => {
    const base = manifest(
      { "a.ts": "one\n", "same.ts": "x\n", "gone.ts": "bye\n", "grew.ts": "small\n" },
      {
        "img.png": [10, "binary"],
        "lock.yaml": [100, "generated or vendored"],
        "same.bin": [5, "binary"],
      },
    );
    const head = manifest(
      { "a.ts": "two\n", "same.ts": "x\n", "new.ts": "hi\n" },
      {
        "img.png": [12, "binary"],
        "lock.yaml": [100, "generated or vendored"],
        "same.bin": [5, "binary"],
        "grew.ts": [300_000, "too large"],
      },
    );
    expect(changedPaths(base, head)).toEqual([
      { path: "a.ts", kind: "modified", text: true },
      { path: "gone.ts", kind: "deleted", text: true },
      { path: "grew.ts", kind: "modified", text: false },
      { path: "img.png", kind: "modified", text: false },
      { path: "new.ts", kind: "added", text: true },
    ]);
  });

  test("chunks are git unified format the patch splitter and counts understand", async () => {
    const base = manifest(
      { "src/a.ts": "keep\nold\ntail\n", "gone.ts": "x\n" },
      { "img.png": [3, "binary"] },
    );
    const head = manifest(
      { "src/a.ts": "keep\nnew\ntail\n", "new.ts": "a\nb" },
      { "img.png": [4, "binary"] },
    );
    const texts = {
      base: new Map([
        ["src/a.ts", "keep\nold\ntail\n"],
        ["gone.ts", "x\n"],
      ]),
      head: new Map([
        ["src/a.ts", "keep\nnew\ntail\n"],
        ["new.ts", "a\nb"],
      ]),
    };
    const { patch, changes } = await buildPatch(
      base,
      head,
      async (side, paths) => new Map(paths.map((p) => [p, texts[side].get(p)!])),
    );
    expect(changes.map((c) => c.path)).toEqual(["gone.ts", "img.png", "new.ts", "src/a.ts"]);
    expect(patch).toContain(
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail\n",
    );
    expect(patch).toContain(
      "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n",
    );
    expect(patch).toContain(
      "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n",
    );
    expect(patch).toContain(
      "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n",
    );
    const files = splitPatch(patch);
    expect(files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["gone.ts", "D", 0, 1],
      ["img.png", "M", 0, 0],
      ["new.ts", "A", 2, 0],
      ["src/a.ts", "M", 1, 1],
    ]);
  });

  test("empty files are created and emptied as text, never stubs", async () => {
    const base = manifest({ "was.ts": "x\n" }, { "stays.txt": [0, "empty"] });
    const head = manifest(
      {},
      { "was.ts": [0, "empty"], "stays.txt": [0, "empty"], "born.txt": [0, "empty"] },
    );
    const { patch, changes } = await buildPatch(
      base,
      head,
      async (side, paths) =>
        new Map(paths.map((p) => [p, side === "base" && p === "was.ts" ? "x\n" : ""])),
    );
    expect(changes).toEqual([
      { path: "born.txt", kind: "added", text: true },
      { path: "was.ts", kind: "modified", text: true },
    ]);
    expect(patch).toContain(
      "diff --git a/born.txt b/born.txt\nnew file mode 100644\n--- /dev/null\n+++ b/born.txt\n",
    );
    expect(patch).toContain(
      "diff --git a/was.ts b/was.ts\n--- a/was.ts\n+++ b/was.ts\n@@ -1 +0,0 @@\n-x\n",
    );
    expect(splitPatch(patch).map((f) => [f.path, f.status])).toEqual([
      ["born.txt", "A"],
      ["was.ts", "M"],
    ]);
  });

  test("a single-line hunk header omits the count, like git", () => {
    const chunk = fileChunk({ path: "one.txt", kind: "modified", text: true }, "a\n", "b\n");
    expect(chunk).toContain("@@ -1 +1 @@\n-a\n+b\n");
  });

  test("content hashes separate texts and carry the length", () => {
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("")).toMatch(/^[0-9a-f]{16}0$/);
  });
});
