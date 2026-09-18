import { z } from "zod";

/** A concrete observation a senior reviewer would raise, anchored to the code. */
export const findingSchema = z.object({
  severity: z.enum(["blocker", "concern", "note"]),
  text: z.string().min(1).max(600),
});
export type Finding = z.infer<typeof findingSchema>;

/**
 * One step of a guided review: what it does and how, what else it touches, what a reviewer
 * should raise, and which files carry it.
 */
export const reviewGroupSchema = z.object({
  name: z.string().min(1).max(120),
  summary: z.string().min(1).max(2000),
  files: z.array(z.string().min(1)).min(1),
  impact: z.string().max(1500).optional(),
  findings: z.array(findingSchema).max(8).optional(),
});
export type ReviewGroup = z.infer<typeof reviewGroupSchema>;

/**
 * Every changed file in exactly one step, or the review is wrong. Assignment builds groups
 * this way by construction; this is the check that a bug upstream fails loudly instead of
 * being papered over.
 */
export function assertCoversAll(groups: readonly ReviewGroup[], changedFiles: readonly string[]) {
  const seen = new Map<string, string>();
  for (const g of groups)
    for (const f of g.files) {
      const other = seen.get(f);
      if (other !== undefined && other !== g.name)
        throw new Error(`file ${f} is in two steps: "${other}" and "${g.name}"`);
      seen.set(f, g.name);
    }
  const missing = changedFiles.filter((f) => !seen.has(f));
  if (missing.length > 0) throw new Error(`files not placed in any step: ${missing.join(", ")}`);
  const unknown = [...seen.keys()].filter((f) => !changedFiles.includes(f));
  if (unknown.length > 0)
    throw new Error(`steps name files not in the diff: ${unknown.join(", ")}`);
}
