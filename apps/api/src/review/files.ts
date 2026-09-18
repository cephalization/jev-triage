import type { SystemOne } from "@triage/triage";
import {
  buildFileQuestions,
  buildFileState,
  decideFile,
  FILES_PER_REQUEST,
  foldFileAnswers,
  REVIEW_FILE_QUESTIONS_VERSION,
  type ClassifiedFile,
  type PatchFile,
  type ReviewIntent,
} from "@triage/triage/review";
import { sql } from "../db.ts";
import { askSystemOne, type JevTrace } from "./jev.ts";

/**
 * The jev pass over a review's diff: every changed file gets its role, risk, attention and
 * entry-point answers. Batches of FILES_PER_REQUEST run side by side; a hundred files take
 * one round trip, not seven.
 */
export async function classifyFiles(
  systemOne: SystemOne,
  repoId: string,
  intent: ReviewIntent,
  files: readonly PatchFile[],
  trace?: JevTrace,
): Promise<ClassifiedFile[]> {
  const batches: PatchFile[][] = [];
  for (let start = 0; start < files.length; start += FILES_PER_REQUEST)
    batches.push(files.slice(start, start + FILES_PER_REQUEST));
  const results = await Promise.all(
    batches.map(async (batch) => {
      const result = await askSystemOne(
        systemOne,
        {
          repoId,
          kind: "review_files",
          state: buildFileState(intent, batch),
          questions: buildFileQuestions(batch.length),
          items: batch.length,
        },
        trace,
      );
      const folded = foldFileAnswers(
        result.answers as Parameters<typeof foldFileAnswers>[0],
        batch.length,
      );
      return batch.map((f, i): ClassifiedFile => ({
        path: f.path,
        status: f.status,
        added: f.added,
        removed: f.removed,
        signal: decideFile(folded[i] ?? {}),
      }));
    }),
  );
  return results.flat();
}

/** Persist the answers against the review, replacing any earlier rows for the same paths. */
export async function storeFileRows(reviewId: string, files: readonly ClassifiedFile[]) {
  if (files.length === 0) return;
  const rows = files.map((f) => ({
    review_id: reviewId,
    path: f.path,
    status: f.status,
    added: f.added,
    removed: f.removed,
    role: f.signal.role,
    role_confidence: f.signal.roleConfidence,
    risk: f.signal.risk,
    attention: f.signal.attention,
    entry: f.signal.entry,
    probabilities_json: sql.json(f.signal.probabilities),
    questions_version: REVIEW_FILE_QUESTIONS_VERSION,
  }));
  await sql`insert into guided_review_file ${sql(rows)}
    on conflict (review_id, path) do update set
      status = excluded.status, added = excluded.added, removed = excluded.removed,
      role = excluded.role, role_confidence = excluded.role_confidence, risk = excluded.risk,
      attention = excluded.attention, entry = excluded.entry,
      probabilities_json = excluded.probabilities_json, questions_version = excluded.questions_version`;
}
