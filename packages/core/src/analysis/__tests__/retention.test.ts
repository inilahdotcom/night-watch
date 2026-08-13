import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { sweepRetention } from "../retention.ts";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "migrations",
);

function newDb(): Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, "0000_init.sql"), "utf8"));
  return sqlite;
}

const NOW = 2_000_000_000;
const DAY = 24 * 60 * 60;

describe("sweepRetention", () => {
  it("deletes metrics older than the (defaulted) retention window", () => {
    const sqlite = newDb();
    const stmt = sqlite.prepare(
      "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
    );
    // 100 buckets over ~60 days, one per day
    for (let i = 1; i <= 60; i += 1) {
      stmt.run("m1", "cloudflare", "cf_requests", NOW - i * DAY, i);
    }
    const r = sweepRetention({ sqlite, metricRetentionDays: 42, now: () => NOW });
    // Everything older than 42 days ago is gone → keep i in [1..42].
    expect(r.metricsDeleted).toBe(60 - 42);
    const remaining = sqlite
      .prepare("SELECT COUNT(*) AS n FROM metrics")
      .get() as { n: number };
    expect(remaining.n).toBe(42);
  });

  it("does not go below the 35-day floor even when a smaller retention is requested", () => {
    const sqlite = newDb();
    const stmt = sqlite.prepare(
      "INSERT INTO metrics (monitor, source, metric, bucket_ts, value) VALUES (?, ?, ?, ?, ?)",
    );
    for (let i = 1; i <= 60; i += 1) {
      stmt.run("m1", "cloudflare", "cf_requests", NOW - i * DAY, i);
    }
    const r = sweepRetention({ sqlite, metricRetentionDays: 7, now: () => NOW });
    // Floor engages → treat requested 7d as 35d.
    expect(r.metricsDeleted).toBe(60 - 35);
    const remaining = sqlite
      .prepare("SELECT COUNT(*) AS n FROM metrics")
      .get() as { n: number };
    expect(remaining.n).toBe(35);
  });

  it("deletes resolved alerts + their deliveries older than the alert window", () => {
    const sqlite = newDb();
    // Old resolved alert with a delivery.
    sqlite
      .prepare(
        `INSERT INTO alerts (id, fingerprint, monitor, type, severity, status, title, body, started_at, resolved_at)
           VALUES (?, ?, ?, ?, ?, 'resolved', ?, ?, ?, ?)`,
      )
      .run(1, "fp-old", "m1", "traffic", "warning", "t", "b", NOW - 200 * DAY, NOW - 100 * DAY);
    sqlite
      .prepare(
        "INSERT INTO deliveries (id, alert_id, channel, status, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(1, 1, "push", "sent", NOW - 100 * DAY);

    // Recent firing alert — must survive.
    sqlite
      .prepare(
        `INSERT INTO alerts (id, fingerprint, monitor, type, severity, status, title, body, started_at)
           VALUES (?, ?, ?, ?, ?, 'firing', ?, ?, ?)`,
      )
      .run(2, "fp-active", "m1", "uptime", "critical", "down", "b", NOW - 60);

    const r = sweepRetention({ sqlite, alertRetentionDays: 90, now: () => NOW });
    expect(r.alertsDeleted).toBe(1);
    expect(r.deliveriesDeleted).toBe(1);

    const remainingAlerts = sqlite
      .prepare("SELECT id FROM alerts ORDER BY id")
      .all() as Array<{ id: number }>;
    expect(remainingAlerts.map((r) => r.id)).toEqual([2]);
  });

  it("does not delete firing alerts, no matter how old", () => {
    const sqlite = newDb();
    sqlite
      .prepare(
        `INSERT INTO alerts (fingerprint, monitor, type, severity, status, title, body, started_at)
           VALUES (?, ?, ?, ?, 'firing', ?, ?, ?)`,
      )
      .run("still-firing", "m1", "traffic", "warning", "t", "b", NOW - 400 * DAY);
    const r = sweepRetention({ sqlite, alertRetentionDays: 30, now: () => NOW });
    expect(r.alertsDeleted).toBe(0);
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM alerts")
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("prunes done/failed commands older than 30d, keeps pending", () => {
    const sqlite = newDb();
    sqlite
      .prepare(
        "INSERT INTO commands (kind, status, created_at) VALUES (?, 'done', ?)",
      )
      .run("test_alert", NOW - 40 * DAY);
    sqlite
      .prepare(
        "INSERT INTO commands (kind, status, created_at) VALUES (?, 'pending', ?)",
      )
      .run("test_alert", NOW - 40 * DAY); // should NOT be deleted
    const r = sweepRetention({ sqlite, now: () => NOW });
    expect(r.commandsDeleted).toBe(1);
    const remaining = sqlite
      .prepare("SELECT status FROM commands")
      .all() as Array<{ status: string }>;
    expect(remaining.map((r) => r.status)).toEqual(["pending"]);
  });
});
