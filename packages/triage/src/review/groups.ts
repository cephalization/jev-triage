import { z } from "zod";

/** One step of a guided review: what it does, why, and which files carry it. */
export const reviewGroupSchema = z.object({
  name: z.string().min(1).max(120),
  summary: z.string().min(1).max(2000),
  files: z.array(z.string().min(1)).min(1),
});
export type ReviewGroup = z.infer<typeof reviewGroupSchema>;

export const reviewResultSchema = z.object({ groups: z.array(reviewGroupSchema).min(1) });
export type ReviewResult = z.infer<typeof reviewResultSchema>;

/** The first JSON object in a model's reply, fences and prose stripped, validated. */
export function extractReviewResult(output: string): ReviewResult {
  let text = output.trim();
  const fenced = /^```(?:json)?\n([\s\S]*?)\n```$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("response contained no JSON object");
  return reviewResultSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

/**
 * Repair a grouping against the real file list: unknown paths are dropped, a file keeps its
 * first assignment, and anything the model missed is swept into a final step rather than
 * failing the review.
 */
export function normalizeGroups(
  groups: readonly ReviewGroup[],
  changedFiles: readonly string[],
): ReviewGroup[] {
  const known = new Set(changedFiles);
  const assigned = new Set<string>();
  const out: ReviewGroup[] = [];
  for (const g of groups) {
    const files = g.files.filter((f) => known.has(f) && !assigned.has(f));
    for (const f of files) assigned.add(f);
    if (files.length > 0) out.push({ ...g, files });
  }
  const missed = changedFiles.filter((f) => !assigned.has(f));
  if (missed.length > 0)
    out.push({
      name: "Everything else",
      summary: "Changed files the review did not place in a step.",
      files: missed,
    });
  return out;
}
