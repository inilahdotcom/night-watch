import type { Database } from "bun:sqlite"
import { openDb } from "../db/client.ts"
import { loadMonitors, monitorDefaults } from "../config/monitors.ts"
import type { Monitor } from "../config/monitors.ts"
import {
  confirmConsecutive,
  evaluateDDoS,
  evaluateTraffic,
  gatherBaseline,
} from "../detectors/index.ts"
import type { HistoricalPoint, TrafficAnomaly } from "../detectors/index.ts"
import { alignBucket, loadMetricHistory } from "./cycle.ts"

// Threshold backtester.
//
// Tuning `spikeZ` or `minRelativeChange` used to mean changing a number,
// restarting the worker, and waiting a week to find out whether you had made
// the system deaf or unbearable. This replays the real stored metrics through
// the real detectors with candidate parameters and reports what would have
// fired.
//
// Strictly read-only: no engine, no channels, no writes. It cannot raise an
// alert, so it is safe to run against production data while the worker is
// running.
//
// The seed harness (`db:demo`) proves the detectors behave on synthetic data
// with known planted anomalies. This is its counterpart for real data, where
// nobody knows the right answer in advance and the useful question is "how
// many, and when".

export interface BacktestOverrides {
  spikeZ?: number
  minBaseline?: number
  minRelativeChange?: number
  consecutiveBuckets?: number
  minRequests?: number
}

export interface BacktestHit {
  bucketTs: number
  kind: "traffic:spike" | "traffic:drop" | "ddos"
  detail: string
}

export interface BacktestResult {
  monitor: string
  params: Required<BacktestOverrides>
  /** Buckets that had data and were old enough to judge. */
  bucketsEvaluated: number
  /** Buckets skipped because the baseline was too thin to say anything. */
  bucketsWithoutBaseline: number
  from: number
  to: number
  hits: BacktestHit[]
}

export interface BacktestOptions {
  sqlite: Database
  monitor: Monitor
  weeks: number
  overrides?: BacktestOverrides
  now?: () => number
}

export function backtest(opts: BacktestOptions): BacktestResult {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000))
  const m = opts.monitor
  const o = opts.overrides ?? {}
  const params: Required<BacktestOverrides> = {
    spikeZ: o.spikeZ ?? m.spikeZ,
    minBaseline: o.minBaseline ?? m.minBaseline,
    minRelativeChange: o.minRelativeChange ?? m.minRelativeChange,
    consecutiveBuckets: o.consecutiveBuckets ?? m.consecutiveBuckets,
    minRequests: o.minRequests ?? m.minRequests,
  }

  const to = alignBucket(now() - m.ingestLagSeconds, m.bucketSeconds)
  const from = to - opts.weeks * 7 * 24 * 3600

  // One read for the whole window, then evaluate in memory. Querying per
  // bucket would be thousands of round trips over the same rows.
  const history = loadMetricHistory(opts.sqlite, m.id, "cf_requests", to)
  const byTs = new Map(history.map((p) => [p.bucketTs, p.value]))
  const evaluable = history.filter((p) => p.bucketTs >= from)

  // `gatherBaseline` scans everything it is handed. Called once per tick by
  // the worker that is free; called once per bucket across six weeks it is
  // O(n²) — 12k buckets over 12k points is ~144M comparisons, which took ~20s.
  //
  // Handing it only the points it could possibly select gives an identical
  // result (it applies the same predicate to a superset) for a fraction of
  // the work.
  const candidatesFor = makeCandidateSelector(byTs, m)

  const snapshots = loadSnapshots(opts.sqlite, m.id, from, to)

  const hits: BacktestHit[] = []
  const recent: TrafficAnomaly[] = []
  let bucketsEvaluated = 0
  let bucketsWithoutBaseline = 0

  for (const point of evaluable) {
    const baseline = gatherBaseline(point.bucketTs, candidatesFor(point.bucketTs), {
      bucketSeconds: m.bucketSeconds,
      baselineWeeks: m.baselineWeeks,
      minSamples: m.minSamples,
    })
    if (baseline.source === "insufficient") {
      bucketsWithoutBaseline += 1
      continue
    }
    bucketsEvaluated += 1

    const traffic = evaluateTraffic(point.value, baseline.samples, {
      spikeZ: params.spikeZ,
      minBaseline: params.minBaseline,
      minRelativeChange: params.minRelativeChange,
    })
    recent.push(traffic)
    if (recent.length > 10) recent.shift()

    // Only the transition counts as a hit. Counting every bucket of a
    // two-hour incident would report 24 alerts where an operator received
    // one — the engine's idempotency is what makes that true, and a
    // backtest that ignores it overstates the noise by an order of magnitude.
    const confirmed = confirmConsecutive(recent, params.consecutiveBuckets)
    const previouslyConfirmed = confirmConsecutive(
      recent.slice(0, -1),
      params.consecutiveBuckets,
    )
    if (confirmed && !previouslyConfirmed && traffic.direction !== null) {
      hits.push({
        bucketTs: point.bucketTs,
        kind: traffic.direction === "spike" ? "traffic:spike" : "traffic:drop",
        detail: `requests=${Math.round(point.value)}, median=${Math.round(traffic.median)}, z=${traffic.z.toFixed(2)}, Δrel=${(traffic.relativeChange * 100).toFixed(0)}%`,
      })
    }

    const snap = snapshots.get(point.bucketTs)
    if (snap) {
      const ddos = evaluateDDoS(
        {
          requests: point.value,
          requestsBaseline: baseline.samples,
          threatRequests: snap.threats,
          status5xx: snap.status5xx,
          status429: snap.status429,
          cacheMissRatio: point.value > 0 ? snap.cacheMiss / point.value : 0,
        },
        {
          spikeZ: params.spikeZ,
          threatRatioCrit: m.threatRatioCrit,
          threatRatioWarn: m.threatRatioWarn,
          errorRatio: m.errorRatio,
          minRequests: params.minRequests,
        },
      )
      if (ddos.severity !== null) {
        const prev = byTs.get(point.bucketTs - m.bucketSeconds)
        // Same transition-only logic, approximated: report the first bucket
        // of a run by checking whether the previous one also scored.
        const prevScored =
          prev !== undefined &&
          wasDDoS(prev, point, snapshots, m, params, candidatesFor)
        if (!prevScored) {
          hits.push({
            bucketTs: point.bucketTs,
            kind: "ddos",
            detail: `score=${ddos.score} (${ddos.severity}): ${ddos.signals.map((s) => s.name).join(", ")}`,
          })
        }
      }
    }
  }

  return {
    monitor: m.id,
    params,
    bucketsEvaluated,
    bucketsWithoutBaseline,
    from,
    to,
    hits,
  }
}

const WEEK_SECONDS = 7 * 24 * 3600
const ROLLING_HOURS = 3

/**
 * Builds the smallest set of points `gatherBaseline` could select for a given
 * target bucket: the weekly anchors within ±1 bucket, plus the rolling
 * fallback window. Mirrors `gatherBaseline`'s own predicate exactly — widen
 * one and the other must widen with it.
 */
function makeCandidateSelector(
  byTs: ReadonlyMap<number, number>,
  m: Monitor,
): (targetTs: number) => HistoricalPoint[] {
  const tolerance = m.bucketSeconds
  const rollingBuckets = Math.ceil((ROLLING_HOURS * 3600) / m.bucketSeconds)

  return (targetTs: number): HistoricalPoint[] => {
    const out: HistoricalPoint[] = []
    const push = (ts: number): void => {
      const value = byTs.get(ts)
      if (value !== undefined) out.push({ bucketTs: ts, value })
    }

    for (let k = 1; k <= m.baselineWeeks; k += 1) {
      const anchor = targetTs - k * WEEK_SECONDS
      // ±1 bucket of tolerance, on the aligned grid.
      for (let d = -tolerance; d <= tolerance; d += m.bucketSeconds) push(anchor + d)
    }
    for (let i = 1; i <= rollingBuckets; i += 1) {
      push(targetTs - i * m.bucketSeconds)
    }
    return out
  }
}

interface Snapshot {
  threats: number
  status5xx: number
  status429: number
  cacheMiss: number
}

function wasDDoS(
  prevValue: number,
  point: { bucketTs: number },
  snapshots: Map<number, Snapshot>,
  m: Monitor,
  params: Required<BacktestOverrides>,
  candidatesFor: (ts: number) => HistoricalPoint[],
): boolean {
  const prevTs = point.bucketTs - m.bucketSeconds
  const snap = snapshots.get(prevTs)
  if (!snap) return false
  const baseline = gatherBaseline(prevTs, candidatesFor(prevTs), {
    bucketSeconds: m.bucketSeconds,
    baselineWeeks: m.baselineWeeks,
    minSamples: m.minSamples,
  })
  if (baseline.source === "insufficient") return false
  return (
    evaluateDDoS(
      {
        requests: prevValue,
        requestsBaseline: baseline.samples,
        threatRequests: snap.threats,
        status5xx: snap.status5xx,
        status429: snap.status429,
        cacheMissRatio: prevValue > 0 ? snap.cacheMiss / prevValue : 0,
      },
      {
        spikeZ: params.spikeZ,
        threatRatioCrit: m.threatRatioCrit,
        threatRatioWarn: m.threatRatioWarn,
        errorRatio: m.errorRatio,
        minRequests: params.minRequests,
      },
    ).severity !== null
  )
}

function loadSnapshots(
  sqlite: Database,
  monitor: string,
  from: number,
  to: number,
): Map<number, Snapshot> {
  const rows = sqlite
    .prepare(
      `SELECT bucket_ts, metric, value FROM metrics
         WHERE monitor = ? AND source = 'cloudflare'
           AND metric IN ('cf_threats','cf_status_5xx','cf_status_429','cf_cache_miss')
           AND bucket_ts >= ? AND bucket_ts < ?`,
    )
    .all(monitor, from, to) as Array<{
    bucket_ts: number
    metric: string
    value: number
  }>

  const out = new Map<number, Snapshot>()
  for (const r of rows) {
    const s = out.get(r.bucket_ts) ?? {
      threats: 0,
      status5xx: 0,
      status429: 0,
      cacheMiss: 0,
    }
    if (r.metric === "cf_threats") s.threats = r.value
    else if (r.metric === "cf_status_5xx") s.status5xx = r.value
    else if (r.metric === "cf_status_429") s.status429 = r.value
    else if (r.metric === "cf_cache_miss") s.cacheMiss = r.value
    out.set(r.bucket_ts, s)
  }
  return out
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: readonly string[]): {
  weeks: number
  monitorId: string | null
  overrides: BacktestOverrides
  compare: { key: keyof BacktestOverrides; values: number[] } | null
} {
  const overrides: BacktestOverrides = {}
  let weeks = 4
  let monitorId: string | null = null
  let compare: { key: keyof BacktestOverrides; values: number[] } | null = null

  for (const arg of argv) {
    const m = /^--([a-zA-Z]+)=(.+)$/.exec(arg)
    if (!m) continue
    const [, key, raw] = m
    if (key === "weeks") weeks = Number(raw)
    else if (key === "monitor") monitorId = raw!
    else if (key === "compare") {
      const [k, list] = raw!.split(":")
      compare = {
        key: k as keyof BacktestOverrides,
        values: (list ?? "").split(",").map(Number).filter((n) => !Number.isNaN(n)),
      }
    } else if (
      ["spikeZ", "minBaseline", "minRelativeChange", "consecutiveBuckets", "minRequests"].includes(
        key!,
      )
    ) {
      overrides[key as keyof BacktestOverrides] = Number(raw)
    }
  }
  return { weeks, monitorId, overrides, compare }
}

function fmtTime(unixSec: number): string {
  const d = new Date((unixSec + 7 * 3600) * 1000)
  const dd = String(d.getUTCDate()).padStart(2, "0")
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0")
  const hh = String(d.getUTCHours()).padStart(2, "0")
  const mi = String(d.getUTCMinutes()).padStart(2, "0")
  return `${dd}/${mo} ${hh}:${mi}`
}

function printResult(r: BacktestResult, label?: string): void {
  const header = label ? `${r.monitor}  [${label}]` : r.monitor
  console.log("─".repeat(72))
  console.log(header)
  console.log(
    `  window:   ${fmtTime(r.from)} → ${fmtTime(r.to)} WIB  (${r.bucketsEvaluated} buckets judged, ${r.bucketsWithoutBaseline} skipped for thin baseline)`,
  )
  console.log(
    `  params:   spikeZ=${r.params.spikeZ}  minBaseline=${r.params.minBaseline}  minRelativeChange=${r.params.minRelativeChange}  consecutiveBuckets=${r.params.consecutiveBuckets}  minRequests=${r.params.minRequests}`,
  )
  console.log(`  would-be alerts: ${r.hits.length}`)
  for (const hit of r.hits.slice(0, 25)) {
    console.log(`    ${fmtTime(hit.bucketTs)}  ${hit.kind.padEnd(14)} ${hit.detail}`)
  }
  if (r.hits.length > 25) {
    console.log(`    … and ${r.hits.length - 25} more (not shown)`)
  }
}

async function main(): Promise<void> {
  const { weeks, monitorId, overrides, compare } = parseArgs(process.argv.slice(2))
  const { sqlite } = openDb()
  const config = loadMonitors()
  let monitors = monitorId
    ? config.monitors.filter((m) => m.id === monitorId)
    : config.monitors
  let usingDefaults = false

  // A monitor id can exist in the metrics table without being in
  // monitors.json — `db:seed` writes `seed-demo`, and a monitor removed from
  // config leaves its history behind. Backtesting those is exactly as useful,
  // so fall back to schema defaults and say so rather than refusing.
  if (monitorId && monitors.length === 0) {
    const known = sqlite
      .prepare("SELECT 1 FROM metrics WHERE monitor = ? LIMIT 1")
      .get(monitorId)
    if (known) {
      monitors = [monitorDefaults(monitorId)]
      usingDefaults = true
    }
  }

  if (monitors.length === 0) {
    console.error(
      `No monitor matched "${monitorId ?? "(any)"}" — not in monitors.json and no metrics stored for it.`,
    )
    process.exit(1)
  }

  console.log("")
  console.log("Night Watch — detector backtest (read-only, no alerts raised)")
  if (usingDefaults) {
    console.log(
      `Note: "${monitorId}" is not in monitors.json — using schema defaults for its thresholds.`,
    )
  }

  for (const monitor of monitors) {
    if (compare) {
      for (const value of compare.values) {
        printResult(
          backtest({
            sqlite,
            monitor,
            weeks,
            overrides: { ...overrides, [compare.key]: value },
          }),
          `${compare.key}=${value}`,
        )
      }
    } else {
      printResult(backtest({ sqlite, monitor, weeks, overrides }))
    }
  }
  console.log("─".repeat(72))
  console.log("")
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
