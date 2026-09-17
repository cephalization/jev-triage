import { cn } from "cn";
import { ArrowDown, ArrowUp, Copy, MessageSquare } from "lucide-react";
import type { IssueGroup, SortKey, TriageRow } from "../lib/derive.ts";
import { ACTION_META, agoShort } from "../lib/format.ts";
import { viewersOf } from "../lib/presence.ts";
import { Avatar, AvatarStack } from "./Avatar.tsx";
import {
  ActionPill,
  CategoryChip,
  Pill,
  PriorityBars,
  SeverityMark,
  StatusIcon,
} from "./Marks.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export interface UserInfo {
  id: string;
  name: string;
  color: string;
}

/** Column header sits under the 32px view strip; group rows stack under both. */
const TH =
  "sticky top-8 z-10 h-8 bg-background px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]";

const COLUMNS = 10;

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
  const Head = ({
    k,
    children,
    className,
  }: {
    k?: SortKey;
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
      <thead>
        <tr>
          <Head k="priority" className="w-8 pl-4">
            <span className="sr-only">Priority</span>
          </Head>
          <Head k="number" className="w-14">
            #
          </Head>
          <Head className="w-6">
            <span className="sr-only">Status</span>
          </Head>
          <Head>Title</Head>
          <Head className={cn("w-28", groups && "hidden")}>Next step</Head>
          <Head k="category" className="w-24">
            Category
          </Head>
          <Head k="severity" className="w-24 @max-3xl:w-8">
            <span className="@max-3xl:sr-only">Severity</span>
          </Head>
          <Head className="w-14">
            <span className="sr-only">Marks</span>
          </Head>
          <Head className="w-16 @max-3xl:w-12">
            <span className="sr-only">People</span>
          </Head>
          <Head k="updated" className="w-20 pr-4 text-right">
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
        {(groups ?? [{ action: undefined, rows }]).flatMap((g) => [
          ...(g.action === undefined
            ? []
            : [
                <tr key={`group:${g.action ?? ""}`} className="h-8">
                  <td
                    colSpan={COLUMNS}
                    className="sticky top-16 z-[5] bg-background px-4 text-xs shadow-[inset_0_-1px_0_var(--border)] before:absolute before:inset-0 before:-z-10 before:bg-muted/40"
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
                    <span className="text-muted-foreground @max-3xl:hidden">
                      {" "}
                      ·{" "}
                      {g.action
                        ? ACTION_META[g.action]?.description
                        : "The model has not answered yet, or the answer was not a known step."}
                    </span>
                  </td>
                </tr>,
              ]),
          ...g.rows.map((r) => (
            <Row
              key={r.issue.id}
              row={r}
              users={users}
              now={now}
              selected={selectedId === r.issue.id}
              grouped={!!groups}
              onOpen={onOpen}
            />
          )),
        ])}
      </tbody>
    </table>
  );
}

function Row({
  row: r,
  users,
  now,
  selected,
  grouped,
  onOpen,
}: {
  row: TriageRow;
  users: Map<string, UserInfo>;
  now: number;
  selected: boolean;
  grouped: boolean;
  onOpen: (id: string) => void;
}) {
  const viewers = viewersOf(r.issue.presence, now);
  const owner = r.claimedBy ? users.get(r.claimedBy) : undefined;
  const status = r.issue.classifying
    ? "classifying"
    : r.unclassified
      ? "unclassified"
      : r.needsReview
        ? "review"
        : r.actionSource === "human" || r.effective.category.source === "human"
          ? "human"
          : "model";
  const labels = r.issue.labels.length
    ? r.issue.labels.map((l) => ({ name: l.name, color: `#${l.color}` }))
    : r.issue.labels_json.map((name) => ({ name, color: undefined }));
  return (
    <tr
      data-issue-id={r.issue.id}
      data-state={selected ? "selected" : undefined}
      data-done={r.done || undefined}
      onClick={() => onOpen(r.issue.id)}
      className="row-enter h-9 cursor-pointer border-b border-border/60 hover:bg-accent/50 data-[state=selected]:bg-accent data-done:opacity-60"
    >
      <td className="pl-4 text-foreground/70">
        <PriorityBars value={r.unclassified ? null : r.priority} />
      </td>
      <td className="px-2 text-xs text-muted-foreground tabular-nums">{r.issue.number}</td>
      <td className="px-1">
        <StatusIcon
          status={status}
          confidence={r.actionConfidence ?? r.categoryConfidence}
          hint={status === "review" ? r.reviewReasons.join("; ") : undefined}
        />
      </td>
      <td className="max-w-0 px-2">
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
          {labels.length > 0 && (
            <span className="flex shrink-0 gap-1 @max-4xl:hidden">
              {labels.slice(0, 2).map((l) => (
                <Pill key={l.name} color={l.color} muted>
                  {l.name}
                </Pill>
              ))}
              {labels.length > 2 && <Pill muted>+{labels.length - 2}</Pill>}
            </span>
          )}
        </div>
      </td>
      <td className={cn("px-2", grouped && "hidden")}>
        <ActionPill value={r.action} source={r.actionSource} hint={r.why} />
      </td>
      <td className="px-2">
        <CategoryChip value={r.category} source={r.effective.category.source} />
      </td>
      <td className="px-2 text-xs">
        <SeverityMark value={r.severity} labelClassName="@max-3xl:hidden" />
      </td>
      <td className="px-2">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          {r.duplicateOf && (
            <Mark hint="Possible duplicate; candidates are in the panel">
              <Copy className="size-3.5" />
            </Mark>
          )}
          {r.issue.comments > 0 && (
            <Mark hint={`${r.issue.comments} comments on GitHub`}>
              <span className="inline-flex items-center gap-0.5 text-2xs tabular-nums">
                <MessageSquare className="size-3" />
                {r.issue.comments}
              </span>
            </Mark>
          )}
        </span>
      </td>
      <td className="px-2">
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
      </td>
      <td className="pr-4 pl-2 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {agoShort(r.issue.updated_at, now)}
      </td>
    </tr>
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
