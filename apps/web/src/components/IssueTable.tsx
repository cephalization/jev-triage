import { cn } from "cn";
import { ArrowDown, ArrowUp, Copy, MessageSquare } from "lucide-react";
import type { IssueGroup, SortKey, TriageRow } from "../lib/derive.ts";
import { ACTION_META, agoShort } from "../lib/format.ts";
import { viewersOf } from "../lib/presence.ts";
import { MEDIUM, NARROW, useWidth } from "../lib/useWidth.ts";
import { Avatar, AvatarStack } from "./Avatar.tsx";
import { ActionPill, CategoryChip, PriorityBars, SeverityMark, StatusIcon, Tag } from "./Marks.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export interface UserInfo {
  id: string;
  name: string;
  color: string;
}

/** Column header sits under the 32px view strip; section rows stack under both. */
const TH =
  "sticky top-8 z-10 h-8 bg-background px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]";

/**
 * One column definition drives the <col>, the <th> and every <td>, so widths and cells can
 * never drift apart. Order: identity, then this app's judgments (pills with dots), then facts
 * from GitHub (plain muted text). The mark shapes carry that distinction, not chrome.
 */
interface Column {
  key: string;
  width: string;
  head: React.ReactNode;
  sortKey?: SortKey;
  headClass?: string;
  cellClass?: string;
  cell: (r: TriageRow, ctx: CellContext) => React.ReactNode;
}

interface CellContext {
  users: Map<string, UserInfo>;
  now: number;
  narrow: boolean;
}

const COLUMNS: Column[] = [
  {
    key: "priority",
    width: "w-8",
    head: <span className="sr-only">Priority</span>,
    sortKey: "priority",
    headClass: "pl-4",
    cellClass: "pl-4 text-foreground/70",
    cell: (r) => <PriorityBars value={r.unclassified ? null : r.priority} />,
  },
  {
    key: "number",
    width: "w-14",
    head: "#",
    sortKey: "number",
    cellClass: "text-xs text-muted-foreground tabular-nums",
    cell: (r) => r.issue.number,
  },
  {
    key: "status",
    width: "w-6",
    head: <span className="sr-only">Status</span>,
    cellClass: "px-1",
    cell: (r) => {
      const status = r.issue.classifying
        ? "classifying"
        : r.unclassified
          ? "unclassified"
          : r.needsReview
            ? "review"
            : r.actionSource === "human" || r.effective.category.source === "human"
              ? "human"
              : "model";
      return (
        <StatusIcon
          status={status}
          confidence={r.actionConfidence ?? r.categoryConfidence}
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
      const labels = r.issue.labels.length
        ? r.issue.labels.map((l) => l.name)
        : [...r.issue.labels_json];
      return (
        <div className="flex items-center gap-2 overflow-hidden">
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-medium",
              r.issue.state === "closed" && "text-muted-foreground line-through",
            )}
            title={r.why ? `${r.issue.title}\n${r.why}` : r.issue.title}
          >
            {r.issue.title}
          </span>
          {!narrow && labels.length > 0 && (
            <span className="flex shrink-0 gap-1">
              {labels.slice(0, 2).map((l) => (
                <Tag key={l}>{l}</Tag>
              ))}
              {labels.length > 2 && <Tag>+{labels.length - 2}</Tag>}
            </span>
          )}
        </div>
      );
    },
  },
  {
    key: "action",
    width: "w-28",
    head: "Next step",
    cell: (r) => <ActionPill value={r.action} source={r.actionSource} hint={r.why} />,
  },
  {
    key: "category",
    width: "w-24",
    head: "Category",
    sortKey: "category",
    cell: (r) => <CategoryChip value={r.category} source={r.effective.category.source} />,
  },
  {
    key: "severity",
    width: "w-24",
    head: "Severity",
    sortKey: "severity",
    cellClass: "text-xs",
    cell: (r) => <SeverityMark value={r.severity} />,
  },
  {
    key: "duplicate",
    width: "w-8",
    head: <span className="sr-only">Duplicate</span>,
    cellClass: "text-muted-foreground",
    cell: (r) =>
      r.duplicateOf ? (
        <Mark hint="Possible duplicate; candidates are in the panel">
          <Copy className="size-3.5" />
        </Mark>
      ) : null,
  },
  {
    key: "people",
    width: "w-16",
    head: <span className="sr-only">People</span>,
    cell: (r, { users, now, narrow }) => {
      const owner = r.claimedBy ? users.get(r.claimedBy) : undefined;
      const viewers = narrow ? [] : viewersOf(r.issue.presence, now);
      return (
        <span className="flex items-center gap-1.5">
          {owner && (
            <Avatar
              size="xs"
              name={owner.name}
              color={owner.color}
              className="ring-primary"
              hint={`${owner.name} is on it`}
            />
          )}
          <AvatarStack
            size="xs"
            people={viewers
              .filter((v) => v.user_id !== r.claimedBy)
              .map((v) => ({
                key: v.user_id,
                name: v.name,
                color: v.color,
                hint: `${v.name} is viewing`,
              }))}
          />
        </span>
      );
    },
  },
  {
    key: "comments",
    width: "w-12",
    head: <span className="sr-only">Comments</span>,
    cellClass: "text-muted-foreground",
    cell: (r) =>
      r.issue.comments > 0 ? (
        <Mark hint={`${r.issue.comments} comments on GitHub`}>
          <span className="inline-flex items-center gap-0.5 text-2xs tabular-nums">
            <MessageSquare className="size-3" />
            {r.issue.comments}
          </span>
        </Mark>
      ) : null,
  },
  {
    key: "updated",
    width: "w-20",
    head: "Updated",
    sortKey: "updated",
    headClass: "pr-4 text-right",
    cellClass: "pr-4 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums",
    cell: (r, { now }) => agoShort(r.issue.updated_at, now),
  },
];

/** Which columns fit: the next step leaves when the list is grouped by it; facts go first as room shrinks. */
function pickColumns(width: number, grouped: boolean): Column[] {
  const narrow = width > 0 && width < NARROW;
  const medium = width > 0 && width < MEDIUM;
  return COLUMNS.filter((c) => {
    if (c.key === "action") return !grouped;
    if (narrow) return c.key !== "duplicate" && c.key !== "comments";
    if (medium) return c.key !== "comments";
    return true;
  });
}

export function IssueTable({
  rows,
  groups,
  users,
  now,
  sort,
  onSort,
  onOpen,
  selectedId,
  loading = false,
  emptyText = "Nothing here.",
}: {
  rows: TriageRow[];
  /** When given, rows are rendered in these sections with a header before each. */
  groups?: IssueGroup[];
  users: Map<string, UserInfo>;
  now: number;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  onOpen: (id: string) => void;
  selectedId: string | null;
  loading?: boolean;
  emptyText?: string;
}) {
  const [ref, width] = useWidth<HTMLTableElement>();
  const narrow = width > 0 && width < NARROW;
  const columns = pickColumns(width, !!groups);
  const ctx: CellContext = { users, now, narrow };

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
        {(groups ?? [{ action: undefined, rows }]).flatMap((g) => [
          ...(g.action === undefined
            ? []
            : [
                <tr key={`group:${g.action ?? ""}`} className="h-8">
                  <td
                    colSpan={columns.length}
                    className="sticky top-16 z-5 bg-background px-4 text-xs shadow-[inset_0_-1px_0_var(--border)] before:absolute before:inset-0 before:-z-10 before:bg-muted/40"
                  >
                    <span className="inline-flex items-center gap-2 font-medium text-foreground">
                      {g.action && (
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: ACTION_META[g.action]?.color }}
                        />
                      )}
                      {g.action ? ACTION_META[g.action]?.label : "Not classified yet"}
                    </span>
                    <span className="text-muted-foreground tabular-nums"> · {g.rows.length}</span>
                    {!narrow && (
                      <span className="text-muted-foreground">
                        {" "}
                        ·{" "}
                        {g.action
                          ? ACTION_META[g.action]?.description
                          : "The model has not answered yet, or the answer was not a known step."}
                      </span>
                    )}
                  </td>
                </tr>,
              ]),
          ...g.rows.map((r) => (
            <tr
              key={r.issue.id}
              data-issue-id={r.issue.id}
              data-state={selectedId === r.issue.id ? "selected" : undefined}
              data-done={r.done || undefined}
              onClick={() => onOpen(r.issue.id)}
              className="row-enter h-9 cursor-pointer border-b border-border/60 hover:bg-accent/50 data-[state=selected]:bg-accent data-done:opacity-60"
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

function Mark({ hint, children }: { hint: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center" aria-label={hint}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}
