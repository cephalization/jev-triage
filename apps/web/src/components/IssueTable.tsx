import { cn } from "cn";
import { ArrowDown, ArrowUp, CircleHelp, Copy, MessageSquare } from "lucide-react";
import type { SortKey, TriageRow } from "../lib/derive.ts";
import { agoShort } from "../lib/format.ts";
import { viewersOf } from "../lib/presence.ts";
import { AvatarStack } from "./Avatar.tsx";
import { CategoryChip, Pill, PriorityBars, SeverityMark, StatusIcon } from "./Marks.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export interface UserInfo {
  id: string;
  name: string;
  color: string;
}

const TH =
  "sticky top-0 z-10 h-8 bg-background px-2 text-left text-xs font-medium whitespace-nowrap text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]";

export function IssueTable({
  rows,
  users,
  now,
  sort,
  onSort,
  onOpen,
  selectedId,
  numberToId,
  loading = false,
  emptyText = "Nothing here.",
}: {
  rows: TriageRow[];
  users: Map<string, UserInfo>;
  now: number;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  onOpen: (id: string) => void;
  selectedId: string | null;
  numberToId: Map<number, string>;
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
  const dupLabel = (v: string) => {
    if (v.startsWith("#")) return v;
    const n = [...numberToId.entries()].find(([, id]) => id === v)?.[0];
    return n ? `#${n}` : "another issue";
  };

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
          <Head k="category" className="w-28">
            Category
          </Head>
          <Head className="w-36 @max-3xl:hidden">Area</Head>
          <Head k="severity" className="w-24 @max-3xl:w-8">
            <span className="@max-3xl:sr-only">Severity</span>
          </Head>
          <Head className="w-20 @max-3xl:w-14">
            <span className="sr-only">Flags</span>
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
              <td colSpan={10} className="px-4">
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
            <td colSpan={10} className="py-20 text-center text-muted-foreground">
              {emptyText}
            </td>
          </tr>
        )}
        {rows.map((r) => {
          const viewers = viewersOf(r.issue.presence, now);
          const feedbackPeople = r.feedbackUsers
            .map((id) => users.get(id))
            .filter((u): u is UserInfo => !!u);
          const selected = selectedId === r.issue.id;
          const status = r.issue.classifying
            ? "classifying"
            : r.unclassified
              ? "unclassified"
              : r.needsReview
                ? "review"
                : r.effective.category.source === "human"
                  ? "human"
                  : "model";
          const labels = r.issue.labels.length
            ? r.issue.labels.map((l) => ({ name: l.name, color: `#${l.color}` }))
            : r.issue.labels_json.map((name) => ({ name, color: undefined }));
          return (
            <tr
              key={r.issue.id}
              data-issue-id={r.issue.id}
              data-state={selected ? "selected" : undefined}
              onClick={() => onOpen(r.issue.id)}
              className="row-enter h-9 cursor-pointer border-b border-border/60 hover:bg-accent/50 data-[state=selected]:bg-accent"
            >
              <td className="pl-4 text-foreground/70">
                <PriorityBars value={r.unclassified ? null : r.priority} />
              </td>
              <td className="px-2 text-xs text-muted-foreground tabular-nums">{r.issue.number}</td>
              <td className="px-1">
                <StatusIcon
                  status={status}
                  confidence={r.categoryConfidence}
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
                    title={r.issue.title}
                  >
                    {r.issue.title}
                  </span>
                  {labels.length > 0 && (
                    <span className="flex shrink-0 gap-1 @max-4xl:hidden">
                      {labels.slice(0, 3).map((l) => (
                        <Pill key={l.name} color={l.color} muted>
                          {l.name}
                        </Pill>
                      ))}
                      {labels.length > 3 && <Pill muted>+{labels.length - 3}</Pill>}
                    </span>
                  )}
                </div>
              </td>
              <td className="px-2">
                <CategoryChip
                  value={r.category}
                  confidence={r.categoryConfidence}
                  source={r.effective.category.source}
                />
              </td>
              <td className="max-w-0 truncate px-2 text-xs text-muted-foreground @max-3xl:hidden">
                {r.area ?? "—"}
              </td>
              <td className="px-2 text-xs">
                <SeverityMark value={r.severity} labelClassName="@max-3xl:hidden" />
              </td>
              <td className="px-2">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  {r.needsInfo && (
                    <Flag hint="Needs more information">
                      <CircleHelp className="size-3.5" />
                    </Flag>
                  )}
                  {r.duplicateOf && (
                    <Flag hint={`Possible duplicate of ${dupLabel(r.duplicateOf)}`}>
                      <Copy className="size-3.5" />
                    </Flag>
                  )}
                  {r.issue.comments > 0 && (
                    <Flag hint={`${r.issue.comments} comments`}>
                      <span className="inline-flex items-center gap-0.5 text-2xs tabular-nums">
                        <MessageSquare className="size-3" />
                        {r.issue.comments}
                      </span>
                    </Flag>
                  )}
                  {r.issue.reclassify && !r.issue.classifying && (
                    <Flag hint="Queued for reclassification">
                      <span className="size-1.5 rounded-full bg-status-warning" />
                    </Flag>
                  )}
                </span>
              </td>
              <td className="px-2">
                <span className="flex items-center gap-1.5">
                  <AvatarStack
                    size="xs"
                    people={feedbackPeople.map((u) => ({
                      key: u.id,
                      name: u.name,
                      color: u.color,
                      hint: `${u.name} gave feedback`,
                    }))}
                  />
                  <AvatarStack
                    size="xs"
                    people={viewers.map((v) => ({
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
        })}
      </tbody>
    </table>
  );
}

function Flag({ hint, children }: { hint: string; children: React.ReactNode }) {
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
