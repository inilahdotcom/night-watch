import type { MetricName, MetricSource } from "../db/schema.ts";
import { gaussian, meanValueAt, mulberry32 } from "./patterns.ts";
import { injectionAt, type Injection } from "./injections.ts";

// Multi-metric time series generator. Produces one row per (monitor, source,
// metric, bucketTs) that will be bulk-inserted into the `metrics` table.
//
// All metrics that hang off traffic (bytes, threats, 5xx, 429, cache-miss, GA
// users) are derived from a single `requests` series so a spike shows up
// coherently across the whole picture. Attack injections *do* decouple these
// ratios — that's the whole point of the DDoS detector.

export interface GenerateOptions {
  monitor: string;
  startTs: number; // inclusive, unix seconds
  endTs: number; // exclusive
  bucketSeconds: number; // 300
  peakRequestsPerBucket: number; // e.g. 1500 at peak
  utcOffsetHours: number; // e.g. 7 for WIB
  seed: number;
  injections: readonly Injection[];
  /** Baseline ratios during quiet operation. */
  ratios?: {
    threat: number; // e.g. 0.005 (0.5% by default)
    error5xx: number; // e.g. 0.002
    rateLimit429: number; // e.g. 0.0005
    cacheMiss: number; // e.g. 0.10
    bytesPerRequest: number; // e.g. 12_000 bytes
    gaFraction: number; // e.g. 0.3 (unique users ~ 30% of requests)
    bot: number; // e.g. 0.35 (scored traffic that is unverified-automated)
    verifiedBot: number; // e.g. 0.05 (Googlebot and friends)
  };
}

export interface MetricRow {
  monitor: string;
  source: MetricSource;
  metric: MetricName;
  bucketTs: number;
  value: number;
}

const DEFAULT_RATIOS: Required<GenerateOptions>["ratios"] = {
  threat: 0.005,
  error5xx: 0.002,
  rateLimit429: 0.0005,
  cacheMiss: 0.1,
  bytesPerRequest: 12_000,
  gaFraction: 0.3,
  bot: 0.35,
  verifiedBot: 0.05,
};

const NOISE_STDDEV = 0.08; // multiplicative noise, 8% stddev

/** Clamp x into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function generateSeries(opts: GenerateOptions): MetricRow[] {
  const ratios = { ...DEFAULT_RATIOS, ...(opts.ratios ?? {}) };
  const rand = mulberry32(opts.seed);
  const rows: MetricRow[] = [];

  for (
    let bucketTs = opts.startTs;
    bucketTs < opts.endTs;
    bucketTs += opts.bucketSeconds
  ) {
    const clean = meanValueAt(
      bucketTs,
      opts.peakRequestsPerBucket,
      opts.utcOffsetHours,
    );
    const noise = 1 + gaussian(rand, 0, NOISE_STDDEV);
    let requests = clean * clamp(noise, 0.5, 1.6);

    // Ratios that may be perturbed by an attack injection.
    let threatRatio = ratios.threat;
    let errorRatio = ratios.error5xx;
    let rateLimitRatio = ratios.rateLimit429;
    let cacheMissRatio = ratios.cacheMiss;
    let botRatio = ratios.bot;

    const inj = injectionAt(bucketTs, opts.injections);
    if (inj) {
      if (inj.kind === "spike") {
        requests *= inj.volumeFactor;
      } else if (inj.kind === "drop") {
        requests *= inj.volumeFactor;
      } else {
        // attack — bump volume AND all the DDoS-flavored ratios
        requests *= inj.volumeFactor;
        threatRatio = inj.threatRatio;
        errorRatio = inj.errorRatio;
        cacheMissRatio = inj.cacheMissRatio;
        rateLimitRatio = Math.max(rateLimitRatio, 0.06); // usually rate-limits kick in
        botRatio = 0.85; // an attack is overwhelmingly automated
      }
    }

    // Round requests to non-negative integer for realism.
    requests = Math.max(0, Math.round(requests));

    const push = (metric: MetricName, value: number, source: MetricSource) => {
      rows.push({
        monitor: opts.monitor,
        source,
        metric,
        bucketTs,
        value,
      });
    };

    push("cf_requests", requests, "cloudflare");
    push("cf_bytes", Math.round(requests * ratios.bytesPerRequest), "cloudflare");
    push("cf_threats", Math.round(requests * threatRatio), "cloudflare");
    push(
      "cf_status_5xx",
      Math.round(requests * errorRatio),
      "cloudflare",
    );
    push(
      "cf_status_4xx",
      Math.round(requests * 0.02), // roughly steady 2% 4xx (mostly bot noise)
      "cloudflare",
    );
    push(
      "cf_status_429",
      Math.round(requests * rateLimitRatio),
      "cloudflare",
    );
    // cf_cache_miss stored as absolute count of misses (ratio can be derived
    // by dividing by requests). We store the count for consistency with the
    // other cf_* metrics being counts.
    push(
      "cf_cache_miss",
      Math.round(requests * cacheMissRatio),
      "cloudflare",
    );

    // Bot split. Verified bots are carved out first so bot + human + verified
    // sums to `requests` — the share detector divides by (bot + human) only.
    const verified = Math.round(requests * ratios.verifiedBot);
    const scored = requests - verified;
    const bots = Math.round(scored * botRatio);
    push("cf_bot_requests", bots, "cloudflare");
    push("cf_human_requests", scored - bots, "cloudflare");
    push("cf_verified_bot_requests", verified, "cloudflare");

    push(
      "ga_active_users",
      Math.max(0, Math.round(requests * ratios.gaFraction)),
      "ga4",
    );
    push("ga_page_views", requests, "ga4");
  }

  return rows;
}
