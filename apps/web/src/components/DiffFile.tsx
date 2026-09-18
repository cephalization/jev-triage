import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
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

export function DiffFile({
  path,
  file,
  added,
  removed,
  reason,
}: {
  path: string;
  file: FileDiffMetadata;
  added: number;
  removed: number;
  reason: CollapseReason | null;
}) {
  const themeType = useResolvedTheme();
  const [expanded, setExpanded] = useState(reason === null);
  const options = {
    theme: { dark: "github-dark-default", light: "github-light-default" },
    themeType,
    diffStyle: "unified",
    stickyHeader: true,
    lineDiffType: "word-alt",
    unsafeCSS: SCROLLBAR_CSS,
  } as const;
  if (reason === null) return <FileDiff fileDiff={file} options={options} />;
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
      {expanded && <FileDiff fileDiff={file} options={options} />}
    </div>
  );
}
