import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { applyAllMigrations } from "../../db/schema-sql.ts"
import { monitorDefaults, type Monitor } from "../../config/monitors.ts"
import { backtest } from "../backtest.ts"

const NOW = 2_000_000_000
const BUCKET = 300

function newDb(): Database {
  const sqlite = new Database(":memory:")
  applyAllMigrations(sqlite)
  return sqlite
}

function monitor(overrides: Partial<Monitor> = {}): Monitor {
  return { ...monitorDefaults("bt", "https://bt.test"), ...overrides }
}

/**
 * Writes `weeks` of steady request history, then overrides specific buckets.
 * Steady enough that the seasonal baseline is well-formed and anything the
 * test plants is unambiguous.
 */
function seed(
  sqlite: Database,
  opts: { weeks: number; base: number; spikes?: Map<number, number> },
): void {
  const stmt = sqlite.prepare(
    "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, 'cloudflare', 'cf_requests', ?, ?) " +
      "ON CONFLICT(monitor, source, metric, bucket_ts) DO UPDATE SET value = excluded.value",
  )
  const buckets = (opts.weeks * 7 * 24 * 3600) / BUCKET
  const end = Math.floor(NOW / BUCKET) * BUCKET
  const tx = sqlite.transaction(() => {
    for (let i = 0; i < buckets; i += 1) {
      const ts = end - i * BUCKET
      // Tiny deterministic jitter so MAD is non-zero, as real data is.
      const value = opts.spikes?.get(ts) ?? opts.base + (i % 5)
      stmt.run("bt", ts, value)
    }
  })
  tx()
}

describe("backtest", () => {
  it("reports nothing on steady traffic", () => {
    const sqlite = newDb()
    seed(sqlite, { weeks: 6, base: 1000 })

    const r = backtest({ sqlite, monitor: monitor(), weeks: 4, now: () => NOW })
    expect(r.hits).toEqual([])
    expect(r.bucketsEvaluated).toBeGreaterThan(1000)
  })

  it("finds a planted spike that persists long enough to confirm", () => {
    const sqlite = newDb()
    const end = Math.floor(NOW / BUCKET) * BUCKET
    const spikeAt = end - 20 * BUCKET
    const spikes = new Map([
      [spikeAt, 9000],
      [spikeAt + BUCKET, 9000],
      [spikeAt + 2 * BUCKET, 9000],
    ])
    seed(sqlite, { weeks: 6, base: 1000, spikes })

    const r = backtest({ sqlite, monitor: monitor(), weeks: 4, now: () => NOW })
    expect(r.hits.length).toBeGreaterThan(0)
    expect(r.hits.every((h) => h.kind === "traffic:spike")).toBe(true)
  })

  it("reports one hit per incident, not one per bucket", () => {
    const sqlite = newDb()
    const end = Math.floor(NOW / BUCKET) * BUCKET
    const start = end - 40 * BUCKET
    // A two-hour incident: 24 consecutive elevated buckets.
    const spikes = new Map<number, number>()
    for (let i = 0; i < 24; i += 1) spikes.set(start + i * BUCKET, 9000)
    seed(sqlite, { weeks: 6, base: 1000, spikes })

    const r = backtest({ sqlite, monitor: monitor(), weeks: 4, now: () => NOW })
    const trafficHits = r.hits.filter((h) => h.kind.startsWith("traffic"))
    // The engine's idempotency means an operator gets one message for this.
    // A backtest counting all 24 would overstate the noise ~20x.
    expect(trafficHits).toHaveLength(1)
  })

  it("raising spikeZ produces no more alerts than lowering it", () => {
    const sqlite = newDb()
    const end = Math.floor(NOW / BUCKET) * BUCKET
    const spikes = new Map<number, number>()
    // A spread of deviations of differing magnitude.
    for (let i = 1; i <= 10; i += 1) {
      const at = end - i * 40 * BUCKET
      const magnitude = 1000 * (1 + i * 0.4)
      spikes.set(at, magnitude)
      spikes.set(at + BUCKET, magnitude)
      spikes.set(at + 2 * BUCKET, magnitude)
    }
    seed(sqlite, { weeks: 6, base: 1000, spikes })

    const loose = backtest({
      sqlite,
      monitor: monitor(),
      weeks: 4,
      overrides: { spikeZ: 2.5 },
      now: () => NOW,
    })
    const strict = backtest({
      sqlite,
      monitor: monitor(),
      weeks: 4,
      overrides: { spikeZ: 8 },
      now: () => NOW,
    })
    expect(strict.hits.length).toBeLessThanOrEqual(loose.hits.length)
  })

  it("echoes the effective parameters, including overrides", () => {
    const sqlite = newDb()
    seed(sqlite, { weeks: 6, base: 1000 })
    const r = backtest({
      sqlite,
      monitor: monitor(),
      weeks: 4,
      overrides: { spikeZ: 2.2, consecutiveBuckets: 5 },
      now: () => NOW,
    })
    expect(r.params.spikeZ).toBe(2.2)
    expect(r.params.consecutiveBuckets).toBe(5)
    // Untouched ones fall back to the monitor's own config.
    expect(r.params.minRelativeChange).toBe(monitor().minRelativeChange)
  })

  it("counts buckets it could not judge rather than silently skipping them", () => {
    const sqlite = newDb()
    // Only two days of history: far too little for a seasonal baseline, and
    // the rolling fallback only reaches back three hours.
    seed(sqlite, { weeks: 0.3, base: 1000 })
    const r = backtest({ sqlite, monitor: monitor(), weeks: 4, now: () => NOW })
    expect(r.bucketsWithoutBaseline).toBeGreaterThan(0)
  })

  it("writes nothing — it must be safe against a live database", () => {
    const sqlite = newDb()
    seed(sqlite, { weeks: 6, base: 1000 })
    const before = {
      alerts: (sqlite.prepare("SELECT count(*) AS n FROM alerts").get() as { n: number }).n,
      deliveries: (sqlite.prepare("SELECT count(*) AS n FROM deliveries").get() as { n: number }).n,
      state: (sqlite.prepare("SELECT count(*) AS n FROM system_state").get() as { n: number }).n,
    }

    backtest({ sqlite, monitor: monitor(), weeks: 4, now: () => NOW })

    expect(
      (sqlite.prepare("SELECT count(*) AS n FROM alerts").get() as { n: number }).n,
    ).toBe(before.alerts)
    expect(
      (sqlite.prepare("SELECT count(*) AS n FROM deliveries").get() as { n: number }).n,
    ).toBe(before.deliveries)
    expect(
      (sqlite.prepare("SELECT count(*) AS n FROM system_state").get() as { n: number }).n,
    ).toBe(before.state)
  })

  it("ignores other monitors' metrics", () => {
    const sqlite = newDb()
    seed(sqlite, { weeks: 6, base: 1000 })
    sqlite
      .prepare(
        "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES ('other', 'cloudflare', 'cf_requests', ?, ?)",
      )
      .run(Math.floor(NOW / BUCKET) * BUCKET - BUCKET, 999_999)

    const r = backtest({ sqlite, monitor: monitor(), weeks: 4, now: () => NOW })
    expect(r.hits).toEqual([])
  })
})
