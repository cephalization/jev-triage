import { ChartColumn } from "lucide-react";
import { useMemo, useState } from "react";
import { suggestedReviewer, type PullRow } from "../lib/derive.ts";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx";

export interface BreakdownRoster {
  login: string;
  approvals: number;
  open_load: number;
}

interface Line {
  login: string | null;
  balanced: number;
  model: number;
  human: number;
  approvals: number | null;
  openLoad: number | null;
}

/** Per-person counts over the rows in view: balanced assignments, raw model picks, human picks. */
export function breakdown(rows: readonly PullRow[], roster: readonly BreakdownRoster[]): Line[] {
  const byLogin = new Map<string | null, Line>();
  const info = new Map(roster.map((r) => [r.login, r]));
  const line = (login: string | null): Line => {
    let l = byLogin.get(login);
    if (!l) {
      const r = login ? info.get(login) : undefined;
      l = {
        login,
        balanced: 0,
        model: 0,
        human: 0,
        approvals: r?.approvals ?? null,
        openLoad: r?.open_load ?? null,
      };
      byLogin.set(login, l);
    }
    return l;
  };
  for (const r of rows) {
    line(suggestedReviewer(r, "balanced")).balanced += 1;
    line(suggestedReviewer(r, "model")).model += 1;
    if (r.reviewerSource === "human" && r.reviewer) line(r.reviewer).human += 1;
  }
  return [...byLogin.values()].sort((a, b) => {
    if (a.login === null) return 1;
    if (b.login === null) return -1;
    return b.balanced - a.balanced || b.model - a.model || a.login.localeCompare(b.login);
  });
}

/** Icon button + dialog: who would get what across the pull requests currently in view. */
export function ReviewerBreakdown({
  rows,
  roster,
}: {
  rows: readonly PullRow[];
  roster: readonly BreakdownRoster[];
}) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => (open ? breakdown(rows, roster) : []), [open, rows, roster]);
  const max = Math.max(1, ...lines.map((l) => Math.max(l.balanced, l.model)));
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => setOpen(true)}
            aria-label="Suggested assignee breakdown"
          >
            <ChartColumn />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Suggested assignee breakdown</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Suggested assignees</DialogTitle>
            <DialogDescription>
              Across the {rows.length} pull {rows.length === 1 ? "request" : "requests"} in view.
              Balanced spreads the model&apos;s distributions by load; Model pick is the raw first
              choice. A person&apos;s pick counts in both.
            </DialogDescription>
          </DialogHeader>
          {lines.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing in view.</p>
          ) : (
            <table className="w-full text-left text-xs tabular-nums">
              <thead>
                <tr className="text-muted-foreground [&>th]:pb-1 [&>th]:font-medium [&>th]:whitespace-nowrap">
                  <th>Reviewer</th>
                  <th className="w-24">Balanced</th>
                  <th className="w-24">Model pick</th>
                  <th className="w-14 text-right">By hand</th>
                  <th className="w-14 text-right">Open</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.login ?? ""} className="border-t">
                    <td className="py-1.5 pr-2">
                      <div className="truncate font-medium">{l.login ?? "No suggestion"}</div>
                      {l.approvals !== null && (
                        <div className="text-muted-foreground">{l.approvals} approvals</div>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 align-top">
                      <Bar value={l.balanced} max={max} />
                    </td>
                    <td className="py-1.5 pr-3 align-top">
                      <Bar value={l.model} max={max} muted />
                    </td>
                    <td className="py-1.5 text-right align-top">{l.human || "–"}</td>
                    <td className="py-1.5 text-right align-top text-muted-foreground">
                      {l.openLoad ?? "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Bar({ value, max, muted = false }: { value: number; max: number; muted?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={muted ? "block h-full bg-foreground/30" : "block h-full bg-primary"}
          style={{ width: `${(value / max) * 100}%` }}
        />
      </span>
      <span className="w-6 text-right">{value}</span>
    </span>
  );
}
