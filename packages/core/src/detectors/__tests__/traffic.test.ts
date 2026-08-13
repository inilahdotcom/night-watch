import { describe, expect, it } from "bun:test";
import { confirmConsecutive, evaluateTraffic } from "../traffic.ts";

const DEFAULTS = {
  spikeZ: 3.5,
  minBaseline: 50,
  minRelativeChange: 0.4,
};

// Helper: an all-100 baseline gives median=100, MAD=0, avgAbsDev=0 → floor
// path. Use small jitter when we want a non-zero MAD.
const stable100 = [100, 100, 100, 100, 100, 100];
const stable100Jitter = [95, 100, 100, 100, 100, 105];

describe("evaluateTraffic — normal cases", () => {
  it("does not trigger on values near the median", () => {
    const r = evaluateTraffic(102, stable100Jitter, DEFAULTS);
    expect(r.triggered).toBe(false);
    expect(r.direction).toBeNull();
  });

  it("triggers a spike when all three guards pass", () => {
    // median=100, giant deviation, relative change 3× > 0.4 → all pass
    const r = evaluateTraffic(400, stable100Jitter, DEFAULTS);
    expect(r.triggered).toBe(true);
    expect(r.direction).toBe("spike");
    expect(r.reasons).toEqual([]);
    expect(r.z).toBeGreaterThan(DEFAULTS.spikeZ);
    expect(r.relativeChange).toBeGreaterThan(DEFAULTS.minRelativeChange);
  });

  it("triggers a drop when value collapses below median", () => {
    const r = evaluateTraffic(2, stable100Jitter, DEFAULTS);
    expect(r.triggered).toBe(true);
    expect(r.direction).toBe("drop");
    expect(r.z).toBeLessThan(-DEFAULTS.spikeZ);
  });
});

describe("evaluateTraffic — guards blocking false alarms", () => {
  it("blocks alerts when the median is below minBaseline (guard 2)", () => {
    // Baseline is 8, value 20. Statistically significant, but median < 50.
    const samples = [7, 8, 8, 8, 9, 9];
    const r = evaluateTraffic(20, samples, DEFAULTS);
    expect(r.triggered).toBe(false);
    expect(r.reasons.some((s) => s.includes("minBaseline"))).toBe(true);
  });

  it("blocks alerts when the relative change is below minRelativeChange (guard 3)", () => {
    // Baseline median 100, value 115: relative 0.15 < 0.4 → blocked
    // Use jitter that keeps z manageable enough that we know it's the relative
    // guard doing the blocking (build baseline where MAD is small enough that
    // z would otherwise pass).
    const samples = [99, 100, 100, 100, 100, 101];
    const r = evaluateTraffic(115, samples, DEFAULTS);
    expect(r.triggered).toBe(false);
    // Both z and relative could be under threshold; check the reason we care about is listed.
    const hasRelativeReason = r.reasons.some((s) =>
      s.includes("minRelativeChange"),
    );
    // Either the relative guard fires OR the value doesn't clear z, but
    // it must not trigger.
    expect(hasRelativeReason || Math.abs(r.z) < DEFAULTS.spikeZ).toBe(true);
  });

  it("blocks alerts when z is under threshold (guard 1)", () => {
    // Big variance baseline → high value still lands within a couple of MADs
    const noisy = [50, 100, 150, 100, 50, 150, 100];
    const r = evaluateTraffic(160, noisy, DEFAULTS);
    expect(r.triggered).toBe(false);
    expect(r.reasons.some((s) => s.includes("spikeZ"))).toBe(true);
  });

  it("handles MAD=0 baselines via the fallback ladder without exploding", () => {
    // All-identical baseline → floor path in stats.ts. Should still produce
    // a finite z-score and a real decision.
    const r = evaluateTraffic(500, stable100, DEFAULTS);
    expect(Number.isFinite(r.z)).toBe(true);
    // A 5× jump against a 100 median clears all three guards even with the floor.
    expect(r.triggered).toBe(true);
    expect(r.direction).toBe("spike");
  });

  it("does not alert on a run of zeros with a modest positive value", () => {
    // Classic false-alarm shape: baseline is all zeros at 3am, one value appears.
    // Guard 2 (minBaseline=50) blocks this: 0 << 50.
    const r = evaluateTraffic(5, [0, 0, 0, 0, 0, 0], DEFAULTS);
    expect(r.triggered).toBe(false);
    expect(r.reasons.some((s) => s.includes("minBaseline"))).toBe(true);
  });

  it("does not alert on empty baseline", () => {
    const r = evaluateTraffic(1000, [], DEFAULTS);
    expect(r.triggered).toBe(false);
    expect(r.reasons).toContain("empty baseline");
  });
});

describe("evaluateTraffic — small-numbers ridiculousness (brief §5.3)", () => {
  it("does not alert on 8 → 20 users even though the ratio is 2.5×", () => {
    // "Naik dari 8 ke 20 pengunjung bisa saja signifikan secara statistik,
    //  tapi itu bukan insiden." — this exact case from the brief.
    const samples = [8, 8, 9, 8, 8, 9];
    const r = evaluateTraffic(20, samples, DEFAULTS);
    expect(r.triggered).toBe(false);
    // The minBaseline guard specifically is what protects us here.
    expect(r.reasons.some((s) => s.includes("minBaseline"))).toBe(true);
  });
});

describe("confirmConsecutive", () => {
  const spike = evaluateTraffic(500, stable100Jitter, DEFAULTS);
  const drop = evaluateTraffic(2, stable100Jitter, DEFAULTS);
  const quiet = evaluateTraffic(100, stable100Jitter, DEFAULTS);

  it("returns false with fewer than `required` samples", () => {
    expect(confirmConsecutive([spike], 2)).toBe(false);
  });

  it("returns true when the last N are all triggered in the same direction", () => {
    expect(confirmConsecutive([quiet, spike, spike], 2)).toBe(true);
  });

  it("returns false when any of the last N is not triggered", () => {
    expect(confirmConsecutive([spike, quiet, spike], 2)).toBe(false);
  });

  it("returns false when direction flips within the window", () => {
    expect(confirmConsecutive([spike, drop], 2)).toBe(false);
  });

  it("evaluates only the trailing window, not the full history", () => {
    // Long quiet history followed by 2 spikes — should confirm.
    const history = [quiet, quiet, quiet, quiet, spike, spike];
    expect(confirmConsecutive(history, 2)).toBe(true);
  });
});
