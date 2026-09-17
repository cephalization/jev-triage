import { defineMutator, defineMutators, type Transaction } from "@rocicorp/zero";
import { z } from "zod";
import { CLASSIFICATION_KINDS, PULL_KINDS, TRIAGE_STATUSES, zql } from "./schema.ts";

/**
 * Client-safe mutators. They run optimistically in the browser and again on the
 * server (see apps/api/src/zero/server-mutators.ts for the overrides that enqueue
 * TypeSafe work). Everything here must be idempotent.
 */

const kindSchema = z.enum([...CLASSIFICATION_KINDS, ...PULL_KINDS]);

/** Feedback names exactly one subject: an issue or a pull request. */
export const feedbackSetArgs = z
  .object({
    id: z.string(),
    issueId: z.string().optional(),
    pullId: z.string().optional(),
    repoId: z.string(),
    kind: kindSchema,
    value: z.string(),
    note: z.string().optional(),
    /**
     * Refresh the model's rows afterwards (the default for a correction). A confirmation of
     * what the model already said passes false: nothing new to learn for this issue.
     */
    reclassify: z.boolean().default(true),
  })
  .refine((a) => (a.issueId === undefined) !== (a.pullId === undefined), {
    message: "feedback needs exactly one of issueId or pullId",
  });

export const presenceHeartbeatArgs = z.object({
  /** Per-tab id; two tabs of one user are two rows, so they never overwrite each other. */
  clientId: z.string().min(1).max(64),
  repoId: z.string().nullable(),
  issueId: z.string().nullable(),
});

/** Rows older than this are deleted by whichever heartbeat sees them. */
export const PRESENCE_PRUNE_MS = 10 * 60_000;

export const repoSetKnobsArgs = z.object({
  repoId: z.string(),
  batchSize: z.number().int().min(1).max(50).optional(),
  cadenceMs: z.number().int().min(250).max(60_000).optional(),
  budgetTokens: z.number().int().min(0).optional(),
  paused: z.boolean().optional(),
  syncLimit: z.number().int().min(1).max(5000).optional(),
  pullLimit: z.number().int().min(1).max(2000).optional(),
  pullHistoryLimit: z.number().int().min(0).max(2000).optional(),
});

export const repoRecalculateArgs = z.object({
  repoId: z.string(),
  /** "version" bumps questions_version (everything is redone); "flag" marks the given rows. */
  mode: z.enum(["version", "flag"]),
  issueIds: z.array(z.string()).optional(),
  pullIds: z.array(z.string()).optional(),
});

export const triageClaimArgs = z.object({
  issueId: z.string(),
  repoId: z.string(),
  /** true takes the issue (even from someone else); false releases it. */
  claim: z.boolean(),
});

export const triageSetStatusArgs = z.object({
  issueId: z.string(),
  repoId: z.string(),
  status: z.enum(TRIAGE_STATUSES),
});

/** Confirm the model's suggestions as feedback (no reclassification) and leave the queue. */
export const triageAcceptArgs = z.object({
  issueId: z.string(),
  repoId: z.string(),
  values: z.array(z.object({ id: z.string(), kind: kindSchema, value: z.string() })),
  done: z.boolean().default(true),
});

interface TriagePatch {
  status?: string;
  claimed_by?: string | null;
  claimed_at?: number | null;
  done_by?: string | null;
  done_at?: number | null;
}

/** The triage row is created on first touch; later touches merge into it. */
async function patchTriage(tx: Transaction, issueId: string, repoId: string, patch: TriagePatch) {
  const existing = await tx.run(zql.triage.where("issue_id", issueId).one());
  await tx.mutate.triage.upsert({
    issue_id: issueId,
    repo_id: repoId,
    status: existing?.status ?? "open",
    claimed_by: existing?.claimed_by ?? null,
    claimed_at: existing?.claimed_at ?? null,
    done_by: existing?.done_by ?? null,
    done_at: existing?.done_at ?? null,
    ...patch,
    updated_at: Date.now(),
  });
}

export const mutators = defineMutators({
  feedback: {
    set: defineMutator(feedbackSetArgs, async ({ tx, ctx, args }) => {
      if (!ctx) throw new Error("Sign in to leave feedback");
      await tx.mutate.feedback.insert({
        id: args.id,
        issue_id: args.issueId ?? null,
        pull_id: args.pullId ?? null,
        repo_id: args.repoId,
        user_id: ctx.userID,
        kind: args.kind,
        value: args.value,
        note: args.note ?? null,
        created_at: Date.now(),
      });
      if (!args.reclassify) return;
      if (args.issueId) await tx.mutate.issue.update({ id: args.issueId, reclassify: true });
      if (args.pullId) await tx.mutate.pull.update({ id: args.pullId, reclassify: true });
    }),
  },
  triage: {
    claim: defineMutator(triageClaimArgs, async ({ tx, ctx, args }) => {
      if (!ctx) throw new Error("Sign in to claim an issue");
      await patchTriage(
        tx,
        args.issueId,
        args.repoId,
        args.claim
          ? { claimed_by: ctx.userID, claimed_at: Date.now() }
          : { claimed_by: null, claimed_at: null },
      );
    }),
    setStatus: defineMutator(triageSetStatusArgs, async ({ tx, ctx, args }) => {
      if (!ctx) throw new Error("Sign in to triage");
      await patchTriage(
        tx,
        args.issueId,
        args.repoId,
        args.status === "done"
          ? { status: "done", done_by: ctx.userID, done_at: Date.now() }
          : { status: "open", done_by: null, done_at: null },
      );
    }),
    accept: defineMutator(triageAcceptArgs, async ({ tx, ctx, args }) => {
      if (!ctx) throw new Error("Sign in to triage");
      const now = Date.now();
      for (const v of args.values) {
        await tx.mutate.feedback.upsert({
          id: v.id,
          issue_id: args.issueId,
          pull_id: null,
          repo_id: args.repoId,
          user_id: ctx.userID,
          kind: v.kind,
          value: v.value,
          note: null,
          created_at: now,
        });
      }
      if (args.done)
        await patchTriage(tx, args.issueId, args.repoId, {
          status: "done",
          done_by: ctx.userID,
          done_at: now,
        });
    }),
  },
  presence: {
    heartbeat: defineMutator(presenceHeartbeatArgs, async ({ tx, ctx, args }) => {
      // Throwing (rather than silently skipping) lets the client notice a dead session:
      // otherwise the optimistic row appears, the server writes nothing, and it vanishes.
      if (!ctx) throw new Error("Sign in to share presence");
      const now = Date.now();
      await tx.mutate.presence.upsert({
        client_id: args.clientId,
        user_id: ctx.userID,
        name: ctx.name,
        color: ctx.color,
        repo_id: args.repoId,
        issue_id: args.issueId,
        updated_at: now,
      });
      // Tabs that closed never say goodbye; sweep what has gone quiet.
      const stale = await tx.run(zql.presence.where("updated_at", "<", now - PRESENCE_PRUNE_MS));
      for (const row of stale) await tx.mutate.presence.delete({ client_id: row.client_id });
    }),
  },
  repo: {
    setKnobs: defineMutator(repoSetKnobsArgs, async ({ tx, ctx, args }) => {
      if (!ctx) throw new Error("Sign in to change settings");
      await tx.mutate.repo.update({
        id: args.repoId,
        ...(args.batchSize !== undefined ? { batch_size: args.batchSize } : {}),
        ...(args.cadenceMs !== undefined ? { cadence_ms: args.cadenceMs } : {}),
        ...(args.budgetTokens !== undefined ? { budget_tokens: args.budgetTokens } : {}),
        ...(args.paused !== undefined ? { paused: args.paused } : {}),
        ...(args.syncLimit !== undefined ? { sync_limit: args.syncLimit } : {}),
        ...(args.pullLimit !== undefined ? { pull_limit: args.pullLimit } : {}),
        ...(args.pullHistoryLimit !== undefined
          ? { pull_history_limit: args.pullHistoryLimit }
          : {}),
      });
    }),
    recalculate: defineMutator(repoRecalculateArgs, async ({ tx, ctx, args }) => {
      if (!ctx) throw new Error("Sign in to recalculate");
      if (args.mode === "version") {
        const repo = await tx.run(zql.repo.where("id", args.repoId).one());
        if (!repo) return;
        await tx.mutate.repo.update({
          id: args.repoId,
          questions_version: repo.questions_version + 1,
        });
        return;
      }
      for (const id of args.issueIds ?? []) {
        await tx.mutate.issue.update({ id, reclassify: true });
      }
      for (const id of args.pullIds ?? []) {
        await tx.mutate.pull.update({ id, reclassify: true });
      }
    }),
  },
});

export type Mutators = typeof mutators;
