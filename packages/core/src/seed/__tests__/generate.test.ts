import { describe, expect, it } from "bun:test";
import { generateSeries } from "../generate.ts";
import type { Injection } from "../injections.ts";

const BUCKET = 300;
const ONE_HOUR = 3600;
const ONE_DAY = 24 * 3600;

const BASE_OPTS = {
  monitor: "test",
  startTs: 1_700_000_000,
  endTs: 1_700_000_000 + ONE_DAY, // 1 day → 288 buckets
  bucketSeconds: BUCKET,
  peakRequestsPerBucket: 1000,
  utcOffsetHours: 7,
  seed: 1234,
  injections: [] as Injection[],
} as const;

describe("generateSeries — determinism", () => {
  it("produces byte-identical rows across two runs with the same seed", () => {
    const a = generateSeries(BASE_OPTS);
    const b = generateSeries(BASE_OPTS);
    expect(a).toEqual(b);
  });

  it("differs when the seed changes", () => {
    const a = generateSeries({ ...BASE_OPTS, seed: 1 });
    const b = generateSeries({ ...BASE_OPTS, seed: 2 });
    expect(a).not.toEqual(b);
  });
});

describe("generateSeries — output shape", () => {
  const rows = generateSeries(BASE_OPTS);
  const expectedBuckets =
    (BASE_OPTS.endTs - BASE_OPTS.startTs) / BASE_OPTS.bucketSeconds;
  const expectedMetricsPerBucket = 12; // 10 cf + 2 ga

  it("emits (endTs - startTs) / bucket rows × 12 metrics", () => {
    expect(rows).toHaveLength(expectedBuckets * expectedMetricsPerBucket);
  });

  it("labels every row with the requested monitor", () => {
    expect(rows.every((r) => r.monitor === "test")).toBe(true);
  });

  it("has one cf_requests row per bucket", () => {
    const requestsRows = rows.filter((r) => r.metric === "cf_requests");
    expect(requestsRows).toHaveLength(expectedBuckets);
  });

  it("has all 12 metrics for every bucket", () => {
    const buckets = new Map<number, Set<string>>();
    for (const r of rows) {
      if (!buckets.has(r.bucketTs)) buckets.set(r.bucketTs, new Set());
      buckets.get(r.bucketTs)!.add(r.metric);
    }
    for (const [, mset] of buckets) {
      expect(mset.size).toBe(expectedMetricsPerBucket);
    }
  });

  it("produces non-negative integer values across every row", () => {
    for (const r of rows) {
      expect(r.value).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.value)).toBe(true);
    }
  });

  it("uses cloudflare source for cf_* metrics and ga4 for ga_* metrics", () => {
    for (const r of rows) {
      if (r.metric.startsWith("cf_")) expect(r.source).toBe("cloudflare");
      if (r.metric.startsWith("ga_")) expect(r.source).toBe("ga4");
    }
  });
});

describe("generateSeries — patterns are visible", () => {
  it("has higher median request values during working hours than at 3am", () => {
    const rows = generateSeries({
      ...BASE_OPTS,
      endTs: BASE_OPTS.startTs + 7 * ONE_DAY,
    });
    const requests = rows.filter((r) => r.metric === "cf_requests");
    // WIB hour of each bucket
    const byHour = new Map<number, number[]>();
    for (const r of requests) {
      const wibHour =
        (Math.floor((r.bucketTs + 7 * ONE_HOUR) / ONE_HOUR) % 24 + 24) % 24;
      if (!byHour.has(wibHour)) byHour.set(wibHour, []);
      byHour.get(wibHour)!.push(r.value);
    }
    const median = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const noon = median(byHour.get(13)!);
    const preDawn = median(byHour.get(3)!);
    expect(noon).toBeGreaterThan(preDawn * 3);
  });
});

describe("generateSeries — injections", () => {
  const inj: Injection = {
    kind: "spike",
    atBucketTs: BASE_OPTS.startTs + 100 * BUCKET,
    durationBuckets: 3,
    volumeFactor: 5,
    label: "test spike",
    expected: "traffic-alert",
  };

  const rows = generateSeries({ ...BASE_OPTS, injections: [inj] });
  const requests = rows
    .filter((r) => r.metric === "cf_requests")
    .sort((a, b) => a.bucketTs - b.bucketTs);

  it("boosts covered buckets", () => {
    const covered = requests.filter(
      (r) =>
        r.bucketTs >= inj.atBucketTs &&
        r.bucketTs < inj.atBucketTs + inj.durationBuckets * BUCKET,
    );
    const before = requests
      .filter((r) => r.bucketTs < inj.atBucketTs)
      .slice(-5);
    const beforeAvg =
      before.reduce((s, r) => s + r.value, 0) / before.length;
    for (const c of covered) {
      // Some noise applies, but 5× baseline should still land well above pre-spike mean.
      expect(c.value).toBeGreaterThan(beforeAvg * 2);
    }
  });

  it("leaves uncovered buckets unchanged relative to a no-injection generation", () => {
    const clean = generateSeries(BASE_OPTS).filter(
      (r) => r.metric === "cf_requests",
    );
    for (const c of clean) {
      const injected = requests.find((r) => r.bucketTs === c.bucketTs)!;
      const inWindow =
        c.bucketTs >= inj.atBucketTs &&
        c.bucketTs < inj.atBucketTs + inj.durationBuckets * BUCKET;
      if (!inWindow) {
        expect(injected.value).toBe(c.value);
      }
    }
  });

  it("attack injection perturbs threat/5xx/cache_miss beyond baseline ratio", () => {
    const attackInj: Injection = {
      kind: "attack",
      atBucketTs: BASE_OPTS.startTs + 200 * BUCKET,
      durationBuckets: 2,
      volumeFactor: 3,
      threatRatio: 0.4,
      errorRatio: 0.2,
      cacheMissRatio: 0.9,
      label: "test attack",
      expected: "ddos-alert",
    };
    const attackRows = generateSeries({
      ...BASE_OPTS,
      injections: [attackInj],
    });
    const at = attackInj.atBucketTs;
    const req = attackRows.find(
      (r) => r.bucketTs === at && r.metric === "cf_requests",
    )!;
    const threats = attackRows.find(
      (r) => r.bucketTs === at && r.metric === "cf_threats",
    )!;
    const miss = attackRows.find(
      (r) => r.bucketTs === at && r.metric === "cf_cache_miss",
    )!;
    // Threat ratio during attack ~ 0.4 (well above baseline 0.005)
    expect(threats.value / req.value).toBeGreaterThan(0.3);
    // Cache miss ~ 0.9 during attack (baseline 0.1)
    expect(miss.value / req.value).toBeGreaterThan(0.7);
  });
});
