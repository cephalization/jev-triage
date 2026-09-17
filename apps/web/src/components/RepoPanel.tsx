import { CATEGORIES } from "@triage/schema";
import { cn } from "cn";
import { suggestedLoad, type PullRow, type TriageRow } from "../lib/derive.ts";
import {
  ACTION_META,
  ACTION_ORDER,
  agoShort,
  EFFORT_NAMES,
  SEVERITY_NAMES,
} from "../lib/format.ts";
import { HBars } from "./Charts.tsx";

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1 border-t pt-3">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Block({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-3 border-t pt-4", className)}>
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="text-xs text-muted-foreground text-pretty">{description}</p>
      </div>
      {children}
    </section>
  );
}

export interface ReviewerRosterRow {
  login: string;
  reviews: number;
  approvals: number;
  changes_requested: number;
  last_review_at?: number | null;
  median_response_hours?: number | null;
  open_load: number;
  dirs_json: readonly { dir: string; count: number }[];
}

/** Maintainer-facing health of the repo: what is waiting, for whom, and how much. */
export function RepoPanel({
  rows,
  pullRows,
  reviewers,
  users,
}: {
  rows: TriageRow[];
  pullRows: PullRow[];
  reviewers: readonly ReviewerRosterRow[];
  users: Map<string, { name: string }>;
}) {
  const open = rows.filter((r) => r.issue.state === "open");
  const queue = open.filter((r) => !r.done);
  const claimed = queue.filter((r) => r.claimedBy);
  const unsure = queue.filter((r) => r.needsReview);
  const week = Date.now() - 7 * 86_400_000;
  const doneThisWeek = rows.filter((r) => r.done && (r.issue.triage?.done_at ?? 0) >= week);
  const byAction = ACTION_ORDER.map((a) => ({
    label: ACTION_META[a]!.short,
    value: queue.filter((r) => r.action === a).length,
    hint: `${ACTION_META[a]!.label}: ${queue.filter((r) => r.action === a).length}`,
  }));
  const byOwner = [
    ...claimed.reduce(
      (m, r) => m.set(r.claimedBy!, (m.get(r.claimedBy!) ?? 0) + 1),
      new Map<string, number>(),
    ),
  ]
    .map(([id, n]) => ({ label: users.get(id)?.name ?? id, value: n }))
    .sort((a, b) => b.value - a.value);
  const byCategory = CATEGORIES.map((c) => ({
    label: c,
    value: open.filter((r) => r.category === c).length,
  }));
  const classified = open.filter((r) => !r.unclassified);
  const sevBuckets = SEVERITY_NAMES.map((label, i) => ({
    label,
    value: classified.filter((r) => r.severity !== null && Math.round(r.severity * 3) === i).length,
  }));

  const openPulls = pullRows.filter((r) => r.pull.state === "open");
  const awaiting = openPulls.filter(
    (r) => !r.pull.draft && r.pull.reviews.length === 0 && r.pull.review_decision !== "APPROVED",
  );
  const approved = openPulls.filter((r) => r.pull.review_decision === "APPROVED");
  const effortBuckets = EFFORT_NAMES.map((label, i) => ({
    label,
    value: openPulls.filter((r) => r.effortLevel === i).length,
  }));
  const suggested = suggestedLoad(openPulls);
  const now = Date.now();

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Open issues" value={String(open.length)} sub="synced so far" />
        <Tile label="To triage" value={String(queue.length)} sub="nobody has marked done" />
        <Tile label="Being handled" value={String(claimed.length)} sub="claimed by someone" />
        <Tile label="Unsure" value={String(unsure.length)} sub="the model needs a look" />
        <Tile label="Triaged this week" value={String(doneThisWeek.length)} />
        <Tile
          label="Needs a reply"
          value={String(
            queue.filter((r) => r.action === "ask_author" || r.action === "answer").length,
          )}
          sub="ask or answer"
        />
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Open pull requests" value={String(openPulls.length)} />
        <Tile label="Awaiting first review" value={String(awaiting.length)} sub="not drafts" />
        <Tile label="Approved, unmerged" value={String(approved.length)} sub="ready to finish" />
        <Tile
          label="Quick reviews"
          value={String(
            openPulls.filter((r) => r.effortLevel !== null && r.effortLevel <= 1).length,
          )}
          sub="trivial or small"
        />
        <Tile label="Reviewers known" value={String(reviewers.length)} sub="from merged history" />
        <Tile
          label="Needs a reviewer"
          value={String(openPulls.filter((r) => !r.pull.draft && !r.assigned).length)}
          sub="no confident match"
        />
      </div>
      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
        <Block
          title="Next steps"
          description="What the open queue needs from maintainers. A person's choice wins over the model's."
        >
          <HBars data={byAction} color="#5e6ad2" />
        </Block>
        <Block title="Who has what" description="Issues claimed in the queue, by person.">
          {byOwner.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing claimed yet.</p>
          ) : (
            <HBars data={byOwner} color="#1baf7a" />
          )}
        </Block>
        <Block
          title="Category mix"
          description="Open issues by kind. Human feedback wins over the model."
        >
          <HBars data={byCategory} />
        </Block>
        <Block
          title="Severity"
          description="Expected score across the four rubric levels, rounded to a level."
        >
          <HBars data={sevBuckets} color="#e5484d" />
        </Block>
        <Block
          title="Review effort"
          description="Expected reviewer time across the four rubric levels for open pull requests."
        >
          <HBars data={effortBuckets} color="#eb6834" />
        </Block>
        <Block
          title="Reviewers"
          description="Who reviews what, from the reviewed pull requests synced for this repo. Suggested counts the load-balanced assignments across open pull requests."
          className="lg:col-span-2"
        >
          {reviewers.length === 0 && (
            <p className="text-xs text-muted-foreground">No reviewer history synced yet.</p>
          )}
          {reviewers.length > 0 && (
            <table className="w-full max-w-3xl text-left text-xs tabular-nums">
              <thead>
                <tr className="text-muted-foreground [&>th]:pr-3 [&>th]:pb-1 [&>th]:font-medium [&>th]:whitespace-nowrap">
                  <th>Reviewer</th>
                  <th>Reviews</th>
                  <th>Approved</th>
                  <th title="Median time from a pull opening to their first review">Response</th>
                  <th>Open</th>
                  <th>Suggested</th>
                  <th className="pr-0!">Last</th>
                </tr>
              </thead>
              <tbody>
                {reviewers.slice(0, 15).map((r) => (
                  <tr key={r.login} className="border-t">
                    <td className="py-1 pr-2">
                      <div className="truncate font-medium text-foreground">{r.login}</div>
                      <div className="truncate text-muted-foreground">
                        {r.dirs_json
                          .slice(0, 3)
                          .map((d) => d.dir)
                          .join(", ")}
                      </div>
                    </td>
                    <td className="py-1 pr-2 align-top">{r.reviews}</td>
                    <td className="py-1 pr-2 align-top">{r.approvals}</td>
                    <td className="py-1 pr-2 align-top">
                      {r.median_response_hours == null
                        ? "–"
                        : r.median_response_hours < 48
                          ? `${Math.round(r.median_response_hours)}h`
                          : `${Math.round(r.median_response_hours / 24)}d`}
                    </td>
                    <td className="py-1 pr-2 align-top">{r.open_load}</td>
                    <td className="py-1 pr-2 align-top">{suggested.get(r.login) ?? 0}</td>
                    <td className="py-1 align-top whitespace-nowrap text-muted-foreground">
                      {r.last_review_at ? agoShort(r.last_review_at, now) : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Block>
      </div>
    </div>
  );
}
