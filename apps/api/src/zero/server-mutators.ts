import { defineMutator, defineMutators } from "@rocicorp/zero";
import { feedbackSetArgs, mutators, providerRemoveArgs, repoRecalculateArgs } from "@triage/schema";
import { clearProviderKey } from "../providers/store.ts";

/**
 * Server-side overrides of the shared mutators. They run the same logic, then append
 * an async task (executed after the transaction commits) that pokes the classifier.
 * A poke never enqueues a request while one is in flight; it only sets a dirty flag.
 */
export function createServerMutators(
  asyncTasks: Array<() => Promise<void>>,
  poke: (repoId: string, reason: string) => void,
) {
  return defineMutators(mutators, {
    feedback: {
      set: defineMutator(feedbackSetArgs, async ({ tx, ctx, args }) => {
        await mutators.feedback.set.fn({ tx, ctx, args });
        // A confirmation (reclassify=false) changes nothing the model should redo.
        if (args.reclassify)
          asyncTasks.push(async () => poke(args.repoId, `feedback:${args.kind}`));
      }),
    },
    provider: {
      remove: defineMutator(providerRemoveArgs, async ({ tx, ctx, args }) => {
        await mutators.provider.remove.fn({ tx, ctx, args });
        // The sealed key lives outside Zero; drop it once the row deletion has committed.
        asyncTasks.push(() => clearProviderKey(args.id));
      }),
    },
    repo: {
      recalculate: defineMutator(repoRecalculateArgs, async ({ tx, ctx, args }) => {
        await mutators.repo.recalculate.fn({ tx, ctx, args });
        asyncTasks.push(async () => poke(args.repoId, `recalculate:${args.mode}`));
      }),
    },
  });
}
