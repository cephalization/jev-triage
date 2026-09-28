import { THRESHOLDS, WORK_QUEUE_THRESHOLDS } from "@triage/triage/policy";
import type { PullRow, TriageRow } from "./derive.ts";

export interface QueueState {
  subject_kind: string;
  subject_id: string;
  status: string;
  subject_updated_at: number;
  snoozed_until?: number | null;
}

export interface WorkItem {
  key: string;
  kind: "issue" | "pull";
  id: string;
  number: number;
  title: string;
  updatedAt: number;
  action: string;
  reason: string;
  tier: number;
  priority: number;
  status: "ready" | "handled" | "snoozed";
}

const ACTIONS: Record<string, string> = {
  ask_author: "Ask for missing information",
  answer: "Answer the question",
  investigate: "Investigate the issue",
  decide: "Make a maintainer decision",
  accept: "Plan the work",
  close: "Check whether to close",
};

/** Personal relevance first, existing priority within a tier, stable IDs break ties.
 * No model call and no GitHub writes: these are suggestions, never approval or merge authority.
 */
export function buildWorkQueue(
  issues: readonly TriageRow[],
  pulls: readonly PullRow[],
  user: { userID: string; login: string },
  states: readonly QueueState[],
  now: number,
): WorkItem[] {
  const items: WorkItem[] = [];
  const login = user.login.toLowerCase();
  const isMe = (name: string | null | undefined) => !!login && name?.toLowerCase() === login;
  for (const row of issues) {
    const i = row.issue;
    if (i.state !== "open" || row.done || (row.claimedBy && row.claimedBy !== user.userID))
      continue;
    const uncertain =
      !row.action ||
      (row.actionSource !== "human" && row.needsReview) ||
      (row.actionSource === "model" && (row.actionConfidence ?? 0) < THRESHOLDS.actionAuto);
    if (row.action === "wait" && !uncertain) continue;
    const urgent =
      (row.severity ?? 0) >= WORK_QUEUE_THRESHOLDS.severity ||
      (row.urgency ?? 0) >= WORK_QUEUE_THRESHOLDS.urgency;
    const mine = row.claimedBy === user.userID;
    items.push({
      key: `issue:${i.id}`,
      kind: "issue",
      id: i.id,
      number: i.number,
      title: i.title,
      updatedAt: i.updated_at,
      action: uncertain ? "Triage the issue" : (ACTIONS[row.action!] ?? "Triage the issue"),
      reason: [
        urgent
          ? "High impact or urgent"
          : mine
            ? "You claimed this"
            : uncertain
              ? "Needs a human triage decision"
              : "Unclaimed maintainer work",
        row.why,
      ]
        .filter(Boolean)
        .join(" · "),
      tier: urgent ? 0 : mine ? 1 : 3,
      priority: row.priority,
      status: "ready",
    });
  }
  for (const row of pulls) {
    const p = row.pull;
    if (p.state !== "open") continue;
    const own = isMe(p.author);
    const requested = p.requested_reviewers_json.some(isMe);
    const suggested = isMe(row.assigned?.login ?? row.reviewer);
    let action: string;
    let reason: string;
    let tier = 3;
    if (own && (p.draft || p.review_decision === "CHANGES_REQUESTED")) {
      action = p.draft ? "Finish your draft" : "Address review feedback";
      reason = "Your pull request needs work";
      tier = 1;
    } else if (p.draft) {
      continue;
    } else if (p.review_decision === "APPROVED") {
      action = p.mergeable === "CONFLICTING" ? "Resolve merge conflicts" : "Check merge readiness";
      reason = "Approved on GitHub; verify checks and branch requirements before merging";
      tier = 2;
    } else {
      if (own || (p.review_decision === "CHANGES_REQUESTED" && !requested)) continue;
      if (!requested && row.reviewerSource === "human" && row.reviewer && !isMe(row.reviewer))
        continue;
      if (
        !requested &&
        row.latestReviews.some(
          (r) => isMe(r.reviewer) && (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED"),
        )
      )
        continue;
      action = "Review pull request";
      reason = requested
        ? "Your review was requested on GitHub"
        : suggested
          ? "You are the suggested reviewer"
          : "Help a contributor get a review";
      tier = requested ? 1 : suggested ? 2 : 3;
    }
    items.push({
      key: `pull:${p.id}`,
      kind: "pull",
      id: p.id,
      number: p.number,
      title: p.title,
      updatedAt: p.updated_at,
      action,
      reason,
      tier,
      priority: row.priority,
      status: "ready",
    });
  }
  const stateByKey = new Map(states.map((s) => [`${s.subject_kind}:${s.subject_id}`, s]));
  for (const item of items) {
    const state = stateByKey.get(item.key);
    if (state?.status === "snoozed" && (state.snoozed_until ?? 0) > now) item.status = "snoozed";
    else if (state?.status === "handled" && item.updatedAt <= state.subject_updated_at)
      item.status = "handled";
  }
  return items.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.priority - a.priority ||
      a.updatedAt - b.updatedAt ||
      a.key.localeCompare(b.key),
  );
}
