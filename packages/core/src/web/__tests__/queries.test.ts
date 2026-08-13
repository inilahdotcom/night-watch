import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, expect, it } from "bun:test";
import * as schema from "../../db/schema.ts";
import {
  getActiveAlerts,
  getAlertHistory,
  getMonitors,
  getSeries,
  getStatus,
  getSystemHealth,
} from "../queries.ts";

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
