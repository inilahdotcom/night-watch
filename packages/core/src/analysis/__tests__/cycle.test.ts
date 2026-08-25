import { Database } from "bun:sqlite";
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
import { applyAllMigrations } from "../../db/schema-sql.ts";

function newDb() {
  const sqlite = new Database(":memory:");
  applyAllMigrations(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

class Capture implements NotificationChannel {
  readonly name = "push" as const;
  readonly mutedByQuietHours = false;
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
    forbidText: [],
    baselines: {},
    certWarnDays: 14,
    certCritDays: 3,
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

describe("runAnalysisCycle — TLS certificate", () => {
  function seedCert(sqlite: Database, monitorId: string, daysLeft: number, bucketTs: number): void {
    sqlite
      .prepare(
        "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(monitor, source, metric, bucket_ts) DO UPDATE SET value = excluded.value",
      )
      .run(monitorId, "probe", "tls_days_left", bucketTs, daysLeft);
  }

  it("stays silent on a healthy certificate", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor();
    seedCert(sqlite, monitor.id, 60, NOW - 600);

    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toEqual([]);
    expect(push.sends).toEqual([]);
  });

  it("warns inside certWarnDays and escalates to critical inside certCritDays", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor();

    seedCert(sqlite, monitor.id, 10, NOW - 600);
    let report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toContainEqual({
      fingerprint: `${monitor.id}:cert`,
      action: "created",
    });
    expect(push.sends[0]!.severity).toBe("warning");

    // Same fingerprint, now urgent — the engine must escalate rather than
    // open a second row.
    seedCert(sqlite, monitor.id, 2, NOW - 300);
    report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toContainEqual({
      fingerprint: `${monitor.id}:cert`,
      action: "escalated",
    });
    expect(push.sends[1]!.severity).toBe("critical");

    const firing = sqlite
      .prepare("SELECT count(*) AS n FROM alerts WHERE fingerprint = ? AND status = 'firing'")
      .get(`${monitor.id}:cert`) as { n: number };
    expect(firing.n).toBe(1);
  });

  it("treats an already-expired certificate as critical", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor();
    seedCert(sqlite, monitor.id, -3, NOW - 600);

    await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(push.sends[0]!.severity).toBe("critical");
    expect(push.sends[0]!.textBody).toContain("expired 3 days ago");
  });

  it("resolves once the certificate is renewed", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor();

    seedCert(sqlite, monitor.id, 1, NOW - 600);
    await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });

    seedCert(sqlite, monitor.id, 89, NOW - 300);
    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toContainEqual({
      fingerprint: `${monitor.id}:cert`,
      action: "resolved",
    });
    expect(push.sends.at(-1)!.status).toBe("resolved");
  });

  it("still evaluates the certificate for a monitor with no Cloudflare data", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor({ cloudflareZoneId: undefined });
    seedCert(sqlite, monitor.id, 1, NOW - 600);

    // No CF metrics at all: the cycle short-circuits after this point, so the
    // cert alert only fires if it is evaluated *before* that early return.
    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.skipReason).toContain("no cloudflare metrics");
    expect(push.sends).toHaveLength(1);
    expect(push.sends[0]!.severity).toBe("critical");
  });
});

describe("runAnalysisCycle — content integrity", () => {
  function seedProbeContent(
    sqlite: Database,
    monitorId: string,
    args: { bodyBytes: number; forbidHits?: string[] },
  ): void {
    sqlite
      .prepare(
        `INSERT INTO probe_state
           (monitor, consecutive_fail, consecutive_ok, is_down, last_check_at, last_status, last_latency_ms, last_error, last_body_bytes, last_forbid_hits)
         VALUES (?, 0, 1, 0, ?, 200, 120, NULL, ?, ?)
         ON CONFLICT(monitor) DO UPDATE SET
           last_body_bytes = excluded.last_body_bytes,
           last_forbid_hits = excluded.last_forbid_hits`,
      )
      .run(
        monitorId,
        NOW,
        args.bodyBytes,
        JSON.stringify(args.forbidHits ?? []),
      );
  }

  function seedSizeHistory(
    sqlite: Database,
    monitorId: string,
    endTs: number,
    bucketSeconds: number,
    count: number,
    bytes: number,
  ): void {
    const stmt = sqlite.prepare(
      "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 1; i <= count; i += 1) {
      // Small jitter so MAD is non-zero, as it would be in reality.
      stmt.run(monitorId, "probe", "body_bytes", endTs - i * bucketSeconds, bytes + (i % 3) * 200);
    }
  }

  it("raises critical the moment a blocked term appears, even on a healthy page", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor({ forbidText: ["slot gacor"] });
    const evalTs = Math.floor((NOW - monitor.ingestLagSeconds - monitor.bucketSeconds) / monitor.bucketSeconds) * monitor.bucketSeconds;
    seedSizeHistory(sqlite, monitor.id, evalTs, monitor.bucketSeconds, 20, 100_000);
    seedProbeContent(sqlite, monitor.id, { bodyBytes: 100_100, forbidHits: ["slot gacor"] });

    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toContainEqual({
      fingerprint: `${monitor.id}:content:forbidden`,
      action: "created",
    });
    const sent = push.sends.find((a) => a.type === "content")!;
    expect(sent.severity).toBe("critical");
    expect(sent.textBody).toContain("slot gacor");
  });

  it("resolves once the injected term is gone", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor({ forbidText: ["slot gacor"] });
    seedProbeContent(sqlite, monitor.id, { bodyBytes: 100_100, forbidHits: ["slot gacor"] });
    await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });

    seedProbeContent(sqlite, monitor.id, { bodyBytes: 100_100, forbidHits: [] });
    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toContainEqual({
      fingerprint: `${monitor.id}:content:forbidden`,
      action: "resolved",
    });
    expect(push.sends.at(-1)!.status).toBe("resolved");
  });

  it("warns when the page collapses, and does not fire on ordinary variation", async () => {
    const { sqlite, engine } = newEngineHarness();
    const monitor = baseMonitor();
    const evalTs = Math.floor((NOW - monitor.ingestLagSeconds - monitor.bucketSeconds) / monitor.bucketSeconds) * monitor.bucketSeconds;
    seedSizeHistory(sqlite, monitor.id, evalTs, monitor.bucketSeconds, 20, 100_000);

    // 3% off: statistically extreme against this baseline, operationally fine.
    seedProbeContent(sqlite, monitor.id, { bodyBytes: 103_000 });
    let report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions.map((a) => a.fingerprint)).not.toContain(`${monitor.id}:content:size`);

    // Blank page that still answers 200.
    seedProbeContent(sqlite, monitor.id, { bodyBytes: 300 });
    report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toContainEqual({
      fingerprint: `${monitor.id}:content:size`,
      action: "created",
    });
  });

  it("stays silent for a monitor with no body reading at all", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor();
    seedProbeState(sqlite, monitor.id, false);

    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions.map((a) => a.fingerprint)).not.toContain(`${monitor.id}:content:size`);
    expect(push.sends).toEqual([]);
  });

  it("survives a corrupt forbid-hits value instead of taking the cycle down", async () => {
    const { sqlite, engine } = newEngineHarness();
    const monitor = baseMonitor({ forbidText: ["slot"] });
    seedProbeContent(sqlite, monitor.id, { bodyBytes: 100_000 });
    sqlite
      .prepare("UPDATE probe_state SET last_forbid_hits = ? WHERE monitor = ?")
      .run("{not json", monitor.id);

    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions.map((a) => a.fingerprint)).not.toContain(`${monitor.id}:content:forbidden`);
  });
});

describe("runAnalysisCycle — extra baselined metrics", () => {
  function seedMetric(
    sqlite: Database,
    monitorId: string,
    metric: string,
    endTs: number,
    bucketSeconds: number,
    count: number,
    value: number,
  ): void {
    const stmt = sqlite.prepare(
      "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(monitor, source, metric, bucket_ts) DO UPDATE SET value = excluded.value",
    );
    for (let i = 1; i <= count; i += 1) {
      // Weekly anchors so the seasonal path has something to find, plus
      // jitter so MAD is non-zero.
      stmt.run(monitorId, "probe", metric, endTs - i * bucketSeconds, value + (i % 3));
    }
  }

  function evalTsFor(monitor: Monitor): number {
    return (
      Math.floor(
        (NOW - monitor.ingestLagSeconds - monitor.bucketSeconds) /
          monitor.bucketSeconds,
      ) * monitor.bucketSeconds
    );
  }

  function setCurrent(
    sqlite: Database,
    monitorId: string,
    metric: string,
    ts: number,
    value: number,
  ): void {
    sqlite
      .prepare(
        "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(monitor, source, metric, bucket_ts) DO UPDATE SET value = excluded.value",
      )
      .run(monitorId, "probe", metric, ts, value);
  }

  it("stays completely silent when no baselines are configured", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor(); // baselines: {}
    const evalTs = evalTsFor(monitor);
    seedMetric(sqlite, monitor.id, "ga_active_users", evalTs, monitor.bucketSeconds, 30, 500);
    setCurrent(sqlite, monitor.id, "ga_active_users", evalTs, 5); // catastrophic drop

    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toEqual([]);
    expect(push.sends).toEqual([]);
  });

  it("alerts on a GA4 active-users collapse once configured", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor({
      baselines: {
        ga_active_users: {
          enabled: true,
          direction: "drop",
          severity: "critical",
          consecutiveBuckets: 1,
        },
      },
    });
    const evalTs = evalTsFor(monitor);
    seedMetric(sqlite, monitor.id, "ga_active_users", evalTs, monitor.bucketSeconds, 30, 500);
    setCurrent(sqlite, monitor.id, "ga_active_users", evalTs, 5);

    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toContainEqual({
      fingerprint: `${monitor.id}:baseline:ga_active_users`,
      action: "created",
    });
    const sent = push.sends.at(-1)!;
    expect(sent.severity).toBe("critical");
    // Reads as English, not as a column name.
    expect(sent.textBody).toContain("active users drop");
  });

  it("ignores a GA4 spike when only drops are wanted", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor({
      baselines: {
        ga_active_users: {
          enabled: true,
          direction: "drop",
          severity: "warning",
          consecutiveBuckets: 1,
        },
      },
    });
    const evalTs = evalTsFor(monitor);
    seedMetric(sqlite, monitor.id, "ga_active_users", evalTs, monitor.bucketSeconds, 30, 500);
    setCurrent(sqlite, monitor.id, "ga_active_users", evalTs, 5000); // going viral

    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions.map((a) => a.fingerprint)).not.toContain(
      `${monitor.id}:baseline:ga_active_users`,
    );
    expect(push.sends).toEqual([]);
  });

  it("alerts on a latency rise and files it as a latency alert", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor({
      baselines: {
        latency_ms: {
          enabled: true,
          direction: "spike",
          severity: "warning",
          consecutiveBuckets: 1,
        },
      },
    });
    const evalTs = evalTsFor(monitor);
    seedMetric(sqlite, monitor.id, "latency_ms", evalTs, monitor.bucketSeconds, 30, 200);
    // 1200ms: far below the flat 3000ms slowResponseMs threshold, so the
    // existing latency check stays silent — this is the gap being closed.
    setCurrent(sqlite, monitor.id, "latency_ms", evalTs, 1200);

    await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    const sent = push.sends.at(-1)!;
    expect(sent.type).toBe("latency");
    expect(sent.textBody).toContain("latency spike");
  });

  it("respects `enabled: false`", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor({
      baselines: {
        ga_active_users: {
          enabled: false,
          direction: "both",
          severity: "warning",
        },
      },
    });
    const evalTs = evalTsFor(monitor);
    seedMetric(sqlite, monitor.id, "ga_active_users", evalTs, monitor.bucketSeconds, 30, 500);
    setCurrent(sqlite, monitor.id, "ga_active_users", evalTs, 5);

    await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(push.sends).toEqual([]);
  });

  it("survives state written before recentByMetric existed", async () => {
    const { sqlite, engine } = newEngineHarness();
    const monitor = baseMonitor({
      baselines: {
        ga_active_users: {
          enabled: true,
          direction: "drop",
          severity: "warning",
          consecutiveBuckets: 1,
        },
      },
    });
    // Exactly the shape a worker running the previous version left behind.
    sqlite
      .prepare(
        "INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)",
      )
      .run(
        `analysis:${monitor.id}`,
        JSON.stringify({ recentTraffic: [], cleanDDoSStreak: 0, cleanSlowStreak: 0 }),
        NOW,
      );

    const evalTs = evalTsFor(monitor);
    seedMetric(sqlite, monitor.id, "ga_active_users", evalTs, monitor.bucketSeconds, 30, 500);
    setCurrent(sqlite, monitor.id, "ga_active_users", evalTs, 5);

    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toContainEqual({
      fingerprint: `${monitor.id}:baseline:ga_active_users`,
      action: "created",
    });
  });

  it("resolves once the metric returns to normal", async () => {
    const { sqlite, engine, push } = newEngineHarness();
    const monitor = baseMonitor({
      baselines: {
        ga_active_users: {
          enabled: true,
          direction: "drop",
          severity: "warning",
          consecutiveBuckets: 1,
        },
      },
    });
    const evalTs = evalTsFor(monitor);
    seedMetric(sqlite, monitor.id, "ga_active_users", evalTs, monitor.bucketSeconds, 30, 500);
    setCurrent(sqlite, monitor.id, "ga_active_users", evalTs, 5);
    await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });

    setCurrent(sqlite, monitor.id, "ga_active_users", evalTs, 500);
    const report = await runAnalysisCycle({ monitor, engine, sqlite, now: () => NOW });
    expect(report.actions).toContainEqual({
      fingerprint: `${monitor.id}:baseline:ga_active_users`,
      action: "resolved",
    });
    expect(push.sends.at(-1)!.status).toBe("resolved");
  });
});
