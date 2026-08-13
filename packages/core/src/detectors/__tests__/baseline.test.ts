import { describe, expect, it } from "bun:test";
import { gatherBaseline, type HistoricalPoint } from "../baseline.ts";

const BUCKET = 300; // 5 min
const WEEK = 7 * 24 * 3600;

// Fixed anchor: Tuesday 2026-03-03 14:00:00 UTC = 1772546400
const T = 1772546400;

function buildWeeklyHistory(
  target: number,
  weeks: number,
  perWeekOffsets: number[],
  value: number,
): HistoricalPoint[] {
  const out: HistoricalPoint[] = [];
  for (let k = 1; k <= weeks; k += 1) {
    const anchor = target - k * WEEK;
    for (const off of perWeekOffsets) {
      out.push({ bucketTs: anchor + off, value });
    }
  }
  return out;
}

describe("gatherBaseline — seasonal path", () => {
  it("collects one sample per prior week when exactly aligned", () => {
    const history = buildWeeklyHistory(T, 4, [0], 100);
    const r = gatherBaseline(T, history, {
      bucketSeconds: BUCKET,
      baselineWeeks: 4,
      minSamples: 4,
    });
    expect(r.source).toBe("seasonal");
    expect(r.samples).toEqual([100, 100, 100, 100]);
  });

  it("also picks up points within ±1 bucket of each weekly anchor", () => {
    // 3 samples per week: at anchor-BUCKET, anchor, anchor+BUCKET — all valid.
    const history = buildWeeklyHistory(T, 4, [-BUCKET, 0, BUCKET], 50);
    const r = gatherBaseline(T, history, {
      bucketSeconds: BUCKET,
      baselineWeeks: 4,
      minSamples: 6,
    });
    expect(r.source).toBe("seasonal");
    expect(r.samples).toHaveLength(12);
    expect(r.samples.every((v) => v === 50)).toBe(true);
  });

  it("ignores samples outside the ±1 bucket tolerance", () => {
    const history = buildWeeklyHistory(T, 4, [BUCKET + 1], 999); // just outside
    const r = gatherBaseline(T, history, {
      bucketSeconds: BUCKET,
      baselineWeeks: 4,
      minSamples: 1,
    });
    // No seasonal, no rolling → insufficient with empty samples
    expect(r.source).toBe("insufficient");
    expect(r.samples).toEqual([]);
  });
});

describe("gatherBaseline — rolling fallback", () => {
  it("falls back to rolling when seasonal has < minSamples", () => {
    // Two weeks of history, minSamples = 6 → seasonal has 2, insufficient.
    // Supply a 3-hour rolling window of buckets so fallback kicks in.
    const seasonal = buildWeeklyHistory(T, 2, [0], 42);
    const rolling: HistoricalPoint[] = [];
    for (let i = 1; i <= 20; i += 1) {
      rolling.push({ bucketTs: T - i * BUCKET, value: 10 });
    }
    const r = gatherBaseline(T, [...seasonal, ...rolling], {
      bucketSeconds: BUCKET,
      baselineWeeks: 4,
      minSamples: 6,
    });
    expect(r.source).toBe("rolling");
    // All rolling samples equal 10 → we did NOT accidentally include the
    // seasonal 42s in the fallback.
    expect(r.samples.every((v) => v === 10)).toBe(true);
    expect(r.samples.length).toBeGreaterThanOrEqual(6);
  });

  it("excludes the target bucket itself from the rolling window", () => {
    // Populate points at T, T-BUCKET, T-2*BUCKET — target must not be included.
    const history: HistoricalPoint[] = [
      { bucketTs: T, value: 999 }, // <- must be excluded
      { bucketTs: T - BUCKET, value: 1 },
      { bucketTs: T - 2 * BUCKET, value: 1 },
      { bucketTs: T - 3 * BUCKET, value: 1 },
      { bucketTs: T - 4 * BUCKET, value: 1 },
      { bucketTs: T - 5 * BUCKET, value: 1 },
      { bucketTs: T - 6 * BUCKET, value: 1 },
    ];
    const r = gatherBaseline(T, history, {
      bucketSeconds: BUCKET,
      baselineWeeks: 4,
      minSamples: 5,
    });
    expect(r.source).toBe("rolling");
    expect(r.samples).not.toContain(999);
  });

  it("respects a custom rollingHours window", () => {
    const history: HistoricalPoint[] = [];
    for (let i = 1; i <= 60; i += 1) {
      history.push({ bucketTs: T - i * BUCKET, value: i });
    }
    // 1 hour window = 12 buckets of 300s
    const r = gatherBaseline(T, history, {
      bucketSeconds: BUCKET,
      baselineWeeks: 4,
      minSamples: 5,
      rollingHours: 1,
    });
    expect(r.source).toBe("rolling");
    expect(r.samples).toHaveLength(12);
  });
});

describe("gatherBaseline — insufficient path", () => {
  it("reports insufficient when neither seasonal nor rolling reach minSamples", () => {
    const r = gatherBaseline(
      T,
      [{ bucketTs: T - BUCKET, value: 1 }],
      { bucketSeconds: BUCKET, baselineWeeks: 4, minSamples: 6 },
    );
    expect(r.source).toBe("insufficient");
  });

  it("returns the larger of the two candidate sets when insufficient", () => {
    // 1 seasonal sample vs 2 rolling samples → return the 2.
    const history: HistoricalPoint[] = [
      { bucketTs: T - WEEK, value: 100 },
      { bucketTs: T - BUCKET, value: 1 },
      { bucketTs: T - 2 * BUCKET, value: 1 },
    ];
    const r = gatherBaseline(T, history, {
      bucketSeconds: BUCKET,
      baselineWeeks: 4,
      minSamples: 6,
    });
    expect(r.source).toBe("insufficient");
    expect(r.samples).toEqual([1, 1]);
  });

  it("returns empty samples when no history at all", () => {
    const r = gatherBaseline(T, [], {
      bucketSeconds: BUCKET,
      baselineWeeks: 4,
      minSamples: 6,
    });
    expect(r.source).toBe("insufficient");
    expect(r.samples).toEqual([]);
  });
});

describe("gatherBaseline — boundary cases", () => {
  it("prefers seasonal at exactly minSamples", () => {
    // seasonal produces exactly minSamples → do not fall through to rolling
    const seasonal = buildWeeklyHistory(T, 3, [0, BUCKET], 7); // 6 samples
    const rolling: HistoricalPoint[] = [];
    for (let i = 1; i <= 20; i += 1) {
      rolling.push({ bucketTs: T - i * BUCKET, value: 99 });
    }
    const r = gatherBaseline(T, [...seasonal, ...rolling], {
      bucketSeconds: BUCKET,
      baselineWeeks: 3,
      minSamples: 6,
    });
    expect(r.source).toBe("seasonal");
    expect(r.samples).toHaveLength(6);
  });

  it("does not read future data — only points at or before target-1wk are seasonal", () => {
    // A point AFTER the target: irrelevant for seasonal, irrelevant for rolling.
    const future = { bucketTs: T + WEEK, value: 500 };
    const history: HistoricalPoint[] = [
      future,
      ...buildWeeklyHistory(T, 4, [0], 20),
    ];
    const r = gatherBaseline(T, history, {
      bucketSeconds: BUCKET,
      baselineWeeks: 4,
      minSamples: 4,
    });
    expect(r.source).toBe("seasonal");
    expect(r.samples).not.toContain(500);
  });
});
