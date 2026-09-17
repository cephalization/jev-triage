import { cn } from "cn";
import { ArrowDown, ArrowUp, Copy, HelpCircle } from "lucide-react";
import type { SortKey, TriageRow } from "../lib/derive.ts";
import { ago } from "../lib/format.ts";
import { PRESENCE_TTL_MS } from "../lib/presence.ts";
import { AvatarStack } from "./Avatar.tsx";
import { CategoryChip, Meter } from "./Marks.tsx";
import { Badge } from "./ui/badge.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export interface UserInfo {
  id: string;
  name: string;
  color: string;
}

export function IssueTable({
  rows,
  users,
  now,
  sort,
  onSort,
  onOpen,
  selectedId,
  numberToId,
}: {
  rows: TriageRow[];
  users: Map<string, UserInfo>;
  now: number;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  onOpen: (id: string) => void;
  selectedId: string | null;
  numberToId: Map<number, string>;
}) {
  const Head = ({
    k,
    children,
    className,
  }: {
    k: SortKey;
    children: React.ReactNode;
    className?: string;
  }) => (
    <TableHead
      className={cn("cursor-pointer select-none whitespace-nowrap", className)}
      onClick={() => onSort(k)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sort.key === k ? (
          sort.dir === "asc" ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : null}
      </span>
    </TableHead>
  );
  const dupLabel = (v: string) => {
    if (v.startsWith("#")) return v;
    const n = [...numberToId.entries()].find(([, id]) => id === v)?.[0];
    return n ? `#${n}` : "another issue";
  };
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <Head k="number" className="w-16">
            #
          </Head>
          <TableHead>Title</TableHead>
          <Head k="category">Category</Head>
          <TableHead>Area</TableHead>
          <Head k="severity">Severity</Head>
          <Head k="priority">Priority</Head>
          <TableHead>Flags</TableHead>
          <TableHead>People</TableHead>
          <Head k="updated" className="text-right">
            Updated
          </Head>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
              Nothing here.
            </TableCell>
          </TableRow>
        )}
        {rows.map((r) => {
          const viewers = r.issue.presence.filter((p) => p.updated_at > now - PRESENCE_TTL_MS);
          const feedbackPeople = r.feedbackUsers
            .map((id) => users.get(id))
            .filter((u): u is UserInfo => !!u);
          return (
            <TableRow
              key={r.issue.id}
              className={cn("cursor-pointer", selectedId === r.issue.id && "bg-accent")}
              onClick={() => onOpen(r.issue.id)}
              data-state={selectedId === r.issue.id ? "selected" : undefined}
            >
              <TableCell className="tabular-nums text-muted-foreground">{r.issue.number}</TableCell>
              <TableCell className="max-w-[28rem]">
                <div className="truncate font-medium" title={r.issue.title}>
                  {r.issue.title}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {r.issue.state === "closed" && <Badge variant="outline">closed</Badge>}
                  {r.issue.labels_json.slice(0, 4).map((l) => (
                    <Badge key={l} variant="secondary" className="font-normal">
                      {l}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <CategoryChip
                  value={r.category}
                  confidence={r.categoryConfidence}
                  source={r.effective.category.source}
                />
              </TableCell>
              <TableCell className="text-xs">
                {r.area ?? <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell>
                <Meter value={r.severity} label="severity" />
              </TableCell>
              <TableCell>
                <Meter
                  value={r.unclassified ? null : r.priority}
                  label="priority"
                  color="#2a78d6"
                />
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {r.needsInfo && (
                    <Badge variant="outline" className="gap-1">
                      <HelpCircle className="size-3" /> needs info
                    </Badge>
                  )}
                  {r.duplicateOf && (
                    <Badge variant="outline" className="gap-1">
                      <Copy className="size-3" /> dup of {dupLabel(r.duplicateOf)}
                    </Badge>
                  )}
                  {r.needsReview && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="destructive">review</Badge>
                      </TooltipTrigger>
                      <TooltipContent>{r.reviewReasons.join("; ")}</TooltipContent>
                    </Tooltip>
                  )}
                  {r.issue.reclassify && <Badge variant="secondary">reclassifying…</Badge>}
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <AvatarStack
                    people={feedbackPeople.map((u) => ({
                      key: u.id,
                      name: u.name,
                      color: u.color,
                      hint: `${u.name} gave feedback`,
                    }))}
                  />
                  <AvatarStack
                    people={viewers.map((v) => ({
                      key: v.user_id,
                      name: v.name,
                      color: v.color,
                      hint: `${v.name} is viewing`,
                    }))}
                  />
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground">
                {ago(r.issue.updated_at, now)}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
