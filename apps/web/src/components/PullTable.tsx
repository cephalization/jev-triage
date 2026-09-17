import { cn } from "cn";
import { ArrowDown, ArrowUp, ArrowLeftRight, Check, MessageSquare } from "lucide-react";
import type { PullGroup, PullRow, PullSortKey, ReviewerMode } from "../lib/derive.ts";
import { agoShort, compact, pct } from "../lib/format.ts";
import { MEDIUM, NARROW, useWidth } from "../lib/useWidth.ts";
import type { UserInfo } from "./IssueTable.tsx";
import { EffortMark, PriorityBars, ReviewDecisionMark, StatusIcon, Tag } from "./Marks.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/** Column header sits under the 32px view strip; group rows stack under both. */
const TH =
  "sticky top-8 z-10 h-8 bg-background px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]";

export interface GroupInfo {
  approvals: number;
  open_load: number;
}

/** Same scheme as the issue table: identity, this app's judgments, then GitHub's facts. */
interface Column {
  key: string;
  width: string;
  head: React.ReactNode;
  sortKey?: PullSortKey;
  headClass?: string;
  cellClass?: string;
  cell: (r: PullRow, ctx: CellContext) => React.ReactNode;
}

interface CellContext {
  now: number;
  narrow: boolean;
  medium: boolean;
  reviewerMode: ReviewerMode;
}

const COLUMNS: Column[] = [
  {
    key: "priority",
    width: "w-8",
    head: <span className="sr-only">Attention</span>,
    sortKey: "priority",
    headClass: "pl-4",
    cellClass: "pl-4 text-foreground/70",
    cell: (r) => <PriorityBars value={r.pull.state === "open" ? r.priority : null} />,
  },
  {
    key: "number",
    width: "w-14",
    head: "#",
    sortKey: "number",
    cellClass: "text-xs text-muted-foreground tabular-nums",
    cell: (r) => r.pull.number,
  },
  {
    key: "status",
    width: "w-6",
    head: <span className="sr-only">Status</span>,
    cellClass: "px-1",
    cell: (r) => {
      const status = r.pull.classifying
        ? "classifying"
        : r.unclassified
          ? "unclassified"
          : r.needsReview
            ? "review"
            : r.reviewerSource === "human" || r.effective.review_effort.source === "human"
              ? "human"
              : "model";
      return (
        <StatusIcon
          status={status}
          confidence={r.effective.review_effort.confidence}
          hint={status === "review" ? r.reviewReasons.join("; ") : undefined}
        />
      );
    },
  },
  {
    key: "title",
    width: "",
    head: "Title",
    cellClass: "max-w-0",
    cell: (r, { narrow }) => {
      const p = r.pull;
      return (
        <div className="flex items-center gap-2 overflow-hidden">
          {p.draft && <Tag>draft</Tag>}
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium",
              p.state !== "open" && "text-muted-foreground",
              p.state === "closed" && "line-through",
            )}
            title={p.title}
          >
            {p.title}
          </span>
          {!narrow && p.labels_json.length > 0 && (
            <span className="flex shrink-0 gap-1">
              {p.labels_json.slice(0, 2).map((l) => (
                <Tag key={l}>{l}</Tag>
              ))}
              {p.labels_json.length > 2 && <Tag>+{p.labels_json.length - 2}</Tag>}
            </span>
          )}
        </div>
      );
    },
  },
  {
    key: "effort",
    width: "w-28",
    head: "Effort",
    sortKey: "effort",
    cellClass: "text-xs",
    cell: (r) => <EffortMark value={r.effort} />,
  },
  {
    key: "reviewer",
    width: "w-36",
    head: "Reviewer",
    sortKey: "reviewer",
    cellClass: "max-w-0 text-xs",
    cell: (r, { reviewerMode }) => <ReviewerCell row={r} mode={reviewerMode} />,
  },
  {
    key: "size",
    width: "w-32",
    head: "Size",
    sortKey: "size",
    cellClass: "text-xs whitespace-nowrap tabular-nums",
    cell: (r, { medium }) => (
      <>
        <span className="text-status-good">+{compact(r.pull.additions)}</span>{" "}
        <span className="text-status-critical">−{compact(r.pull.deletions)}</span>
        {!medium && (
          <span className="text-muted-foreground">
            {" "}
            · {r.pull.changed_files} {r.pull.changed_files === 1 ? "file" : "files"}
          </span>
        )}
      </>
    ),
  },
  {
    key: "review",
    width: "w-6",
    head: <span className="sr-only">Review state</span>,
    cellClass: "px-1",
    cell: (r) => (
      <ReviewDecisionMark
        decision={r.pull.review_decision}
        draft={r.pull.draft}
        hasReviews={r.pull.reviews.length > 0}
      />
    ),
  },
  {
    key: "author",
    width: "w-28",
    head: "Author",
    cellClass: "max-w-0 truncate text-xs text-muted-foreground",
    cell: (r) => r.pull.author,
  },
  {
    key: "comments",
    width: "w-12",
    head: <span className="sr-only">Comments</span>,
    cellClass: "text-muted-foreground",
    cell: (r) =>
      r.pull.comments > 0 ? (
        <span className="inline-flex items-center gap-0.5 text-2xs tabular-nums">
          <MessageSquare className="size-3" />
          {r.pull.comments}
        </span>
      ) : null,
  },
  {
    key: "updated",
    width: "w-20",
    head: "Updated",
    sortKey: "updated",
    headClass: "pr-4 text-right",
    cellClass: "pr-4 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums",
    cell: (r, { now }) => agoShort(r.pull.updated_at, now),
  },
];

function pickColumns(width: number): Column[] {
  const narrow = width > 0 && width < NARROW;
  const medium = width > 0 && width < MEDIUM;
  return COLUMNS.filter((c) => {
    if (narrow) return c.key !== "author" && c.key !== "comments" && c.key !== "effort";
    if (medium) return c.key !== "author";
    return true;
  });
}

export function PullTable({
  rows,
  groups,
  groupInfo,
  reviewerMode = "balanced",
  now,
  sort,
  onSort,
  onOpen,
  selectedId,
  loading = false,
  emptyText = "Nothing here.",
}: {
  rows: PullRow[];
  /** When given, rows are rendered in these groups with a header row before each. */
  groups?: PullGroup[];
  /** Roster facts for group headers, by login. */
  groupInfo?: Map<string, GroupInfo>;
  /** What the reviewer column shows: the load-balanced assignment or the raw model pick. */
  reviewerMode?: ReviewerMode;
  users?: Map<string, UserInfo>;
  now: number;
  sort: { key: PullSortKey; dir: "asc" | "desc" };
  onSort: (key: PullSortKey) => void;
  onOpen: (id: string) => void;
  selectedId: string | null;
  loading?: boolean;
  emptyText?: string;
}) {
  const [ref, width] = useWidth<HTMLTableElement>();
  const narrow = width > 0 && width < NARROW;
  const medium = width > 0 && width < MEDIUM;
  const columns = pickColumns(width);
  const ctx: CellContext = { now, narrow, medium, reviewerMode };

  return (
    <table ref={ref} className="w-full table-fixed border-collapse text-sm">
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} className={c.width || undefined} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              className={cn(
                TH,
                c.sortKey && "cursor-pointer select-none hover:text-foreground",
                c.headClass,
              )}
              onClick={c.sortKey ? () => onSort(c.sortKey!) : undefined}
              aria-sort={
                c.sortKey && sort.key === c.sortKey
                  ? sort.dir === "asc"
                    ? "ascending"
                    : "descending"
                  : undefined
              }
            >
              <span className="inline-flex items-center gap-1">
                {c.head}
                {c.sortKey && sort.key === c.sortKey ? (
                  sort.dir === "asc" ? (
                    <ArrowUp className="size-3" />
                  ) : (
                    <ArrowDown className="size-3" />
                  )
                ) : null}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 &&
          loading &&
          Array.from({ length: 10 }, (_, i) => (
            <tr key={i} className="h-9 border-b border-border/60">
              <td colSpan={columns.length} className="px-4">
                <div className="flex items-center gap-3">
                  <div className="size-3.5 animate-pulse rounded-full bg-muted" />
                  <div className="h-3 w-8 animate-pulse rounded bg-muted" />
                  <div
                    className="h-3 animate-pulse rounded bg-muted"
                    style={{ width: `${35 + ((i * 17) % 40)}%` }}
                  />
                </div>
              </td>
            </tr>
          ))}
        {rows.length === 0 && !loading && (
          <tr>
            <td colSpan={columns.length} className="py-20 text-center text-muted-foreground">
              {emptyText}
            </td>
          </tr>
        )}
        {(groups ?? [{ login: undefined, rows }]).flatMap((g) => [
          ...(g.login === undefined
            ? []
            : [
                <tr key={`group:${g.login ?? ""}`} className="h-8">
                  <td
                    colSpan={columns.length}
                    className="sticky top-16 z-5 bg-background px-4 text-xs shadow-[inset_0_-1px_0_var(--border)] before:absolute before:inset-0 before:-z-10 before:bg-muted/40"
                  >
                    <span className="font-medium text-foreground">
                      {g.login ?? "No suggestion"}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {" "}
                      · {g.rows.length} {g.rows.length === 1 ? "pull" : "pulls"}
                      {g.login && groupInfo?.get(g.login)
                        ? ` · ${groupInfo.get(g.login)!.approvals} approvals · ${groupInfo.get(g.login)!.open_load} already open`
                        : g.login === null
                          ? " · no confident match, or not classified yet"
                          : ""}
                    </span>
                  </td>
                </tr>,
              ]),
          ...g.rows.map((r) => (
            <tr
              key={r.pull.id}
              data-pull-id={r.pull.id}
              data-state={selectedId === r.pull.id ? "selected" : undefined}
              onClick={() => onOpen(r.pull.id)}
              className="row-enter h-9 cursor-pointer border-b border-border/60 hover:bg-accent/50 data-[state=selected]:bg-accent"
            >
              {columns.map((c) => (
                <td key={c.key} className={cn("px-2", c.cellClass)}>
                  {c.cell(r, ctx)}
                </td>
              ))}
            </tr>
          )),
        ])}
      </tbody>
    </table>
  );
}

/**
 * Suggested reviewer. Balanced mode: a person's pick, else the load-balanced assignment from the
 * model's distribution. Model mode: the raw pick, with its share of the distribution. A check
 * marks a person's pick; the arrows mark a balanced reassignment; the share lives in the tooltip.
 */
function ReviewerCell({ row, mode }: { row: PullRow; mode: ReviewerMode }) {
  const human = row.reviewerSource === "human";
  if (mode === "model") {
    if (!row.reviewer) {
      if (row.reviewerSource === "model")
        return <span className="text-muted-foreground">no match</span>;
      return <span className="text-muted-foreground">—</span>;
    }
    const p = row.effective.reviewer.probabilities[row.reviewer] ?? null;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex max-w-full items-center gap-1.5">
            {human && <Check className="size-3 shrink-0 text-status-good" strokeWidth={3} />}
            <span className="truncate">{row.reviewer}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {human
            ? `${row.reviewer} · set by a person`
            : `${row.reviewer} · ${pct(p)} of the model's distribution${row.assigned && row.assigned.balanced ? ` · balanced view assigns ${row.assigned.login}` : ""}`}
        </TooltipContent>
      </Tooltip>
    );
  }
  const a = row.assigned;
  if (!a) {
    if (row.reviewer === null && row.reviewerSource === "model")
      return <span className="text-muted-foreground">no match</span>;
    return <span className="text-muted-foreground">—</span>;
  }
  const hint = human
    ? `${a.login} · set by a person`
    : a.balanced
      ? `${a.login} · model preferred ${row.reviewer ?? "someone else"} (${pct(row.effective.reviewer.probabilities[row.reviewer ?? ""] ?? null)}), balanced for load`
      : `${a.login} · ${pct(a.probability)} of the model's distribution`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex max-w-full items-center gap-1.5">
          {human && <Check className="size-3 shrink-0 text-status-good" strokeWidth={3} />}
          <span className="truncate">{a.login}</span>
          {a.balanced && <ArrowLeftRight className="size-3 shrink-0 text-muted-foreground" />}
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
