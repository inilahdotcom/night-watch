import { and, eq } from "drizzle-orm";
import { createLogger } from "../logger.ts";
import { openDb } from "../db/client.ts";
import { metrics } from "../db/schema.ts";
import { generateSeries, type MetricRow } from "./generate.ts";
import type { Injection } from "./injections.ts";

// Seeds ~6 weeks of realistic Cloudflare + GA4 metrics for a synthetic
// monitor, with a handful of injections placed in the final day so the demo
// script can compare "what the detector said" against "what we deliberately
// planted".
//
// Idempotent: re-running wipes existing seeded rows for the monitor before
// inserting. Uses a fixed PRNG seed so the report is byte-stable across runs.

const MONITOR = "seed-demo";
const BUCKET_SECONDS = 300;
const WEEKS = 6;
const DAY = 24 * 3600;
const HOUR = 3600;
const UTC_OFFSET_HOURS = 7; // WIB
const PEAK_REQUESTS = 1500;
const SEED = 42;

function alignBucket(ts: number): number {
  return Math.floor(ts / BUCKET_SECONDS) * BUCKET_SECONDS;
}

/** Build the injection list, anchored to `now` (aligned to bucket boundaries). */
function buildInjections(now: number): Injection[] {
  const t = (offsetSeconds: number): number =>
    alignBucket(now - offsetSeconds);

  return [
    {
      kind: "spike",
      atBucketTs: t(20 * HOUR),
      durationBuckets: 3,
      volumeFactor: 3.2,
      label: "Real spike (3.2× traffic for 15 min)",
      expected: "traffic-alert",
    },
    {
      kind: "attack",
      atBucketTs: t(16 * HOUR),
      durationBuckets: 3,
      volumeFactor: 3.5,
      threatRatio: 0.42,
      errorRatio: 0.16,
      cacheMissRatio: 0.85,
      label: "DDoS pattern (volume + firewall + 5xx + cache-bust)",
      expected: "ddos-alert",
    },
    {
      kind: "spike",
      // Single-bucket 1.5× on a mid-to-quiet baseline. Traffic detector may
      // trigger this single bucket but the consecutive gate declines to
      // confirm; DDoS volume weight caps at 2 (z below 2×spikeZ) → score 2
      // → below warning threshold. Genuinely silent.
      atBucketTs: t(15 * HOUR),
      durationBuckets: 1,
      volumeFactor: 1.5,
      label: "Single-bucket flicker (should NOT trigger — consecutive gate)",
      expected: "no-alert",
    },
    {
      kind: "spike",
      // 1.15× for 3 buckets: relative change ≈ 0.15 (below 0.4) blocks the
      // traffic detector via guard 3; the small z (~1) also blocks guard 1.
      // DDoS scores 0 across the window.
      atBucketTs: t(13 * HOUR),
      durationBuckets: 3,
      volumeFactor: 1.15,
      label: "Modest bump (should NOT trigger — relative-change guard)",
      expected: "no-alert",
    },
    {
      kind: "drop",
      atBucketTs: t(12 * HOUR),
      durationBuckets: 3,
      volumeFactor: 0.15,
      label: "Traffic drop (85% lost, 15 min)",
      expected: "traffic-alert",
    },
  ];
}

async function run(): Promise<void> {
  const log = createLogger("seed");
  const { db, sqlite } = openDb();

  // Anchor "now" to a stable bucket edge in the recent past — leaves the
  // final bucket mature (per brief §9, don't evaluate the currently-filling
  // bucket).
  const nowSec = Math.floor(Date.now() / 1000);
  const endTs = alignBucket(nowSec - BUCKET_SECONDS * 2);
  const startTs = alignBucket(endTs - WEEKS * 7 * DAY);
  const injections = buildInjections(endTs);

  log.info(
    {
      monitor: MONITOR,
      startTs,
      endTs,
      weeks: WEEKS,
      buckets: (endTs - startTs) / BUCKET_SECONDS,
      injections: injections.length,
    },
    "generating series",
  );

  const rows: MetricRow[] = generateSeries({
    monitor: MONITOR,
    startTs,
    endTs,
    bucketSeconds: BUCKET_SECONDS,
    peakRequestsPerBucket: PEAK_REQUESTS,
    utcOffsetHours: UTC_OFFSET_HOURS,
    seed: SEED,
    injections,
  });

  log.info({ rows: rows.length }, "series generated, writing to DB");

  // Wipe existing rows for this monitor so re-runs are clean.
  db.delete(metrics).where(eq(metrics.monitor, MONITOR)).run();

  // Bulk insert inside a single transaction — bun:sqlite handles this in one
  // fast path. Chunked to keep parameter counts under SQLite's default limit
  // (999 in older builds; modern is higher but chunking is cheap insurance).
  const CHUNK = 500;
  const insertBatch = sqlite.transaction((batch: MetricRow[]) => {
    db.insert(metrics).values(batch).run();
  });

  for (let i = 0; i < rows.length; i += CHUNK) {
    insertBatch(rows.slice(i, i + CHUNK));
  }

  // Record the injection ground truth in system_state so demo.ts can find
  // it without duplicating the buildInjections() definition.
  const stateInsert = sqlite.prepare(
    `INSERT INTO system_state (key, value, updated_at)
       VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  stateInsert.run(
    `seed:${MONITOR}:injections`,
    JSON.stringify({ endTs, monitor: MONITOR, injections }),
    Date.now(),
  );

  const finalCount = db.$count(metrics, and(eq(metrics.monitor, MONITOR)));

  log.info(
    { monitor: MONITOR, count: Number(finalCount) },
    "seed complete",
  );
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
