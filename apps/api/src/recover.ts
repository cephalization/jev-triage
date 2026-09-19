import { sql } from "./db.ts";

/**
 * A process that dies mid-job leaves its state behind: a repository marked syncing (which
 * disables the Sync button), rows flagged as classifying, a worker marked in flight, run rows
 * that never finished, and reviews still "running". Nothing else will ever clear them, so the
 * next boot does, before any work starts. Each becomes a plain failure with a reason, never a
 * silent reset, so the UI says what happened and a person can start it again.
 */
const REASON = "interrupted by a server restart";

export async function recoverOnBoot(): Promise<void> {
  const [syncs, runs, issues, pulls, workers, reviews] = await Promise.all([
    sql`update repo set sync_status = 'error', sync_phase = 'error',
      sync_error = ${`sync ${REASON}; sync again`}, sync_message = ${`sync ${REASON}`}
      where sync_status = 'running'`,
    sql`update run set status = 'error', error = ${REASON}, finished_at = now()
      where status = 'running'`,
    sql`update issue set classifying = false where classifying`,
    sql`update pull set classifying = false where classifying`,
    sql`update worker_state set in_flight = false, dirty = false, updated_at = now() where in_flight`,
    sql`update guided_review set status = 'failed', phase = null, error = ${`generation ${REASON}`}, finished_at = now()
      where status in ('queued', 'running')`,
  ]);
  const counts = [
    [syncs.count, "sync"],
    [runs.count, "run"],
    [issues.count, "issue"],
    [pulls.count, "pull"],
    [workers.count, "worker"],
    [reviews.count, "review"],
  ] as const;
  const found = counts
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}${n === 1 ? "" : "s"}`);
  if (found.length > 0) console.log(`[recover] left by a previous process: ${found.join(", ")}`);
}
