import { describe, expect, it } from "bun:test";
import {
  averageAbsoluteDeviation,
  median,
  medianAbsoluteDeviation,
  robustZScore,
} from "../stats.ts";

describe("median", () => {
  it("returns the single element for length 1", () => {
    expect(median([42])).toBe(42);
  });

  it("returns the middle element for odd length", () => {
    expect(median([1, 2, 3, 4, 5])).toBe(3);
  });

  it("returns the average of the two middle elements for even length", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("handles unsorted input", () => {
    expect(median([9, 1, 5, 3, 7])).toBe(5);
  });

  it("throws on empty input", () => {
    expect(() => median([])).toThrow(/empty/);
  });

  it("does not mutate the input", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("medianAbsoluteDeviation", () => {
  it("computes MAD against internal median when not supplied", () => {
    // samples: [1, 2, 3, 4, 5], median=3, |x-3|=[2,1,0,1,2], median of those = 1
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5])).toBe(1);
  });

  it("uses supplied median if provided", () => {
    // With median=0: |x|=[1,2,3,4,5] → 3
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 5], 0)).toBe(3);
  });

  it("returns 0 when all samples equal the median (MAD=0 boundary)", () => {
    expect(medianAbsoluteDeviation([7, 7, 7, 7, 7])).toBe(0);
  });

  it("returns 0 when more than half the samples are identical", () => {
    // median = 5, deviations = [4, 0, 0, 0, 0], median of deviations = 0
    expect(medianAbsoluteDeviation([1, 5, 5, 5, 5])).toBe(0);
  });
});

describe("averageAbsoluteDeviation", () => {
  it("returns mean of |xi - median|", () => {
    // median=3, |x-3|=[2,1,0,1,2], mean = 6/5 = 1.2
    expect(averageAbsoluteDeviation([1, 2, 3, 4, 5])).toBeCloseTo(1.2);
  });

  it("stays positive when MAD hits zero on a single outlier + run of same values", () => {
    // median=5, MAD=0, but avgAbsDev = |1-5|/5 = 0.8 — this is the whole
    // reason avgAbsDev exists in the fallback chain.
    expect(medianAbsoluteDeviation([1, 5, 5, 5, 5])).toBe(0);
    expect(averageAbsoluteDeviation([1, 5, 5, 5, 5])).toBeCloseTo(0.8);
  });

  it("returns 0 when all samples are identical", () => {
    expect(averageAbsoluteDeviation([7, 7, 7, 7, 7])).toBe(0);
  });
});

describe("robustZScore — the fallback ladder", () => {
  it("uses MAD when it is positive (the normal case)", () => {
    // baseline of moderate variance
    const samples = [10, 12, 14, 16, 18];
    const r = robustZScore(20, samples);
    expect(r.scaleSource).toBe("mad");
    expect(r.median).toBe(14);
    expect(r.scale).toBe(2);
    // z = 0.6745 * (20 - 14) / 2 = 2.0235
    expect(r.z).toBeCloseTo(2.0235);
  });

  it("falls back to avgAbsDev when MAD = 0 but values are not all identical", () => {
    // Majority of samples identical → MAD = 0, but avgAbsDev > 0.
    const samples = [5, 5, 5, 5, 20];
    const r = robustZScore(50, samples);
    expect(r.scaleSource).toBe("avgAbsDev");
    expect(r.median).toBe(5);
    // avgAbsDev = (0+0+0+0+15)/5 = 3
    expect(r.scale).toBe(3);
    // z = 0.6745 * (50 - 5) / 3 = 10.1175
    expect(r.z).toBeCloseTo(10.1175);
  });

  it("floors at max(1, |median|*0.1) when MAD and avgAbsDev are both 0", () => {
    // All identical → both scales collapse. Without a floor, z = ∞.
    const samples = [0, 0, 0, 0, 0, 0];
    const r = robustZScore(10, samples);
    expect(r.scaleSource).toBe("floor");
    expect(r.median).toBe(0);
    expect(r.scale).toBe(1); // max(1, 0*0.1) = 1
    expect(r.z).toBeCloseTo(0.6745 * 10);
    expect(Number.isFinite(r.z)).toBe(true);
  });

  it("uses median * 0.1 floor for large all-identical baselines", () => {
    // Everything is 1000 → floor = max(1, 100) = 100
    const samples = [1000, 1000, 1000, 1000, 1000];
    const r = robustZScore(1200, samples);
    expect(r.scaleSource).toBe("floor");
    expect(r.scale).toBe(100);
    expect(r.z).toBeCloseTo(0.6745 * (200 / 100));
  });

  it("returns a negative z-score for values below the median (drops)", () => {
    const samples = [100, 110, 120, 130, 140];
    const r = robustZScore(50, samples);
    expect(r.z).toBeLessThan(0);
    expect(r.scaleSource).toBe("mad");
  });

  it("returns z = 0 at the median", () => {
    const r = robustZScore(120, [100, 110, 120, 130, 140]);
    expect(r.z).toBe(0);
  });

  it("throws on empty samples", () => {
    expect(() => robustZScore(5, [])).toThrow(/empty/);
  });
});
