/**
 * Named thresholds for decide(). No SDK import: the web app reads these too.
 */
export interface Thresholds {
  /** Category is auto-applied at or above this confidence; below goes to the review queue. */
  categoryAuto: number;
  /** Area is auto-applied at or above this confidence. */
  areaAuto: number;
  /** A duplicate suggestion is surfaced at or above this; it is never auto-closed. */
  duplicateMin: number;
  /** Noul probabilities at or above this count as "yes". */
  yes: number;
  /** A reviewer suggestion is shown as confident at or above this (a choice among ~5). */
  reviewerAuto: number;
}

export const THRESHOLDS: Thresholds = {
  categoryAuto: 0.6,
  areaAuto: 0.6,
  duplicateMin: 0.7,
  yes: 0.5,
  reviewerAuto: 0.45,
};
