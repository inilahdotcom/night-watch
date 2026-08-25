import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, expect, it } from "bun:test";
import * as schema from "../../db/schema.ts";
import { applyAllMigrations } from "../../db/schema-sql.ts";
import {
  getActiveAlerts,
  getAlertHistory,
  getMonitors,
  getPulse,
  getSeries,
  getStatus,
  getSystemHealth,
  getUptime,
} from "../queries.ts";

function newDb() {
  const sqlite = new Database(":memory:");
  applyAllMigrations(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

const NOW = Math.floor(Date.now() / 1000);

function insertAlert(
  sqlite: Database,
  args: {
    fp: string;
    monitor: string;
    type?: string;
    severity: string;
    status: "firing" | "resolved";
    startedAt?: number;
    resolvedAt?: number | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO alerts (fingerprint, monitor, type, severity, status, title, body, started_at, resolved_at, notify_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.fp,
      args.monitor,
      args.type ?? "traffic",
      args.severity,
      args.status,
      "t",
      "b",
      args.startedAt ?? NOW - 60,
      args.resolvedAt ?? null,
      1,
    );
}

function insertProbe(sqlite: Database, monitor: string, isDown: boolean): void {
  sqlite
    .prepare(
      `INSERT INTO probe_state (monitor, consecutive_fail, consecutive_ok, is_down, last_check_at, last_status, last_latency_ms)
         VALUES (?, 0, 0, ?, ?, 200, 100)`,
    )
    .run(monitor, isDown ? 1 : 0, NOW);
}

describe("getStatus", () => {
  it("returns ok when no monitors and no alerts (unknown)", () => {
    const { db } = newDb();
    const r = getStatus(db);
    expect(r.verdict).toBe("unknown");
    expect(r.monitorCount).toBe(0);
  });

  it("returns ok when monitors exist but no firing alerts", () => {
    const { sqlite, db } = newDb();
    insertProbe(sqlite, "m1", false);
    const r = getStatus(db);
    expect(r.verdict).toBe("ok");
    expect(r.monitorCount).toBe(1);
    expect(r.firingCount).toBe(0);
  });

  it("returns warning when 1 warning is firing", () => {
    const { sqlite, db } = newDb();
    insertProbe(sqlite, "m1", false);
    insertAlert(sqlite, { fp: "a", monitor: "m1", severity: "warning", status: "firing" });
    const r = getStatus(db);
    expect(r.verdict).toBe("warning");
    expect(r.firingCount).toBe(1);
    expect(r.criticalCount).toBe(0);
  });

  it("returns critical (regardless of warnings) when any critical is firing", () => {
    const { sqlite, db } = newDb();
    insertProbe(sqlite, "m1", false);
    insertAlert(sqlite, { fp: "a", monitor: "m1", severity: "critical", status: "firing" });
    insertAlert(sqlite, { fp: "b", monitor: "m1", severity: "warning", status: "firing" });
    const r = getStatus(db);
    expect(r.verdict).toBe("critical");
    expect(r.criticalCount).toBe(1);
    expect(r.firingCount).toBe(2);
  });
});

describe("getActiveAlerts", () => {
  it("returns firing rows only, newest first", () => {
    const { sqlite, db } = newDb();
    insertAlert(sqlite, {
      fp: "old",
      monitor: "m1",
      severity: "warning",
      status: "firing",
      startedAt: NOW - 3600,
    });
    insertAlert(sqlite, {
      fp: "new",
      monitor: "m1",
      severity: "critical",
      status: "firing",
      startedAt: NOW - 60,
    });
    insertAlert(sqlite, {
      fp: "closed",
      monitor: "m1",
      severity: "warning",
      status: "resolved",
      resolvedAt: NOW - 10,
    });
    const rows = getActiveAlerts(db);
    expect(rows.map((r) => r.fingerprint)).toEqual(["new", "old"]);
  });
});

describe("getAlertHistory", () => {
  it("returns both firing + resolved, respects limit", () => {
    const { sqlite, db } = newDb();
    for (let i = 0; i < 30; i += 1) {
      insertAlert(sqlite, {
        fp: `fp${i}`,
        monitor: "m1",
        severity: "warning",
        status: i % 2 === 0 ? "firing" : "resolved",
        startedAt: NOW - i * 60,
        resolvedAt: i % 2 === 0 ? null : NOW - i * 60 + 10,
      });
    }
    const rows = getAlertHistory(db, 10);
    expect(rows).toHaveLength(10);
    expect(rows[0]!.fingerprint).toBe("fp0"); // newest
  });
});

describe("getSeries", () => {
  it("filters by monitor/source/metric and orders by bucketTs", () => {
    const { sqlite, db } = newDb();
    const stmt = sqlite.prepare(
      "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 1; i <= 5; i += 1) {
      stmt.run("m1", "cloudflare", "cf_requests", NOW - i * 300, i * 10);
    }
    // Noise for another monitor + metric to confirm filtering
    stmt.run("m2", "cloudflare", "cf_requests", NOW - 300, 9999);
    stmt.run("m1", "cloudflare", "cf_bytes", NOW - 300, 8888);

    const rows = getSeries(db, {
      monitor: "m1",
      source: "cloudflare",
      metric: "cf_requests",
      hours: 1,
    });
    expect(rows).toHaveLength(5);
    // sorted ascending by bucketTs
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.bucketTs).toBeGreaterThan(rows[i - 1]!.bucketTs);
    }
  });

  it("respects the hours cutoff", () => {
    const { sqlite, db } = newDb();
    const stmt = sqlite.prepare(
      "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
    );
    stmt.run("m1", "cloudflare", "cf_requests", NOW - 30 * 3600, 1); // > 24h
    stmt.run("m1", "cloudflare", "cf_requests", NOW - 5 * 3600, 2); // within
    const rows = getSeries(db, {
      monitor: "m1",
      source: "cloudflare",
      metric: "cf_requests",
      hours: 24,
    });
    expect(rows.map((r) => r.value)).toEqual([2]);
  });
});

describe("getMonitors", () => {
  it("returns probe_state joined with any firing alerts", () => {
    const { sqlite, db } = newDb();
    insertProbe(sqlite, "m1", false);
    insertProbe(sqlite, "m2", true);
    insertAlert(sqlite, {
      fp: "a",
      monitor: "m2",
      severity: "critical",
      status: "firing",
      type: "uptime",
    });
    const rows = getMonitors(db);
    expect(rows.map((r) => r.id).sort()).toEqual(["m1", "m2"]);
    const m2 = rows.find((r) => r.id === "m2")!;
    expect(m2.isDown).toBe(true);
    expect(m2.currentAlerts).toEqual([{ type: "uptime", severity: "critical" }]);
    const m1 = rows.find((r) => r.id === "m1")!;
    expect(m1.currentAlerts).toEqual([]);
  });
});

describe("getSystemHealth", () => {
  it("reports waNeedsRelink true when system_state has that key", () => {
    const { sqlite, db } = newDb();
    sqlite
      .prepare(
        "INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)",
      )
      .run("wa:needs-relink", JSON.stringify({ reason: "device removed" }), NOW * 1000);
    const r = getSystemHealth(db, {
      vapidPublicKey: "pk",
      timezone: "Asia/Jakarta",
      quietHours: "22:00-07:00",
    });
    expect(r.waNeedsRelink).toBe(true);
    expect(r.waRelinkReason).toBe("device removed");
    expect(r.vapidPublicKey).toBe("pk");
  });

  it("reports waNeedsRelink false when no such row", () => {
    const { db } = newDb();
    const r = getSystemHealth(db, {
      vapidPublicKey: null,
      timezone: "UTC",
      quietHours: null,
    });
    expect(r.waNeedsRelink).toBe(false);
    expect(r.vapidPublicKey).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getPulse
// ---------------------------------------------------------------------------
//
// The reason this query exists: the dashboard used to decide "anomalous" on
// its own, colouring bars outside the P15-P85 of the *displayed window*. That
// rule is self-referential — 15% of bars are always under P15 and 15% always
// over P85 — so ~30% of every chart was coloured even on a perfectly steady
// monitor, and none of it lined up with the alerts the engine actually sent.
//
// The first test below pins that down by running both rules over the same
// steady data and asserting they disagree.

const PULSE_BUCKET = 300;
const PULSE_NOW = 1_759_999_800; // fixed, and divisible by PULSE_BUCKET

const PULSE_MONITOR = {
  id: "m1",
  bucketSeconds: PULSE_BUCKET,
  baselineWeeks: 4,
  minSamples: 6,
  spikeZ: 3.5,
  minBaseline: 50,
  minRelativeChange: 0.4,
  consecutiveBuckets: 2,
  ingestLagSeconds: 240,
  probeIntervalSeconds: 60,
  slowResponseMs: 3000,
  errorRatio: 0.1,
  threatRatioWarn: 0.15,
  threatRatioCrit: 0.35,
  minRequests: 300,
};

/** Steady traffic with deterministic jitter of about ±5% around 1000. */
function steadyValue(i: number): number {
  return 1000 + ((i * 37) % 100) - 50;
}

/** Writes `count` buckets of cf_requests ending at PULSE_NOW. */
function seedTraffic(
  sqlite: Database,
  count: number,
  value: (i: number, bucketTs: number) => number,
): void {
  const stmt = sqlite.prepare(
    "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < count; i += 1) {
    const bucketTs = PULSE_NOW - (count - 1 - i) * PULSE_BUCKET;
    stmt.run("m1", "cloudflare", "cf_requests", bucketTs, value(i, bucketTs));
  }
}

function colouredCount(states: string[]): number {
  return states.filter((s) => s === "deviating" || s === "confirmed").length;
}

/** The rule the old PulseBand used, reproduced so the two can be compared. */
function oldRuleColoured(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  const p15 = at(0.15);
  const p85 = at(0.85);
  return values.filter((v) => v < p15 || v > p85).length;
}

describe("getPulse", () => {
  it("colours nothing on steady traffic, where the old P15-P85 rule coloured ~30%", () => {
    const { sqlite, db } = newDb();
    seedTraffic(sqlite, 200, steadyValue);

    const pulse = getPulse(db, sqlite, PULSE_MONITOR, {
      hours: 6,
      now: PULSE_NOW,
    });
    const judged = pulse.buckets.filter((b) => b.state !== "unevaluated");
    expect(judged.length).toBeGreaterThan(50);
    expect(colouredCount(judged.map((b) => b.state))).toBe(0);

    // Same data, old rule: a large fraction of bars would have been coloured.
    const old = oldRuleColoured(judged.map((b) => b.value));
    expect(old / judged.length).toBeGreaterThan(0.2);
  });

  it("confirms a spike only once it persists for consecutiveBuckets", () => {
    const { sqlite, db } = newDb();
    // Two sustained 5x buckets, placed well behind the analysis lag.
    const spikeFrom = 200 - 1 - 5;
    seedTraffic(sqlite, 200, (i) =>
      i >= spikeFrom && i < spikeFrom + 2 ? 5000 : steadyValue(i),
    );

    const pulse = getPulse(db, sqlite, PULSE_MONITOR, {
      hours: 6,
      now: PULSE_NOW,
    });
    const confirmed = pulse.buckets.filter((b) => b.state === "confirmed");
    expect(confirmed).toHaveLength(2);
    expect(confirmed.every((b) => b.value === 5000)).toBe(true);
    // Everything else stayed calm.
    expect(
      pulse.buckets.filter((b) => b.state === "deviating"),
    ).toHaveLength(0);
  });

  it("never judges buckets newer than the analysis lag", () => {
    const { sqlite, db } = newDb();
    seedTraffic(sqlite, 200, steadyValue);

    const pulse = getPulse(db, sqlite, PULSE_MONITOR, {
      hours: 6,
      now: PULSE_NOW,
    });
    const unevaluated = pulse.buckets.filter((b) => b.state === "unevaluated");
    // ingestLag 240s + one 300s bucket -> the newest 1-2 buckets.
    expect(unevaluated.length).toBeGreaterThan(0);
    expect(unevaluated.every((b) => b.expected === null)).toBe(true);
    expect(unevaluated.every((b) => b.bucketTs > PULSE_NOW - 900)).toBe(true);
  });

  it("reports below-floor rather than a band when the baseline is under minBaseline", () => {
    const { sqlite, db } = newDb();
    seedTraffic(sqlite, 200, (i) => 10 + (i % 3));

    const pulse = getPulse(db, sqlite, PULSE_MONITOR, {
      hours: 6,
      now: PULSE_NOW,
    });
    const judged = pulse.buckets.filter((b) => b.state !== "unevaluated");
    expect(judged.every((b) => b.state === "below-floor")).toBe(true);
    expect(colouredCount(judged.map((b) => b.state))).toBe(0);
  });

  it("says no-baseline instead of guessing when history is too short", () => {
    const { sqlite, db } = newDb();
    seedTraffic(sqlite, 3, steadyValue);

    const pulse = getPulse(db, sqlite, PULSE_MONITOR, {
      hours: 6,
      now: PULSE_NOW,
    });
    expect(pulse.baselineSource).toBe("insufficient");
    const judged = pulse.buckets.filter((b) => b.state !== "unevaluated");
    expect(judged.every((b) => b.state === "no-baseline")).toBe(true);
    expect(judged.every((b) => b.expected === null)).toBe(true);
  });

  it("carries the engine's own thresholds for the secondary signals", () => {
    const { sqlite, db } = newDb();
    seedTraffic(sqlite, 200, steadyValue);
    insertProbe(sqlite, "m1", false); // last_latency_ms = 100

    // Attach the ratios to the newest bucket the detectors will have judged,
    // derived the same way the query derives it.
    const lastEval =
      Math.floor((PULSE_NOW - 240 - PULSE_BUCKET) / PULSE_BUCKET) * PULSE_BUCKET;
    const stmt = sqlite.prepare(
      "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
    );
    // ~11.5% 5xx (over errorRatio 0.10) and ~19% threats (over warn, under crit).
    stmt.run("m1", "cloudflare", "cf_status_5xx", lastEval, 120);
    stmt.run("m1", "cloudflare", "cf_threats", lastEval, 200);

    const pulse = getPulse(db, sqlite, PULSE_MONITOR, {
      hours: 6,
      now: PULSE_NOW,
    });

    expect(pulse.latency.value).toBe(100);
    expect(pulse.latency.warn).toBe(3000);
    expect(pulse.latency.breached).toBe("none");

    expect(pulse.errors.warn).toBe(0.1);
    expect(pulse.errors.breached).toBe("warn");
    expect(pulse.errors.suppressed).toBe(false);

    expect(pulse.threats.warn).toBe(0.15);
    expect(pulse.threats.critical).toBe(0.35);
    expect(pulse.threats.breached).toBe("warn");
  });

  it("suppresses the ratio signals below minRequests", () => {
    const { sqlite, db } = newDb();
    seedTraffic(sqlite, 200, () => 100); // under minRequests 300

    const pulse = getPulse(db, sqlite, PULSE_MONITOR, {
      hours: 6,
      now: PULSE_NOW,
    });
    expect(pulse.errors.suppressed).toBe(true);
    expect(pulse.errors.breached).toBe("none");
    expect(pulse.threats.suppressed).toBe(true);
  });
});

describe("getMonitors with config", () => {
  it("carries label, url and thresholds through, and nulls them when unconfigured", () => {
    const { sqlite, db } = newDb();
    insertProbe(sqlite, "m1", false);
    insertProbe(sqlite, "gone", false);

    const rows = getMonitors(db, [
      {
        id: "m1",
        url: "https://example.test",
        label: "Example",
        probeIntervalSeconds: 60,
        slowResponseMs: 3000,
        errorRatio: 0.1,
        threatRatioWarn: 0.15,
        threatRatioCrit: 0.35,
        minRequests: 300,
        certWarnDays: 14,
        certCritDays: 3,
      },
    ]);

    const m1 = rows.find((r) => r.id === "m1")!;
    expect(m1.label).toBe("Example");
    expect(m1.url).toBe("https://example.test");
    expect(m1.thresholds?.slowResponseMs).toBe(3000);

    // A probe_state row that outlived its config entry must not pretend to
    // have thresholds — the card uses this to explain itself.
    const gone = rows.find((r) => r.id === "gone")!;
    expect(gone.label).toBeNull();
    expect(gone.url).toBeNull();
    expect(gone.thresholds).toBeNull();
  });
});

describe("getUptime", () => {
  function seedUp(
    sqlite: Database,
    monitor: string,
    values: readonly number[],
    startAgoSeconds: number,
  ): void {
    const stmt = sqlite.prepare(
      "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
    );
    values.forEach((v, i) => {
      stmt.run(monitor, "probe", "up", NOW - startAgoSeconds + i * 300, v);
    });
  }

  it("returns null ratio and zero samples when nothing was recorded", () => {
    const { db } = newDb();
    const view = getUptime(db, "m1");
    expect(view.windows).toHaveLength(3);
    for (const w of view.windows) {
      expect(w.ratio).toBeNull();
      expect(w.samples).toBe(0);
    }
  });

  it("computes the ratio of up buckets", () => {
    const { sqlite, db } = newDb();
    // 8 up, 2 down, all within the last hour.
    seedUp(sqlite, "m1", [1, 1, 1, 1, 0, 1, 1, 0, 1, 1], 3000);

    const view = getUptime(db, "m1", [24]);
    expect(view.windows[0]!.samples).toBe(10);
    expect(view.windows[0]!.ratio).toBeCloseTo(0.8, 6);
  });

  it("scopes each window to its own cutoff", () => {
    const { sqlite, db } = newDb();
    // One down bucket 10 days back, one up bucket just now.
    const stmt = sqlite.prepare(
      "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
    );
    stmt.run("m1", "probe", "up", NOW - 10 * 24 * 3600, 0);
    stmt.run("m1", "probe", "up", NOW - 300, 1);

    const [day, week, month] = getUptime(db, "m1", [24, 24 * 7, 24 * 30]).windows;
    // The 10-day-old outage is outside 24h and 7d, inside 30d.
    expect(day!.samples).toBe(1);
    expect(day!.ratio).toBe(1);
    expect(week!.samples).toBe(1);
    expect(week!.ratio).toBe(1);
    expect(month!.samples).toBe(2);
    expect(month!.ratio).toBeCloseTo(0.5, 6);
  });

  it("does not count other monitors or other metrics", () => {
    const { sqlite, db } = newDb();
    const stmt = sqlite.prepare(
      "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
    );
    stmt.run("m1", "probe", "up", NOW - 300, 1);
    stmt.run("m2", "probe", "up", NOW - 300, 0); // other monitor
    stmt.run("m1", "probe", "latency_ms", NOW - 300, 0); // other metric

    const view = getUptime(db, "m1", [24]);
    expect(view.windows[0]!.samples).toBe(1);
    expect(view.windows[0]!.ratio).toBe(1);
  });
});
