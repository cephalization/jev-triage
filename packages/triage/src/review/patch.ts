/**
 * A unified diff, split per file and rendered for a model: a manifest that is never
 * truncated, plus file bodies under a character budget with explicit stubs for what is left
 * out. The manifest is what lets the model place every file even when it cannot read them all.
 */

export interface PatchFile {
  /** Repo-relative path from the header's `b/` side. */
  path: string;
  status: "A" | "D" | "M";
  added: number;
  removed: number;
  /** Full chunk text, header included. */
  text: string;
}

export function splitPatch(patch: string): PatchFile[] {
  const out: PatchFile[] = [];
  const chunks = patch.split(/(?=^diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    const nl = chunk.indexOf("\n");
    const header = nl === -1 ? chunk : chunk.slice(0, nl);
    const bSide = / b\/(.+)$/.exec(header)?.[1] ?? / "b\/(.+)"$/.exec(header)?.[1];
    if (bSide === undefined) continue;
    let added = 0;
    let removed = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    out.push({
      path: bSide.replace(/^"|"$/g, ""),
      status: chunk.includes("\ndeleted file mode")
        ? "D"
        : chunk.includes("\nnew file mode")
          ? "A"
          : "M",
      added,
      removed,
      text: chunk,
    });
  }
  return out;
}

/** Diff bodies that spend tokens without helping the grouping decision. */
const NOISE = [
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|Cargo\.lock|Gemfile\.lock|go\.sum)$/,
  /(?:^|\/)__generated__\//,
  /\.(?:snap|min\.js|min\.css)$/,
];

export const DEFAULT_BODY_BUDGET = 150_000;

export interface RenderedPatch {
  /** `M +12 -3 path` per file, complete. */
  manifest: string;
  /** Bodies within budget; omitted ones carry a stub line after the header. */
  diff: string;
  omitted: number;
  files: string[];
}

export function renderPatch(patch: string, budget = DEFAULT_BODY_BUDGET): RenderedPatch {
  return renderFiles(splitPatch(patch), budget, (f) => f.text);
}

/**
 * The manifest plus bodies under a budget, each body rendered by `body` (the raw chunk, or a
 * line-numbered one). A deleted file or generated content is a stub whatever the budget.
 */
export function renderFiles(
  files: readonly PatchFile[],
  budget: number,
  body: (file: PatchFile) => string,
): RenderedPatch {
  const manifest = files.map((f) => `${f.status} +${f.added} -${f.removed} ${f.path}`).join("\n");
  let left = budget;
  let omitted = 0;
  const parts = files.map((f) => {
    const header = f.text.slice(0, f.text.indexOf("\n"));
    if (f.status === "D" || NOISE.some((re) => re.test(f.path))) {
      omitted += 1;
      const why = f.status === "D" ? "deleted file" : "generated or lockfile content";
      return `${header}\n[... body omitted: ${why}; group by path and status ...]\n`;
    }
    const text = body(f);
    if (text.length <= left) {
      left -= text.length;
      return text;
    }
    omitted += 1;
    return `${header}\n[... body omitted for length (+${f.added} -${f.removed}); group by path, status and size ...]\n`;
  });
  return { manifest, diff: parts.join(""), omitted, files: files.map((f) => f.path) };
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The chunk with every hunk line prefixed by its old and new line numbers, so a model can cite
 * a line the way a reviewer would: `   12    15 | context`, `   13       |-removed`,
 * `         16 |+added`. Headers and hunk markers pass through unchanged.
 */
export function numberedDiff(file: PatchFile): string {
  const out: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of file.text.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      out.push(line);
      continue;
    }
    if (!inHunk || line.startsWith("\\")) {
      out.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      out.push(`${"".padStart(5)} ${String(newLine).padStart(5)} |${line}`);
      newLine += 1;
    } else if (line.startsWith("-")) {
      out.push(`${String(oldLine).padStart(5)} ${"".padStart(5)} |${line}`);
      oldLine += 1;
    } else if (line === "") {
      out.push(line);
    } else {
      out.push(`${String(oldLine).padStart(5)} ${String(newLine).padStart(5)} |${line}`);
      oldLine += 1;
      newLine += 1;
    }
  }
  return out.join("\n");
}

/** The line numbers a comment can anchor to: new-side for added and unchanged lines, old-side for removed and unchanged. */
export function anchorLines(file: PatchFile): { old: Set<number>; new: Set<number> } {
  const anchors = { old: new Set<number>(), new: new Set<number>() };
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of file.text.split("\n")) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line === "" || line.startsWith("\\")) continue;
    if (line.startsWith("+")) anchors.new.add(newLine++);
    else if (line.startsWith("-")) anchors.old.add(oldLine++);
    else {
      anchors.old.add(oldLine++);
      anchors.new.add(newLine++);
    }
  }
  return anchors;
}
