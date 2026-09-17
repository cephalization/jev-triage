import { describe, expect, test } from "vite-plus/test";
import { calibrate, expectedCalibrationError } from "../src/calibration.ts";
import { DEFAULT_WEIGHTS, logNorm, priority } from "../src/priority.ts";

describe("priority", () => {
  test("weights change the ranking without any inference", () => {
    const a = { severity: 1, urgency: 0, reactionsNorm: 0, commentsNorm: 0, ageNorm: 0 };
    const b = { severity: 0, urgency: 1, reactionsNorm: 0, commentsNorm: 0, ageNorm: 0 };
    expect(priority(a) > priority(b)).toBe(true);
    const urgencyFirst = { ...DEFAULT_WEIGHTS, severity: 0.1, urgency: 0.9 };
    expect(priority(a, urgencyFirst) < priority(b, urgencyFirst)).toBe(true);
  });

  test("all-zero weights yield 0 and results are clamped to [0,1]", () => {
    const f = { severity: 1, urgency: 1, reactionsNorm: 1, commentsNorm: 1, ageNorm: 1 };
    expect(priority(f, { severity: 0, urgency: 0, reactions: 0, comments: 0, age: 0 })).toBe(0);
    expect(priority(f)).toBe(1);
  });

  test("logNorm", () => {
    expect(logNorm(0, 100)).toBe(0);
    expect(logNorm(100, 100)).toBe(1);
    expect(logNorm(10, 100)).toBeGreaterThan(0.5);
  });
});

describe("calibration", () => {
  test("buckets confidence and reports agreement", () => {
    const b = calibrate([
      { confidence: 0.95, agreed: true },
      { confidence: 0.9, agreed: true },
      { confidence: 0.85, agreed: false },
      { confidence: 0.3, agreed: false },
      { confidence: 1, agreed: true },
    ]);
    expect(b).toHaveLength(5);
    expect(b[4]!.count).toBe(4);
    expect(b[4]!.agreement).toBeCloseTo(0.75);
    expect(b[1]!.count).toBe(1);
    expect(b[0]!.agreement).toBeNull();
    const ece = expectedCalibrationError(b);
    expect(ece).not.toBeNull();
    expect(ece!).toBeGreaterThan(0);
  });

  test("empty input has no ECE", () => {
    expect(expectedCalibrationError(calibrate([]))).toBeNull();
  });
});
