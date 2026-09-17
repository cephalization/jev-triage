import { defineMutator, defineMutators } from "@rocicorp/zero";
import { z } from "zod";
import { CLASSIFICATION_KINDS, zql } from "./schema.ts";

/**
 * Client-safe mutators. They run optimistically in the browser and again on the
 * server (see apps/api/src/zero/server-mutators.ts for the overrides that enqueue
 * TypeSafe work). Everything here must be idempotent.
 */

const kindSchema = z.enum(CLASSIFICATION_KINDS);

export const feedbackSetArgs = z.object({
  id: z.string(),
  issueId: z.string(),
  repoId: z.string(),
  kind: kindSchema,
  value: z.string(),
  note: z.string().optional(),
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
});

export const repoRecalculateArgs = z.object({
  repoId: z.string(),
  /** "version" bumps questions_version (everything is redone); "flag" marks the given issues. */
  mode: z.enum(["version", "flag"]),
  issueIds: z.array(z.string()).optional(),
});

export const mutators = defineMutators({
  feedback: {
    set: defineMutator(feedbackSetArgs, async ({ tx, ctx, args }) => {
      if (!ctx) throw new Error("Sign in to leave feedback");
      await tx.mutate.feedback.insert({
        id: args.id,
        issue_id: args.issueId,
        repo_id: args.repoId,
        user_id: ctx.userID,
        kind: args.kind,
        value: args.value,
        note: args.note ?? null,
        created_at: Date.now(),
      });
      await tx.mutate.issue.update({ id: args.issueId, reclassify: true });
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
    }),
  },
});

export type Mutators = typeof mutators;
