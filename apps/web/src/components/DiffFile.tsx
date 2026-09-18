import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import type { ReviewAnnotationJson } from "@triage/schema";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { useResolvedTheme } from "../lib/theme.ts";
import { Tag } from "./Marks.tsx";

/**
 * One file's diff inside a review step, rendered by @pierre/diffs. Low-signal files (lockfiles,
 * generated output, very large diffs) start collapsed to a summary bar so the handwritten
 * changes carry the weight; one click expands.
 */

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "deno.lock",
  "flake.lock",
  "gemfile.lock",
  "go.sum",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);
const GENERATED_DIRS = /(^|\/)(dist|build|out|coverage|__generated__|__snapshots__|vendor)\//;
const GENERATED_FILES = /\.(min\.(js|css)|(js|css)\.map|snap|generated\.[^./]+|pb\.(go|cc|h))$/;
const LARGE_CHANGE_LINES = 300;

export type CollapseReason = "lockfile" | "generated" | "large diff" | "skim";

/** Why a file renders collapsed, or null to show it in full. `skim` comes from jev's attention answer. */
export function collapseReason(
  path: string,
  changedLines: number,
  attention: number | null | undefined,
): CollapseReason | null {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (LOCKFILES.has(base)) return "lockfile";
  if (GENERATED_DIRS.test(lower) || GENERATED_FILES.test(lower)) return "generated";
  if (changedLines > LARGE_CHANGE_LINES) return "large diff";
  if (attention !== null && attention !== undefined && attention < 0.2) return "skim";
  return null;
}

/** Same minimal scrollbars as the app, injected into the renderer's shadow root. */
const SCROLLBAR_CSS = `
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background-color: rgb(128 128 128 / 0.35); border-radius: 999px; border: 3px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-button { display: none; }
`;

export function splitPath(path: string): [string, string | null] {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? [path, null] : [path.slice(slash + 1), path.slice(0, slash)];
}

export function FileName({ path }: { path: string }) {
  const [name, dir] = splitPath(path);
  return (
    <span className="min-w-0 flex-1 truncate font-mono text-xs">
      <span className="text-foreground">{name}</span>
      {dir !== null && <span className="text-muted-foreground"> {dir}</span>}
    </span>
  );
}

export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-xs tabular-nums">
      <span className="text-status-good">+{added}</span>{" "}
      <span className="text-status-critical">−{removed}</span>
    </span>
  );
}

/** The model's inline comment as the review stores it, with a key the rail uses to jump to it. */
export interface DiffAnnotation extends ReviewAnnotationJson {
  key: string;
}

/** Judgment colours: round pill with a dot, like every other mark this app makes. */
export const ANNOTATION_COLORS: Record<ReviewAnnotationJson["kind"], string> = {
  bug: "var(--color-status-critical)",
  question: "var(--primary)",
  consideration: "var(--color-status-warning)",
  nit: "var(--muted-foreground)",
};

/**
 * One comment rendered inside the diff. The renderer mounts it inside its own shadow root, so
 * it is styled inline from the theme's variables rather than by the page's classes.
 */
function AnnotationCard({
  annotation,
  onNode,
}: {
  annotation: DiffAnnotation;
  onNode?: (key: string, el: HTMLElement | null) => void;
}) {
  return (
    <div
      ref={(el) => onNode?.(annotation.key, el)}
      style={{
        margin: "4px 12px 6px 56px",
        padding: "8px 12px",
        border: "1px solid var(--border)",
        borderRadius: 6,
        background: "var(--background)",
        color: "var(--foreground)",
        font: "13px/1.5 var(--font-sans, system-ui, sans-serif)",
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        whiteSpace: "normal",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 20,
          padding: "0 8px",
          border: "1px solid var(--border)",
          borderRadius: 999,
          fontSize: 12,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: ANNOTATION_COLORS[annotation.kind],
          }}
        />
        {annotation.kind}
      </span>
      <span style={{ textWrap: "pretty" }}>{annotation.text}</span>
    </div>
  );
}

export function DiffFile({
  path,
  file,
  added,
  removed,
  reason,
  annotations = [],
  onAnnotationNode,
}: {
  path: string;
  file: FileDiffMetadata;
  added: number;
  removed: number;
  reason: CollapseReason | null;
  annotations?: DiffAnnotation[];
  onAnnotationNode?: (key: string, el: HTMLElement | null) => void;
}) {
  const themeType = useResolvedTheme();
  // A file the model commented on is worth reading whatever its size or role.
  const [expanded, setExpanded] = useState(reason === null || annotations.length > 0);
  const options = {
    theme: { dark: "github-dark-default", light: "github-light-default" },
    themeType,
    diffStyle: "unified",
    stickyHeader: true,
    lineDiffType: "word-alt",
    unsafeCSS: SCROLLBAR_CSS,
  } as const;
  const lineAnnotations = annotations.map((a) => ({
    side: a.side === "old" ? ("deletions" as const) : ("additions" as const),
    lineNumber: a.line,
    metadata: a,
  }));
  const diff = (
    <FileDiff<DiffAnnotation>
      fileDiff={file}
      options={options}
      lineAnnotations={lineAnnotations}
      renderAnnotation={(a) => <AnnotationCard annotation={a.metadata} onNode={onAnnotationNode} />}
    />
  );
  if (reason === null) return diff;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        title={expanded ? `Hide ${path}` : `Show ${path}`}
        className="flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-2 text-left transition-colors hover:bg-accent"
        onClick={() => setExpanded((v) => !v)}
      >
        <FileName path={path} />
        <Tag>{reason}</Tag>
        <Counts added={added} removed={removed} />
        {expanded ? (
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && diff}
    </div>
  );
}
