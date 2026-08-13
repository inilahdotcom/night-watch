import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import * as schema from "../../db/schema.ts";
import { createAlertEngine } from "../../alerts/engine.ts";
import type {
  DeliveryResult,
  NotificationChannel,
  RenderedAlert,
} from "../../alerts/types.ts";
import type { Monitor } from "../../config/monitors.ts";
import type { MetricRow } from "../../seed/generate.ts";
import { runAnalysisCycle } from "../cycle.ts";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "migrations",
);

function newDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, "0000_init.sql"), "utf8"));
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

class Capture implements NotificationChannel {
  readonly name = "push" as const;
  sends: RenderedAlert[] = [];
  isReady(): boolean {
    return true;
  }
  async send(a: RenderedAlert): Promise<DeliveryResult> {
    this.sends.push(a);
    return { ok: true, detail: "ok" };
  }
}

function baseMonitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: "test",
    url: "https://example.test",
    expectStatusBelow: 400,
    probeIntervalSeconds: 60,
    probeTimeoutMs: 10_000,
    slowResponseMs: 3_000,
    failThreshold: 3,
    recoverThreshold: 2,
    bucketSeconds: 300,
    baselineWeeks: 4,
    minSamples: 6,
    spikeZ: 3.5,
    minBaseline: 50,
    minRelativeChange: 0.4,
    consecutiveBuckets: 2,
    minRequests: 300,
    ingestLagSeconds: 240,
    threatRatioCrit: 0.35,
    threatRatioWarn: 0.15,
    errorRatio: 0.1,
    maintenanceWindows: [],
    ...overrides,
  };
}

// Insert `count` prior buckets ending at `endTs`, each with the same value —
// gives the detector a stable baseline.
function seedCloudflare(
  sqlite: Database,
  monitorId: string,
  endTs: number,
  bucketSeconds: number,
  count: number,
  values: { requests: number; threats?: number; status5xx?: number; status429?: number; cacheMiss?: number },
): void {
  const rows: MetricRow[] = [];
  for (let i = 1; i <= count; i += 1) {
    const bucketTs = endTs - i * bucketSeconds;
    rows.push({ monitor: monitorId, source: "cloudflare", metric: "cf_requests", bucketTs, value: values.requests });
    rows.push({ monitor: monitorId, source: "cloudflare", metric: "cf_threats", bucketTs, value: values.threats ?? 0 });
    rows.push({ monitor: monitorId, source: "cloudflare", metric: "cf_status_5xx", bucketTs, value: values.status5xx ?? 0 });
    rows.push({ monitor: monitorId, source: "cloudflare", metric: "cf_status_429", bucketTs, value: values.status429 ?? 0 });
    rows.push({ monitor: monitorId, source: "cloudflare", metric: "cf_cache_miss", bucketTs, value: values.cacheMiss ?? Math.round(values.requests * 0.1) });
  }
  const stmt = sqlite.prepare(
    "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
  );
  for (const r of rows) stmt.run(r.monitor, r.source, r.metric, r.bucketTs, r.value);
}

// Write the "current" bucket (the one runAnalysisCycle will evaluate).
function seedCurrentBucket(
  sqlite: Database,
  monitorId: string,
  currentTs: number,
  values: { requests: number; threats?: number; status5xx?: number; status429?: number; cacheMiss?: number },
): void {
  const stmt = sqlite.prepare(
    "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
  );
  stmt.run(monitorId, "cloudflare", "cf_requests", currentTs, values.requests);
  stmt.run(monitorId, "cloudflare", "cf_threats", currentTs, values.threats ?? 0);
  stmt.run(monitorId, "cloudflare", "cf_status_5xx", currentTs, values.status5xx ?? 0);
  stmt.run(monitorId, "cloudflare", "cf_status_429", currentTs, values.status429 ?? 0);
  stmt.run(monitorId, "cloudflare", "cf_cache_miss", currentTs, values.cacheMiss ?? Math.round(values.requests * 0.1));
}

function seedProbeState(
  sqlite: Database,
  monitorId: string,
  isDown: boolean,
  latencyMs = 100,
  error: string | null = null,
): void {
  sqlite
    .prepare(
      `INSERT INTO probe_state (monitor, consecutive_fail, consecutive_ok, is_down, last_check_at, last_status, last_latency_ms, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(monitor) DO UPDATE SET
         is_down = excluded.is_down,
         last_status = excluded.last_status,
         last_latency_ms = excluded.last_latency_ms,
         last_error = excluded.last_error`,
    )
    .run(monitorId, isDown ? 3 : 0, isDown ? 0 : 3, isDown ? 1 : 0, 1000, isDown ? null : 200, latencyMs, error);
}

// Anchor at a stable NOW. evalTs = align(now - lag - bucket) — a full bucket back.
const NOW = 2_000_000_000;

function newEngineHarness() {
  const { sqlite, db } = newDb();
  const push = new Capture();
  const engine = createAlertEngine({
    db,
    sqlite,
    channels: [push],
    cooldownMinutes: 15,
    notifyOnResolve: true,
    quietHours: null,
    utcOffsetHours: 7,
    now: () => NOW,
  });
  return { sqlite, db, push, engine };
}

beforeEach(() => {
  // no globals to reset; harness is per-test
});

describe("runAnalysisCycle — quiet baseline stays silent", () => {
  it("emits no traffic or ddos alerts when current bucket sits on baseline", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor();
    // History with stable value; current bucket matches.
    const evalTs = Math.floor((NOW - monitor.ingestLagSeconds - monitor.bucketSeconds) / monitor.bucketSeconds) * monitor.bucketSeconds;
    seedCloudflare(sqlite, monitor.id, evalTs, monitor.bucketSeconds, 20, { requests: 1000 });
    seedCurrentBucket(sqlite, monitor.id, evalTs, { requests: 1020 });

    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toEqual([]);
    expect(push.sends).toEqual([]);
  });
});

describe("runAnalysisCycle — traffic spike raises then resolves", () => {
  it("raises traffic:spike after the second confirming bucket, resolves once quiet", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor();

    const evalTs = Math.floor((NOW - monitor.ingestLagSeconds - monitor.bucketSeconds) / monitor.bucketSeconds) * monitor.bucketSeconds;
    seedCloudflare(sqlite, monitor.id, evalTs, monitor.bucketSeconds, 20, { requests: 1000 });

    // Fire cycle #1 with an anomalous current bucket. Traffic detector's
    // consecutive gate should hold — no traffic:spike alert on a single bucket.
    // (Volume-only DDoS may still fire at 2×spikeZ; the brief accepts that.)
    seedCurrentBucket(sqlite, monitor.id, evalTs, { requests: 4000 });
    const r1 = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    const trafficR1 = r1.actions.filter((a) => a.fingerprint.startsWith(`${monitor.id}:traffic`));
    expect(trafficR1).toEqual([]);

    // Simulate cycle #2 — advance to next bucket, also anomalous.
    const nextEval = evalTs + monitor.bucketSeconds;
    const nextNow = NOW + monitor.bucketSeconds;
    // The new current bucket is `nextEval`. `evalTs` becomes history.
    seedCurrentBucket(sqlite, monitor.id, nextEval, { requests: 4200 });
    const r2 = await runAnalysisCycle({ monitor, engine, sqlite, now: () => nextNow });
    expect(r2.actions.some((a) => a.fingerprint === `${monitor.id}:traffic:spike`)).toBe(true);
    expect(push.sends.some((s) => s.type === "traffic")).toBe(true);

    // Cycle #3 — back to normal. Traffic detector now reports `triggered=false`,
    // so the engine calls resolveAlert.
    const cleanEval = nextEval + monitor.bucketSeconds;
    const cleanNow = nextNow + monitor.bucketSeconds;
    seedCurrentBucket(sqlite, monitor.id, cleanEval, { requests: 1000 });
    const r3 = await runAnalysisCycle({ monitor, engine, sqlite, now: () => cleanNow });
    const resolved = r3.actions.find((a) => a.fingerprint === `${monitor.id}:traffic:spike`);
    expect(resolved?.action).toBe("resolved");
  });
});

describe("runAnalysisCycle — DDoS", () => {
  it("raises critical on attack pattern, requires 3 clean cycles to resolve", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor();

    const evalTs = Math.floor((NOW - monitor.ingestLagSeconds - monitor.bucketSeconds) / monitor.bucketSeconds) * monitor.bucketSeconds;
    seedCloudflare(sqlite, monitor.id, evalTs, monitor.bucketSeconds, 20, { requests: 1000 });

    // Attack shape: high volume + heavy firewall + 5xx + cache miss.
    seedCurrentBucket(sqlite, monitor.id, evalTs, {
      requests: 5000,
      threats: 2000, // 40%
      status5xx: 600, // 12%
      status429: 300, // 6%
      cacheMiss: 4500, // 90%
    });
    const r1 = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    const ddos = r1.actions.find((a) => a.fingerprint === `${monitor.id}:ddos`);
    expect(ddos?.action).toBe("created");
    const ddosSend = push.sends.find((s) => s.type === "ddos");
    expect(ddosSend?.severity).toBe("critical");

    // Two clean cycles — should not resolve yet.
    let cycleNow = NOW;
    let cycleEval = evalTs;
    for (let i = 0; i < 2; i += 1) {
      cycleNow += monitor.bucketSeconds;
      cycleEval += monitor.bucketSeconds;
      seedCurrentBucket(sqlite, monitor.id, cycleEval, { requests: 1000 });
      const r = await runAnalysisCycle({ monitor, engine, sqlite, now: () => cycleNow });
      const ddosAction = r.actions.find((a) => a.fingerprint === `${monitor.id}:ddos`);
      expect(ddosAction).toBeUndefined();
    }

    // Third clean cycle — now resolve.
    cycleNow += monitor.bucketSeconds;
    cycleEval += monitor.bucketSeconds;
    seedCurrentBucket(sqlite, monitor.id, cycleEval, { requests: 1000 });
    const rFinal = await runAnalysisCycle({ monitor, engine, sqlite, now: () => cycleNow });
    const ddosAction = rFinal.actions.find((a) => a.fingerprint === `${monitor.id}:ddos`);
    expect(ddosAction?.action).toBe("resolved");
  });
});

describe("runAnalysisCycle — uptime", () => {
  it("raises uptime critical when probe_state.is_down = 1", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor();
    seedProbeState(sqlite, monitor.id, true, 0, "timeout");

    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    const uptime = report.actions.find((a) => a.fingerprint === `${monitor.id}:uptime`);
    expect(uptime?.action).toBe("created");
    const send = push.sends.find((s) => s.type === "uptime");
    expect(send?.severity).toBe("critical");
    expect(send?.body).toMatch(/DOWN|Probe failing/);
  });

  it("resolves uptime alert when probe_state.is_down flips to 0", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor();
    seedProbeState(sqlite, monitor.id, true, 0, "timeout");
    await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    push.sends.length = 0;

    seedProbeState(sqlite, monitor.id, false, 150, null);
    const r = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW + 60 });
    const uptime = r.actions.find((a) => a.fingerprint === `${monitor.id}:uptime`);
    expect(uptime?.action).toBe("resolved");
    expect(push.sends.some((s) => s.status === "resolved")).toBe(true);
  });

  it("raises slow warning when latency exceeds slowResponseMs but up", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor({ slowResponseMs: 500 });
    seedProbeState(sqlite, monitor.id, false, 800, null);
    const r = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    const slow = r.actions.find((a) => a.fingerprint === `${monitor.id}:slow`);
    expect(slow?.action).toBe("created");
    expect(push.sends.some((s) => s.type === "latency")).toBe(true);
  });
});
