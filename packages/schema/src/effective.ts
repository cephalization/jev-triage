import type { ClassificationKind } from "./schema.ts";

/**
 * Effective value of a field = latest human feedback for that kind, else the latest
 * model classification for that kind at the current questions_version. Model rows are
 * never overwritten by human ones; this is where the two are reconciled.
 */

export interface ClassificationLike {
  kind: string;
  value: string;
  confidence?: number | null;
  probabilities_json: Record<string, number>;
  questions_version: number;
  created_at: number;
  model?: string;
}

export interface FeedbackLike {
  kind: string;
  value: string;
  user_id: string;
  note?: string | null;
  created_at: number;
}

export interface EffectiveField {
  value: string | null;
  /** Concentration of the model's distribution; null when a human set the value. */
  confidence: number | null;
  probabilities: Record<string, number>;
  source: "human" | "model" | "none";
  /** Latest model answer, kept even when a human overrode it, so disagreement is visible. */
  model: ClassificationLike | null;
  human: FeedbackLike | null;
  /** True when a human answer exists and differs from the model's current answer. */
  disagreement: boolean;
}

function latest<T extends { created_at: number }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const r of rows) if (!best || r.created_at > best.created_at) best = r;
  return best;
}

/** jsonb written as a JSON string by an older writer still reads as an object. */
export function probabilitiesOf(c: ClassificationLike | null): Record<string, number> {
  const raw: unknown = c?.probabilities_json;
  if (raw && typeof raw === "object") return raw as Record<string, number>;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as Record<string, number>;
    } catch {
      return {};
    }
  }
  return {};
}

export function effectiveField(
  kind: ClassificationKind,
  classifications: readonly ClassificationLike[],
  feedback: readonly FeedbackLike[],
  questionsVersion: number,
): EffectiveField {
  const model = latest(
    classifications.filter((c) => c.kind === kind && c.questions_version === questionsVersion),
  );
  const human = latest(feedback.filter((f) => f.kind === kind));
  if (human) {
    return {
      value: human.value,
      confidence: null,
      probabilities: probabilitiesOf(model),
      source: "human",
      model,
      human,
      disagreement: model !== null && model.value !== human.value,
    };
  }
  if (model) {
    return {
      value: model.value,
      confidence: model.confidence ?? null,
      probabilities: probabilitiesOf(model),
      source: "model",
      model,
      human: null,
      disagreement: false,
    };
  }
  return {
    value: null,
    confidence: null,
    probabilities: {},
    source: "none",
    model: null,
    human: null,
    disagreement: false,
  };
}

export type EffectiveIssue = Record<ClassificationKind, EffectiveField>;

export function effectiveIssue(
  classifications: readonly ClassificationLike[],
  feedback: readonly FeedbackLike[],
  questionsVersion: number,
  kinds: readonly ClassificationKind[],
): EffectiveIssue {
  const out = {} as EffectiveIssue;
  for (const k of kinds) out[k] = effectiveField(k, classifications, feedback, questionsVersion);
  return out;
}

/** Numeric reading of a score/noul field stored as a decimal string. */
export function numeric(field: EffectiveField): number | null {
  if (field.value === null) return null;
  const n = Number(field.value);
  return Number.isFinite(n) ? n : null;
}
