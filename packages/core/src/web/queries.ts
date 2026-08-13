import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type { DB } from "../db/client.ts";
import { alerts, metrics, probeState, systemState } from "../db/schema.ts";
import type { MetricName, MetricSource } from "../db/schema.ts";
import {
  readActiveSnoozes,
  type AdhocSnooze,
  type MaintenanceWindow,
} from "../alerts/maintenance.ts";

// Read helpers used by the web app's server functions. The engine/collectors
// live in packages/core so we can share the same types; the *web* consumers
// only ever see this narrow surface — no direct drizzle instance leaks into
// apps/web (that plus the strict-write mutations.ts is what enforces brief
// §7's "web can only write to pushSubscriptions and commands" rule).

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export type OverallVerdict = "ok" | "warning" | "critical" | "unknown";

export interface StatusView {
  verdict: OverallVerdict;
  message: string;
  monitorCount: number;
  firingCount: number;
  criticalCount: number;
  updatedAt: number;
}

export interface ActiveAlertView {
  id: number;
  fingerprint: string;
  monitor: string;
  type: string;
  severity: "critical" | "warning" | "info";
  title: string;
  body: string;
  startedAt: number;
  meta: Record<string, unknown>;
}

export interface HistoryEntryView extends ActiveAlertView {
  status: "firing" | "resolved";
  resolvedAt: number | null;
  notifyCount: number;
}

export interface SeriesPoint {
  bucketTs: number;
  value: number;
}

export interface MonitorSummaryView {
  id: string;
  isDown: boolean;
  lastCheckAt: number | null;
  lastStatus: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  currentAlerts: Array<{ type: string; severity: string }>;
}

export interface SystemHealthView {
  updatedAt: number;
  waNeedsRelink: boolean;
  waRelinkReason: string | null;
  vapidPublicKey: string | null;
  quietHours: string | null;
  timezone: string;
}

export interface SnoozesView {
  adhoc: AdhocSnooze[];
  recurring: Array<{ monitor: string; windows: MaintenanceWindow[] }>;
  updatedAt: number;
}

// --------------------------------------------------------------------------
// Query implementations
// --------------------------------------------------------------------------

export function getStatus(db: DB): StatusView {
  const firing = db
    .select({
      severity: alerts.severity,
    })
    .from(alerts)
    .where(eq(alerts.status, "firing"))
    .all();

  const monitorRows = db.select({ monitor: probeState.monitor }).from(probeState).all();
  const monitorCount = monitorRows.length;
  const firingCount = firing.length;
  const criticalCount = firing.filter((a) => a.severity === "critical").length;

  let verdict: OverallVerdict = "ok";
  let message = "All monitors quiet.";
  if (criticalCount > 0) {
    verdict = "critical";
    message =
      criticalCount === 1
        ? "1 critical alert firing."
        : `${criticalCount} critical alerts firing.`;
  } else if (firingCount > 0) {
    verdict = "warning";
    message =
      firingCount === 1
        ? "1 warning alert firing."
        : `${firingCount} warning alerts firing.`;
  } else if (monitorCount === 0) {
    verdict = "unknown";
    message = "No monitors have reported yet.";
  }

  return {
    verdict,
    message,
    monitorCount,
    firingCount,
    criticalCount,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

export function getActiveAlerts(db: DB): ActiveAlertView[] {
  const rows = db
    .select()
    .from(alerts)
    .where(eq(alerts.status, "firing"))
    .orderBy(desc(alerts.startedAt))
    .all();
  return rows.map((r) => ({
    id: r.id,
    fingerprint: r.fingerprint,
    monitor: r.monitor,
    type: r.type,
    severity: r.severity,
    title: r.title,
    body: r.body,
    startedAt: r.startedAt,
    meta: (r.meta as Record<string, unknown>) ?? {},
  }));
}

export function getAlertHistory(db: DB, limit = 25): HistoryEntryView[] {
  const rows = db
    .select()
    .from(alerts)
    .orderBy(desc(alerts.startedAt))
    .limit(limit)
    .all();
  return rows.map((r) => ({
    id: r.id,
    fingerprint: r.fingerprint,
    monitor: r.monitor,
    type: r.type,
    severity: r.severity,
    status: r.status,
    title: r.title,
    body: r.body,
    startedAt: r.startedAt,
    resolvedAt: r.resolvedAt,
    notifyCount: r.notifyCount,
    meta: (r.meta as Record<string, unknown>) ?? {},
  }));
}

export function getSeries(
  db: DB,
  args: {
    monitor: string;
    source: MetricSource;
    metric: MetricName;
    hours: number;
  },
): SeriesPoint[] {
  const cutoff = Math.floor(Date.now() / 1000) - args.hours * 3600;
  const rows = db
    .select({ bucketTs: metrics.bucketTs, value: metrics.value })
    .from(metrics)
    .where(
      and(
        eq(metrics.monitor, args.monitor),
        eq(metrics.source, args.source),
        eq(metrics.metric, args.metric),
        gte(metrics.bucketTs, cutoff),
      ),
    )
    .orderBy(metrics.bucketTs)
    .all();
  return rows;
}

export function getMonitors(db: DB): MonitorSummaryView[] {
  const probeRows = db.select().from(probeState).all();
  const firing = db
    .select({
      monitor: alerts.monitor,
      type: alerts.type,
      severity: alerts.severity,
    })
    .from(alerts)
    .where(eq(alerts.status, "firing"))
    .all();
  const byMonitor = new Map<string, Array<{ type: string; severity: string }>>();
  for (const a of firing) {
    if (!byMonitor.has(a.monitor)) byMonitor.set(a.monitor, []);
    byMonitor.get(a.monitor)!.push({ type: a.type, severity: a.severity });
  }
  return probeRows.map((r) => ({
    id: r.monitor,
    isDown: r.isDown,
    lastCheckAt: r.lastCheckAt,
    lastStatus: r.lastStatus,
    lastLatencyMs: r.lastLatencyMs,
    lastError: r.lastError,
    currentAlerts: byMonitor.get(r.monitor) ?? [],
  }));
}

export function getSystemHealth(
  db: DB,
  publicEnv: { vapidPublicKey: string | null; timezone: string; quietHours: string | null },
): SystemHealthView {
  const row = db
    .select()
    .from(systemState)
    .where(eq(systemState.key, "wa:needs-relink"))
    .get();
  const relinkMeta = row
    ? ((row.value as { reason?: string } | null) ?? null)
    : null;
  return {
    updatedAt: Math.floor(Date.now() / 1000),
    waNeedsRelink: Boolean(row),
    waRelinkReason: relinkMeta?.reason ?? null,
    vapidPublicKey: publicEnv.vapidPublicKey,
    quietHours: publicEnv.quietHours,
    timezone: publicEnv.timezone,
  };
}

/** WhatsApp QR code (if pending). Returns null when no QR is waiting. */
export function getWhatsAppQr(db: DB): string | null {
  const row = db
    .select()
    .from(systemState)
    .where(eq(systemState.key, "wa:qr"))
    .get();
  if (!row || row.value === null) return null;
  const v = row.value as { qr?: string };
  return v.qr ?? null;
}

/**
 * Active snooze state — ad-hoc (from system_state) + recurring windows (from
 * monitors.json passed in). Both go into the same view so the dashboard
 * renders a single "Snooze" panel.
 */
export function getActiveSnoozes(
  sqlite: Database,
  monitors: readonly { id: string; maintenanceWindows: MaintenanceWindow[] }[],
): SnoozesView {
  const now = Math.floor(Date.now() / 1000);
  const adhoc = readActiveSnoozes(sqlite, now);
  const recurring = monitors
    .filter((m) => m.maintenanceWindows.length > 0)
    .map((m) => ({ monitor: m.id, windows: m.maintenanceWindows }));
  return { adhoc, recurring, updatedAt: now };
}

/** For dashboard "N alerts in last 24h" — cheap count. */
export function getRecentAlertCount(db: DB, hours = 24): number {
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(alerts)
    .where(gte(alerts.startedAt, cutoff))
    .get();
  return Number(row?.n ?? 0);
}
