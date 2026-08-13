import type { Database } from "bun:sqlite";
import { createLogger } from "../logger.ts";

// Retention sweeper. Runs once per day. Deletes:
//
//   - metrics older than MIN_METRIC_RETENTION_DAYS (35 by default, hard-floor
//     per brief §9 — dropping below this breaks the 4-week seasonal baseline
//     the detectors depend on),
//   - resolved alerts older than RESOLVED_ALERT_RETENTION_DAYS (default 90),
//   - deliveries older than the same window (they reference alert_id).

const MIN_METRIC_RETENTION_DAYS = 35;
const DEFAULT_METRIC_RETENTION_DAYS = 42; // one extra week of slack
const DEFAULT_ALERT_RETENTION_DAYS = 90;

export interface RetentionOptions {
  sqlite: Database;
  metricRetentionDays?: number;
  alertRetentionDays?: number;
  now?: () => number;
}

export interface RetentionReport {
  metricsDeleted: number;
  alertsDeleted: number;
  deliveriesDeleted: number;
  commandsDeleted: number;
}

export function sweepRetention(opts: RetentionOptions): RetentionReport {
  const log = createLogger("retention");
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const metricDays = Math.max(
    opts.metricRetentionDays ?? DEFAULT_METRIC_RETENTION_DAYS,
    MIN_METRIC_RETENTION_DAYS,
  );
  const alertDays = opts.alertRetentionDays ?? DEFAULT_ALERT_RETENTION_DAYS;

  const nowSec = now();
  const metricCutoff = nowSec - metricDays * 24 * 60 * 60;
  const alertCutoff = nowSec - alertDays * 24 * 60 * 60;

  const sqlite = opts.sqlite;

  const tx = sqlite.transaction(() => {
    // Metrics
    const metricsRes = sqlite
      .prepare("DELETE FROM metrics WHERE bucket_ts < ?")
      .run(metricCutoff);

    // Deliveries first (references alerts).
    const deliveriesRes = sqlite
      .prepare(
        `DELETE FROM deliveries WHERE created_at < ?
           AND alert_id IN (
             SELECT id FROM alerts WHERE status = 'resolved' AND resolved_at < ?
           )`,
      )
      .run(alertCutoff, alertCutoff);

    const alertsRes = sqlite
      .prepare(
        "DELETE FROM alerts WHERE status = 'resolved' AND resolved_at < ?",
      )
      .run(alertCutoff);

    // Old completed commands — these are audit-lite, 30d is enough.
    const commandsRes = sqlite
      .prepare(
        `DELETE FROM commands
           WHERE status IN ('done', 'failed')
             AND created_at < ?`,
      )
      .run(nowSec - 30 * 24 * 60 * 60);

    return {
      metricsDeleted: Number(metricsRes.changes),
      alertsDeleted: Number(alertsRes.changes),
      deliveriesDeleted: Number(deliveriesRes.changes),
      commandsDeleted: Number(commandsRes.changes),
    };
  });

  const report = tx();
  log.info(report, "retention sweep complete");
  return report;
}
