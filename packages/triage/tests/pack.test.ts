import { describe, expect, test } from "vite-plus/test";
import { calibrateCharsPerToken, itemCosts, packPrefix } from "../src/pack.ts";

describe("packing", () => {
  test("item costs are measured against the empty request", () => {
    const measure = (subset: readonly string[]) => 10 + subset.reduce((n, s) => n + s.length, 0);
    expect(itemCosts(["ab", "cdef", ""], measure)).toEqual({ base: 10, costs: [2, 4, 0] });
  });

  test("the longest prefix within budget is kept, in order", () => {
    expect(packPrefix([5, 5, 5, 5], 10, 22, 20)).toBe(2);
    expect(packPrefix([5, 5, 5, 5], 10, 30, 20)).toBe(4);
    expect(packPrefix([5, 5, 5, 5], 10, 30, 3)).toBe(3);
  });

  test("an oversized first item still goes out alone", () => {
    expect(packPrefix([100, 1], 10, 20, 20)).toBe(1);
    expect(packPrefix([], 10, 20, 20)).toBe(0);
  });

  test("calibration moves toward the observed ratio and stays in range", () => {
    expect(calibrateCharsPerToken(4, 400, 100)).toBe(4);
    expect(calibrateCharsPerToken(4, 600, 100)).toBeCloseTo(4.6);
    expect(calibrateCharsPerToken(4, 100, 100)).toBeGreaterThanOrEqual(2);
    expect(calibrateCharsPerToken(4, 10_000, 100)).toBe(8);
    expect(calibrateCharsPerToken(4, 0, 0)).toBe(4);
  });
});
