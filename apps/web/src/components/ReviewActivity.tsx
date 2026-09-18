import { useQuery, useZero } from "@rocicorp/zero/react";
import { mutators, queries } from "@triage/schema";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ago, compact } from "../lib/format.ts";
import { money } from "./ReviewCost.tsx";
import { Avatar } from "./Avatar.tsx";
import { Tag } from "./Marks.tsx";
import { Button } from "./ui/button.tsx";
import { Input } from "./ui/input.tsx";
import { Label } from "./ui/label.tsx";

/**
 * Who generated what, and what it cost at the provider: the audit and spend list for guided
 * reviews, with the repo's token budget beside it. Provider prices vary, so this counts tokens.
 */
export function ReviewActivity({
  repo,
  now,
}: {
  repo: { id: string; review_budget_tokens: number };
  now: number;
}) {
  const z = useZero();
  const [reviews] = useQuery(queries.guidedReviews.byRepo({ repoId: repo.id, limit: 200 }));
  const [budget, setBudget] = useState(String(repo.review_budget_tokens));
  useEffect(() => setBudget(String(repo.review_budget_tokens)), [repo.review_budget_tokens]);
  const spent = reviews.reduce((a, r) => a + r.input_tokens + r.output_tokens, 0);
  const recent = reviews.slice(0, 20);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="review-budget">Provider token budget (0 = unlimited)</Label>
          <Input
            id="review-budget"
            className="h-8"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            inputMode="numeric"
          />
        </div>
        <Button
          size="sm"
          onClick={() =>
            void z.mutate(
              mutators.repo.setKnobs({
                repoId: repo.id,
                reviewBudgetTokens: Math.max(0, Number(budget) || 0),
              }),
            )
          }
        >
          Save
        </Button>
      </div>
      <p className="text-xs text-muted-foreground tabular-nums">
        {reviews.length} reviews · {compact(spent)} provider tokens spent
        {repo.review_budget_tokens > 0 ? ` of ${compact(repo.review_budget_tokens)}` : ""}
      </p>
      {recent.length > 0 && (
        <ol className="flex flex-col divide-y text-xs">
          {recent.map((r) => (
            <li key={r.id} className="flex items-center gap-2 py-1.5">
              {r.creator ? (
                <Avatar
                  name={r.creator.name}
                  color={r.creator.color}
                  src={r.creator.avatar_url ?? null}
                  size="xs"
                  hint={r.creator.name}
                />
              ) : (
                <span className="size-4" />
              )}
              <Link
                to="/pulls/$pullId/review"
                params={{ pullId: r.pull_id }}
                search={(s) => ({ repo: s.repo })}
                className="min-w-0 flex-1 truncate hover:underline"
              >
                <span className="text-muted-foreground tabular-nums">#{r.pull?.number ?? "?"}</span>{" "}
                {r.pull?.title ?? r.pull_id}
              </Link>
              <Tag>{r.status === "ready" ? r.model : r.status}</Tag>
              <span className="w-20 shrink-0 text-right text-muted-foreground tabular-nums">
                {compact(r.input_tokens)} / {compact(r.output_tokens)}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums">
                {r.status === "ready" ? (r.priced ? money(r.cost_usd) : "—") : ""}
              </span>
              <span className="w-16 shrink-0 text-right text-muted-foreground whitespace-nowrap">
                {ago(r.created_at, now)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
