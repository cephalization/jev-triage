import { structuredPatch } from "diff";

/**
 * A pull request's diff built from two snapshots, because GitHub refuses to serve a diff past
 * 300 files or 20,000 lines. Both sides are the cell's file tables: path, size and a content
 * hash for every text file kept, plus the files the snapshot rules left out (binary, generated,
 * too large). Text files are diffed here; a file left out on either side is reported as a
 * binary change, which is what its reviewer sees as a stub either way.
 *
 * The output is the git unified format the rest of the system already reads: `diff --git`
 * headers, `new file mode` / `deleted file mode`, `---`/`+++` with `/dev/null`, `@@` hunks
 * with three lines of context, and `\ No newline at end of file` where it applies.
 */

export interface ManifestEntry {
  size: number;
  hash: string;
}
export interface SkippedEntry {
  size: number;
  reason: string;
}
export interface Manifest {
  files: Map<string, ManifestEntry>;
  skipped: Map<string, SkippedEntry>;
}

export type Change =
  | { path: string; kind: "added" | "deleted" | "modified"; text: true }
  | { path: string; kind: "added" | "deleted" | "modified"; text: false };

/** An empty file is text with nothing in it, not a stub: a diff can create or empty one. */
export function withEmptyFiles(m: Manifest): Manifest {
  const files = new Map(m.files);
  const skipped = new Map<string, SkippedEntry>();
  for (const [path, entry] of m.skipped)
    if (entry.reason === "empty") files.set(path, { size: 0, hash: contentHash("") });
    else skipped.set(path, entry);
  return { files, skipped };
}

/** Which paths differ between the two sides, and whether both sides are text. */
export function changedPaths(base: Manifest, head: Manifest): Change[] {
  const paths = new Set([
    ...base.files.keys(),
    ...base.skipped.keys(),
    ...head.files.keys(),
    ...head.skipped.keys(),
  ]);
  const out: Change[] = [];
  for (const path of [...paths].sort()) {
    const b = base.files.get(path);
    const h = head.files.get(path);
    const bs = base.skipped.get(path);
    const hs = head.skipped.get(path);
    const inBase = b !== undefined || bs !== undefined;
    const inHead = h !== undefined || hs !== undefined;
    if (!inBase && !inHead) continue;
    if (b && h) {
      if (b.hash !== h.hash) out.push({ path, kind: "modified", text: true });
      continue;
    }
    if (bs && hs) {
      if (bs.size !== hs.size) out.push({ path, kind: "modified", text: false });
      continue;
    }
    if (!inBase) out.push({ path, kind: "added", text: h !== undefined });
    else if (!inHead) out.push({ path, kind: "deleted", text: b !== undefined });
    else out.push({ path, kind: "modified", text: false });
  }
  return out;
}

const CONTEXT = 3;

/** One file's chunk in git unified format; `oldText`/`newText` are null for the missing side. */
export function fileChunk(change: Change, oldText: string | null, newText: string | null): string {
  const { path, kind } = change;
  const lines = [`diff --git a/${path} b/${path}`];
  if (kind === "added") lines.push("new file mode 100644");
  if (kind === "deleted") lines.push("deleted file mode 100644");
  if (!change.text) {
    lines.push(
      `Binary files ${kind === "added" ? "/dev/null" : `a/${path}`} and ${kind === "deleted" ? "/dev/null" : `b/${path}`} differ`,
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(kind === "added" ? "--- /dev/null" : `--- a/${path}`);
  lines.push(kind === "deleted" ? "+++ /dev/null" : `+++ b/${path}`);
  const patch = structuredPatch(path, path, oldText ?? "", newText ?? "", "", "", {
    context: CONTEXT,
  });
  for (const h of patch.hunks) {
    // git writes an empty side as line 0; jsdiff writes 1.
    const oldStart = h.oldLines === 0 ? 0 : h.oldStart;
    const newStart = h.newLines === 0 ? 0 : h.newStart;
    lines.push(
      `@@ -${oldStart}${h.oldLines === 1 ? "" : `,${h.oldLines}`} +${newStart}${h.newLines === 1 ? "" : `,${h.newLines}`} @@`,
    );
    for (const l of h.lines) lines.push(l);
  }
  return `${lines.join("\n")}\n`;
}

/** The whole patch: every changed file in path order. */
export async function buildPatch(
  base: Manifest,
  head: Manifest,
  read: (side: "base" | "head", paths: string[]) => Promise<Map<string, string>>,
): Promise<{ patch: string; changes: Change[] }> {
  const changes = changedPaths(withEmptyFiles(base), withEmptyFiles(head));
  const textChanges = changes.filter((c) => c.text);
  const [oldTexts, newTexts] = await Promise.all([
    read(
      "base",
      textChanges.filter((c) => c.kind !== "added").map((c) => c.path),
    ),
    read(
      "head",
      textChanges.filter((c) => c.kind !== "deleted").map((c) => c.path),
    ),
  ]);
  const parts = changes.map((c) =>
    fileChunk(
      c,
      c.kind === "added" ? null : (oldTexts.get(c.path) ?? ""),
      c.kind === "deleted" ? null : (newTexts.get(c.path) ?? ""),
    ),
  );
  return { patch: parts.join(""), changes };
}

/** A fast content hash for change detection: two FNV-1a passes over the code units, hex. */
export function contentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
    b = (b ^ (b >>> 15)) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}${text.length.toString(16)}`;
}
