import { openDb } from "../db/client.ts";
import {
  confirmConsecutive,
  evaluateDDoS,
  evaluateTraffic,
  gatherBaseline,
  type HistoricalPoint,
  type TrafficAnomaly,
} from "../detectors/index.ts";
import { injectionAt, type Injection } from "./injections.ts";

// Runs the Stage 2 detectors against the Stage 3 seeded data and prints a
// verdict per injection ("caught" vs "correctly ignored") plus a false-alarm
// tally over the surrounding quiet windows.

const MONITOR = "seed-demo";
const BUCKET_SECONDS = 300;
const DEMO_WINDOW_HOURS = 24;
const WIB_OFFSET_HOURS = 7;

const DETECTOR_OPTS = {
  spikeZ: 3.5,
  minBaseline: 50,
  minRelativeChange: 0.4,
  minRequests: 300,
  threatRatioCrit: 0.35,
  threatRatioWarn: 0.15,
  errorRatio: 0.1,
  bucketSeconds: BUCKET_SECONDS,
  baselineWeeks: 4,
  minSamples: 6,
  consecutiveBuckets: 2,
};

// ANSI colour so the demo output is readable at a glance.
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function formatWIB(bucketTs: number): string {
  const d = new Date((bucketTs + WIB_OFFSET_HOURS * 3600) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatWIBDate(bucketTs: number): string {
  const d = new Date((bucketTs + WIB_OFFSET_HOURS * 3600) * 1000);
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${mo}-${day} ${formatWIB(bucketTs)}`;
}

interface SeedMeta {
  endTs: number;
  monitor: string;
  injections: Injection[];
}

function loadSeedMeta(sqlite: ReturnType<typeof openDb>["sqlite"]): SeedMeta {
  const row = sqlite
    .prepare(
      "SELECT value FROM system_state WHERE key = ?",
    )
    .get(`seed:${MONITOR}:injections`) as { value: string } | undefined;
  if (!row) {
    throw new Error(
      "Seed metadata not found. Run `bun run db:seed` first.",
    );
  }
  return JSON.parse(row.value) as SeedMeta;
}

interface BucketSnapshot {
  bucketTs: number;
  cfRequests: number;
  cfThreats: number;
  cfStatus5xx: number;
  cfStatus429: number;
  cfCacheMiss: number;
}

function loadSnapshots(
  sqlite: ReturnType<typeof openDb>["sqlite"],
  fromTs: number,
  toTs: number,
): BucketSnapshot[] {
  const rows = sqlite
    .prepare(
      `SELECT bucket_ts, metric, value
         FROM metrics
        WHERE monitor = ?
          AND source = 'cloudflare'
          AND bucket_ts >= ?
          AND bucket_ts < ?
        ORDER BY bucket_ts ASC`,
    )
    .all(MONITOR, fromTs, toTs) as Array<{
    bucket_ts: number;
    metric: string;
    value: number;
  }>;

  const byBucket = new Map<number, BucketSnapshot>();
  const ensure = (ts: number): BucketSnapshot => {
    let s = byBucket.get(ts);
    if (!s) {
      s = {
        bucketTs: ts,
        cfRequests: 0,
        cfThreats: 0,
        cfStatus5xx: 0,
        cfStatus429: 0,
        cfCacheMiss: 0,
      };
      byBucket.set(ts, s);
    }
    return s;
  };
  for (const r of rows) {
    const s = ensure(r.bucket_ts);
    if (r.metric === "cf_requests") s.cfRequests = r.value;
    else if (r.metric === "cf_threats") s.cfThreats = r.value;
    else if (r.metric === "cf_status_5xx") s.cfStatus5xx = r.value;
    else if (r.metric === "cf_status_429") s.cfStatus429 = r.value;
    else if (r.metric === "cf_cache_miss") s.cfCacheMiss = r.value;
  }
  return Array.from(byBucket.values()).sort(
    (a, b) => a.bucketTs - b.bucketTs,
  );
}

function loadRequestsHistory(
  sqlite: ReturnType<typeof openDb>["sqlite"],
  beforeTs: number,
  monitor: string,
): HistoricalPoint[] {
  const rows = sqlite
    .prepare(
      `SELECT bucket_ts, value FROM metrics
        WHERE monitor = ?
          AND source = 'cloudflare'
          AND metric = 'cf_requests'
          AND bucket_ts < ?`,
    )
    .all(monitor, beforeTs) as Array<{ bucket_ts: number; value: number }>;
  return rows.map((r) => ({ bucketTs: r.bucket_ts, value: r.value }));
}

interface BucketVerdict {
  bucketTs: number;
  requests: number;
  traffic: TrafficAnomaly;
  trafficConfirmed: boolean;
  ddosSeverity: "warning" | "critical" | null;
  ddosScore: number;
}

async function run(): Promise<void> {
  const { sqlite } = openDb();
  const meta = loadSeedMeta(sqlite);

  const endTs = meta.endTs; // the "now" the seed used
  const startTs = endTs - DEMO_WINDOW_HOURS * 3600;

  // Load the full request history once so the baseline gatherer can filter
  // in-memory instead of hitting SQLite per bucket.
  const fullHistory = loadRequestsHistory(sqlite, endTs, MONITOR);
  const snapshots = loadSnapshots(sqlite, startTs, endTs);

  const recent: TrafficAnomaly[] = [];
  const verdicts: BucketVerdict[] = [];

  for (const snap of snapshots) {
    // Baseline uses history strictly BEFORE the current bucket.
    const history = fullHistory.filter((h) => h.bucketTs < snap.bucketTs);
    const baseline = gatherBaseline(snap.bucketTs, history, {
      bucketSeconds: BUCKET_SECONDS,
      baselineWeeks: DETECTOR_OPTS.baselineWeeks,
      minSamples: DETECTOR_OPTS.minSamples,
    });

    const trafficResult = evaluateTraffic(
      snap.cfRequests,
      baseline.samples,
      DETECTOR_OPTS,
    );
    recent.push(trafficResult);
    if (recent.length > 10) recent.shift();
    const trafficConfirmed = confirmConsecutive(
      recent,
      DETECTOR_OPTS.consecutiveBuckets,
    );

    const ddos = evaluateDDoS(
      {
        requests: snap.cfRequests,
        requestsBaseline: baseline.samples,
        threatRequests: snap.cfThreats,
        status5xx: snap.cfStatus5xx,
        status429: snap.cfStatus429,
        cacheMissRatio:
          snap.cfRequests > 0 ? snap.cfCacheMiss / snap.cfRequests : 0,
      },
      DETECTOR_OPTS,
    );

    verdicts.push({
      bucketTs: snap.bucketTs,
      requests: snap.cfRequests,
      traffic: trafficResult,
      trafficConfirmed,
      ddosSeverity: ddos.severity,
      ddosScore: ddos.score,
    });
  }

  // ---------------------------------------------------------------------
  // Correlate verdicts with injections.
  // ---------------------------------------------------------------------

  // A traffic injection is "caught" if any bucket within its window OR
  // consecutiveBuckets-1 buckets after it shows a confirmed traffic alert.
  // A DDoS injection is "caught" if any bucket in-window has severity != null.
  const trailingBuckets = DETECTOR_OPTS.consecutiveBuckets;

  interface InjReport {
    inj: Injection;
    outcome: "caught" | "ignored" | "missed" | "spuriously-alerted";
    detail: string;
  }
  const injReports: InjReport[] = [];

  for (const inj of meta.injections) {
    const injStart = inj.atBucketTs;
    const injEnd = injStart + inj.durationBuckets * BUCKET_SECONDS;
    const windowEnd = injEnd + trailingBuckets * BUCKET_SECONDS;
    const inWindow = verdicts.filter(
      (v) => v.bucketTs >= injStart && v.bucketTs < windowEnd,
    );

    const anyTraffic = inWindow.some((v) => v.trafficConfirmed);
    const anyDDoS = inWindow.some((v) => v.ddosSeverity !== null);

    if (inj.expected === "no-alert") {
      const alerted = anyTraffic || anyDDoS;
      injReports.push({
        inj,
        outcome: alerted ? "spuriously-alerted" : "ignored",
        detail: alerted ? "false alarm 👎" : "detector held its fire",
      });
    } else if (inj.expected === "traffic-alert") {
      injReports.push({
        inj,
        outcome: anyTraffic ? "caught" : "missed",
        detail: anyTraffic
          ? `traffic alert confirmed (${inWindow.filter((v) => v.trafficConfirmed).length} buckets)`
          : "no confirmed traffic alert inside window",
      });
    } else {
      // ddos-alert
      injReports.push({
        inj,
        outcome: anyDDoS ? "caught" : "missed",
        detail: anyDDoS
          ? `DDoS severity=${inWindow.find((v) => v.ddosSeverity)?.ddosSeverity} at score=${Math.max(...inWindow.map((v) => v.ddosScore))}`
          : "no DDoS severity raised inside window",
      });
    }
  }

  // ---------------------------------------------------------------------
  // False-alarm sweep: buckets outside every injection window must be quiet.
  // ---------------------------------------------------------------------
  const quietFalsePositives: BucketVerdict[] = [];
  let quietCount = 0;
  for (const v of verdicts) {
    if (injectionAt(v.bucketTs, meta.injections)) continue;
    quietCount += 1;
    if (v.trafficConfirmed || v.ddosSeverity !== null) {
      quietFalsePositives.push(v);
    }
  }

  // ---------------------------------------------------------------------
  // Print report
  // ---------------------------------------------------------------------
  const line = "─".repeat(72);
  console.log(`\n${BOLD}Night Watch — detector demo${RESET}`);
  console.log(line);
  console.log(`Monitor:        ${MONITOR}`);
  console.log(
    `Window:         ${formatWIBDate(startTs)} → ${formatWIBDate(endTs)}  (WIB)`,
  );
  console.log(`Buckets swept:  ${verdicts.length}`);
  console.log(`History rows:   ${fullHistory.length}`);
  console.log(line);
  console.log(`${BOLD}Injections${RESET}`);
  for (const r of injReports) {
    const range = `${formatWIB(r.inj.atBucketTs)}–${formatWIB(r.inj.atBucketTs + r.inj.durationBuckets * BUCKET_SECONDS)}`;
    const outcomeText =
      r.outcome === "caught"
        ? `${GREEN}✓ CAUGHT${RESET}   `
        : r.outcome === "ignored"
          ? `${GREEN}✓ IGNORED${RESET}  `
          : r.outcome === "missed"
            ? `${RED}✗ MISSED${RESET}   `
            : `${RED}✗ FALSE +${RESET}  `;
    console.log(
      `  ${outcomeText} [${range}] ${r.inj.label}\n              ${DIM}${r.detail}${RESET}`,
    );
  }
  console.log(line);
  console.log(`${BOLD}Quiet-bucket sanity${RESET}`);
  console.log(
    `  ${quietCount - quietFalsePositives.length} / ${quietCount} non-injection buckets held quiet` +
      (quietFalsePositives.length > 0
        ? ` (${RED}${quietFalsePositives.length} spurious${RESET})`
        : ""),
  );
  if (quietFalsePositives.length > 0) {
    for (const v of quietFalsePositives.slice(0, 5)) {
      console.log(
        `    ${RED}spurious${RESET} @ ${formatWIBDate(v.bucketTs)}  requests=${v.requests}  z=${v.traffic.z.toFixed(2)}  ddos=${v.ddosSeverity ?? "-"}`,
      );
    }
  }
  console.log(line);

  const truePositives = injReports.filter((r) => r.outcome === "caught").length;
  const trueNegatives = injReports.filter((r) => r.outcome === "ignored").length;
  const falseNegatives = injReports.filter((r) => r.outcome === "missed").length;
  const falsePositivesInjection = injReports.filter(
    (r) => r.outcome === "spuriously-alerted",
  ).length;
  const totalFalsePositives =
    falsePositivesInjection + quietFalsePositives.length;

  console.log(`${BOLD}Summary${RESET}`);
  console.log(`  True positives:   ${truePositives}`);
  console.log(`  True negatives:   ${trueNegatives}`);
  console.log(`  False negatives:  ${falseNegatives}`);
  console.log(`  False positives:  ${totalFalsePositives}`);
  console.log("");

  const perfect =
    falseNegatives === 0 && totalFalsePositives === 0;
  process.exit(perfect ? 0 : 1);
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
