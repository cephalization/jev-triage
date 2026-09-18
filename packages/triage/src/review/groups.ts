import { z } from "zod";

/** A concrete observation a senior reviewer would raise, anchored to the code. */
export const findingSchema = z.object({
  severity: z.enum(["blocker", "concern", "note"]),
  text: z.string().min(1).max(600),
});
export type Finding = z.infer<typeof findingSchema>;

/** What an inline comment is for, in the words the model chooses between. */
export const ANNOTATION_KINDS = {
  bug: "the code is wrong or can break: a missing case, a broken invariant, an error path, a contract changed without its callers",
  question:
    "something you would ask the author before approving: an intent that is not evident, a choice with no stated reason",
  consideration:
    "a trade-off, edge case, follow-up, performance or security angle the reviewer should weigh",
  nit: "a name, comment or small style point that will mislead or age badly",
} as const;
export type AnnotationKind = keyof typeof ANNOTATION_KINDS;
export const ANNOTATION_KIND_ORDER = Object.keys(ANNOTATION_KINDS) as AnnotationKind[];

/**
 * An inline comment on one line of the step's diff. `side` and `line` follow the numbered
 * diff the model reads: new-side numbers for added and unchanged lines, old-side for removed
 * ones. Line 0 is the file as a whole.
 */
export const annotationSchema = z.object({
  path: z.string().min(1),
  side: z.enum(["old", "new"]).default("new"),
  line: z.number().int().nonnegative().default(0),
  kind: z.enum(ANNOTATION_KIND_ORDER as [AnnotationKind, ...AnnotationKind[]]),
  text: z.string().min(1).max(500),
});
export type Annotation = z.infer<typeof annotationSchema>;

/**
 * One step of a guided review: a paragraph on what it is for, the inline comments a reviewer
 * should start from, and which files carry it. `impact` and `findings` are the shape older
 * reviews were written in; rows are history and keep them.
 */
export const reviewGroupSchema = z.object({
  name: z.string().min(1).max(120),
  summary: z.string().min(1).max(2000),
  files: z.array(z.string().min(1)).min(1),
  annotations: z.array(annotationSchema).max(12).optional(),
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
