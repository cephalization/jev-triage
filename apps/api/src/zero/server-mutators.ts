import { defineMutator, defineMutators } from "@rocicorp/zero";
import { feedbackSetArgs, mutators, repoRecalculateArgs } from "@triage/schema";

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
    repo: {
      recalculate: defineMutator(repoRecalculateArgs, async ({ tx, ctx, args }) => {
        await mutators.repo.recalculate.fn({ tx, ctx, args });
        asyncTasks.push(async () => poke(args.repoId, `recalculate:${args.mode}`));
      }),
    },
  });
}
