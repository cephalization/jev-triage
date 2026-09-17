import { cn } from "cn";
import { ArrowDown, ArrowUp, ArrowLeftRight, Check, MessageSquare } from "lucide-react";
import type { PullGroup, PullRow, PullSortKey, ReviewerMode } from "../lib/derive.ts";
import { agoShort, compact, pct } from "../lib/format.ts";
import type { UserInfo } from "./IssueTable.tsx";
import {
  EffortMark,
  GroupHead,
  PriorityBars,
  ReviewDecisionMark,
  StatusIcon,
  Tag,
} from "./Marks.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

/** Same sticky stack as the issue table: view strip, group header, column header, sections. */
const TH =
  "sticky top-[52px] z-10 h-8 bg-background px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]";
const SECTION_TOP = "top-[84px]";

const COLUMNS = 11;

export interface GroupInfo {
  approvals: number;
  open_load: number;
}

export function PullTable({
  rows,
  groups,
  groupInfo,
  reviewerMode = "balanced",
  users: _users,
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
  users: Map<string, UserInfo>;
  now: number;
  sort: { key: PullSortKey; dir: "asc" | "desc" };
  onSort: (key: PullSortKey) => void;
  onOpen: (id: string) => void;
  selectedId: string | null;
  loading?: boolean;
  emptyText?: string;
}) {
  const Head = ({
    k,
    children,
    className,
  }: {
    k?: PullSortKey;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <th
      className={cn(TH, k && "cursor-pointer select-none hover:text-foreground", className)}
      onClick={k ? () => onSort(k) : undefined}
      aria-sort={
        k && sort.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : undefined
      }
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {k && sort.key === k ? (
          sort.dir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : null}
      </span>
    </th>
  );

  return (
    <table className="w-full table-fixed border-collapse text-sm">
      {/* Fixed layout takes widths from <col>, so the spanning group row cannot skew them. */}
      <colgroup>
        <col className="w-8" />
        <col className="w-14" />
        <col className="w-6" />
        <col />
        <col className="w-28 @max-3xl:w-8" />
        <col className="w-36" />
        <col className="w-36 @max-5xl:w-28 @max-3xl:w-24" />
        <col className="w-6" />
        <col className="w-28 @max-4xl:w-0" />
        <col className="w-12 @max-3xl:w-0" />
        <col className="w-20" />
      </colgroup>
      <thead>
        <tr>
          <GroupHead kind="none" colSpan={4} />
          <GroupHead kind="triage" colSpan={2} className="border-l border-border/60" />
          <GroupHead
            kind="github"
            colSpan={5}
            className="border-l border-border/60 @max-4xl:hidden"
          />
          <GroupHead
            kind="github"
            colSpan={4}
            className="hidden border-l border-border/60 @max-4xl:table-cell @max-3xl:hidden"
          />
          <GroupHead
            kind="github"
            colSpan={3}
            className="hidden border-l border-border/60 @max-3xl:table-cell"
          />
        </tr>
        <tr>
          <Head k="priority" className="pl-4">
            <span className="sr-only">Attention</span>
          </Head>
          <Head k="number">#</Head>
          <Head>
            <span className="sr-only">Status</span>
          </Head>
          <Head>Title</Head>
          <Head k="effort" className="border-l border-border/60">
            <span className="@max-3xl:sr-only">Effort</span>
          </Head>
          <Head k="reviewer">Reviewer</Head>
          <Head k="size" className="border-l border-border/60">
            Size
          </Head>
          <Head>
            <span className="sr-only">Review state</span>
          </Head>
          <Head className="@max-4xl:hidden">Author</Head>
          <Head className="@max-3xl:hidden">
            <span className="sr-only">Comments</span>
          </Head>
          <Head k="updated" className="pr-4 text-right">
            Updated
          </Head>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 &&
          loading &&
          Array.from({ length: 10 }, (_, i) => (
            <tr key={i} className="h-9 border-b border-border/60">
              <td colSpan={COLUMNS} className="px-4">
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
            <td colSpan={COLUMNS} className="py-20 text-center text-muted-foreground">
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
                    colSpan={COLUMNS}
                    className={cn(
                      "sticky z-[5] bg-background px-4 text-xs shadow-[inset_0_-1px_0_var(--border)] before:absolute before:inset-0 before:-z-10 before:bg-muted/40",
                      SECTION_TOP,
                    )}
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
          ...g.rows.map((r) => {
            const p = r.pull;
            const selected = selectedId === p.id;
            const status = p.classifying
              ? "classifying"
              : r.unclassified
                ? "unclassified"
                : r.needsReview
                  ? "review"
                  : r.reviewerSource === "human" || r.effective.review_effort.source === "human"
                    ? "human"
                    : "model";
            return (
              <tr
                key={p.id}
                data-pull-id={p.id}
                data-state={selected ? "selected" : undefined}
                onClick={() => onOpen(p.id)}
                className="row-enter h-9 cursor-pointer border-b border-border/60 hover:bg-accent/50 data-[state=selected]:bg-accent"
              >
                <td className="pl-4 text-foreground/70">
                  <PriorityBars value={p.state === "open" ? r.priority : null} />
                </td>
                <td className="px-2 text-xs text-muted-foreground tabular-nums">{p.number}</td>
                <td className="px-1">
                  <StatusIcon
                    status={status}
                    confidence={r.effective.review_effort.confidence}
                    hint={status === "review" ? r.reviewReasons.join("; ") : undefined}
                  />
                </td>
                <td className="max-w-0 px-2">
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
                    {p.labels_json.length > 0 && (
                      <span className="flex shrink-0 gap-1 @max-4xl:hidden">
                        {p.labels_json.slice(0, 2).map((l) => (
                          <Tag key={l}>{l}</Tag>
                        ))}
                        {p.labels_json.length > 2 && <Tag>+{p.labels_json.length - 2}</Tag>}
                      </span>
                    )}
                  </div>
                </td>
                <td className="border-l border-border/60 px-2 text-xs">
                  <EffortMark value={r.effort} labelClassName="@max-3xl:hidden" />
                </td>
                <td className="max-w-0 px-2 text-xs">
                  <ReviewerCell row={r} mode={reviewerMode} />
                </td>
                <td className="border-l border-border/60 px-2 text-xs whitespace-nowrap tabular-nums">
                  <span className="text-status-good">+{compact(p.additions)}</span>{" "}
                  <span className="text-status-critical">−{compact(p.deletions)}</span>
                  <span className="text-muted-foreground @max-5xl:hidden">
                    {" "}
                    · {p.changed_files} {p.changed_files === 1 ? "file" : "files"}
                  </span>
                </td>
                <td className="px-1">
                  <ReviewDecisionMark
                    decision={p.review_decision}
                    draft={p.draft}
                    hasReviews={p.reviews.length > 0}
                  />
                </td>
                <td className="max-w-0 truncate px-2 text-xs text-muted-foreground @max-4xl:hidden">
                  {p.author}
                </td>
                <td className="px-2 text-muted-foreground @max-3xl:hidden">
                  {p.comments > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-2xs tabular-nums">
                      <MessageSquare className="size-3" />
                      {p.comments}
                    </span>
                  )}
                </td>
                <td className="pr-4 pl-2 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {agoShort(p.updated_at, now)}
                </td>
              </tr>
            );
          }),
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
