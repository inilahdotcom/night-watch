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
import {
  confirmConsecutive,
  evaluateTraffic,
  gatherBaseline,
  robustZScore,
  MAD_TO_SIGMA,
} from "../detectors/index.ts";
import type { TrafficAnomaly } from "../detectors/index.ts";
import {
  alignBucket,
  lastEvaluableBucket,
  loadRequestsHistory,
} from "../analysis/cycle.ts";

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

/**
 * The thresholds the detectors actually compare against, carried to the UI so
 * the dashboard can render "412ms of 3000ms" instead of hard-coding 3000 and
 * quietly lying to anyone who tuned their config.
 */
export interface MonitorThresholds {
  probeIntervalSeconds: number;
  slowResponseMs: number;
  errorRatio: number;
  threatRatioWarn: number;
  threatRatioCrit: number;
  minRequests: number;
}

export interface MonitorSummaryView {
  id: string;
  /** Human name from config. Null when the row outlived its config entry. */
  label: string | null;
  url: string | null;
  isDown: boolean;
  lastCheckAt: number | null;
  lastStatus: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  thresholds: MonitorThresholds | null;
  currentAlerts: Array<{ type: string; severity: string }>;
}

/** The config fields `getMonitors` needs. Structural, like `getActiveSnoozes`. */
export interface MonitorIdentityInput extends MonitorThresholds {
  id: string;
  url: string;
  label?: string;
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

// --------------------------------------------------------------------------
// Pulse — the chart data, scored with the detector's own definition
// --------------------------------------------------------------------------
//
// This exists because the dashboard used to invent its own notion of
// "anomalous": bars outside the P15-P85 of the *displayed window*. That is
// self-referential, so ~30% of bars were always coloured, even on a perfectly
// healthy monitor, and the colours had no relationship to the alerts anyone
// actually received.
//
// Here we run the real thing — gatherBaseline + evaluateTraffic +
// confirmConsecutive, with the monitor's own tuning — so a coloured bar means
// the same thing a WhatsApp message means.

/**
 * Per-bucket verdict. The component maps these to colour and nothing else; no
 * statistics happen in the browser.
 *
 *  normal       within the baseline band
 *  deviating    outside it, but not (yet) a run long enough to alert
 *  confirmed    part of a run that did trigger an alert
 *  unevaluated  newer than the analysis lag; no detector has judged it yet
 *  below-floor  baseline median under minBaseline, so traffic alerts are muted
 *  no-baseline  not enough history to say anything
 */
export type PulseState =
  | "normal"
  | "deviating"
  | "confirmed"
  | "unevaluated"
  | "below-floor"
  | "no-baseline";

export interface PulseBucket {
  bucketTs: number;
  value: number;
  /** Baseline median. Null when there is nothing trustworthy to compare to. */
  expected: number | null;
  /** Band edges — null alongside a null `expected`. */
  low: number | null;
  high: number | null;
  state: PulseState;
}

/**
 * A reading against the flat threshold the engine uses for it. Unlike traffic,
 * none of these have a statistical baseline, so we deliberately do not invent
 * a "normal band" for them.
 */
export interface ThresholdSignal {
  value: number | null;
  warn: number;
  critical: number | null;
  breached: "none" | "warn" | "critical";
  /** DDoS scoring is silenced below minRequests; say so rather than imply calm. */
  suppressed: boolean;
}

export interface PulseView {
  monitor: string;
  bucketSeconds: number;
  windowHours: number;
  /** Which baseline the newest evaluated bucket used. */
  baselineSource: "seasonal" | "rolling" | "insufficient";
  buckets: PulseBucket[];
  /** Latest observed request count, and what the baseline expected for it. */
  latest: { value: number; expected: number | null } | null;
  latency: ThresholdSignal;
  errors: ThresholdSignal;
  threats: ThresholdSignal;
}

/** The detector tuning `getPulse` needs. Structural, mirrors `Monitor`. */
export interface PulseMonitorInput extends MonitorThresholds {
  id: string;
  bucketSeconds: number;
  baselineWeeks: number;
  minSamples: number;
  spikeZ: number;
  minBaseline: number;
  minRelativeChange: number;
  consecutiveBuckets: number;
  ingestLagSeconds: number;
}

const WEEK_SECONDS = 7 * 24 * 60 * 60;

interface CfBucket {
  requests: number;
  threats: number;
  status5xx: number;
}

function classify(
  value: number,
  warn: number,
  critical: number | null,
): ThresholdSignal["breached"] {
  if (critical !== null && value >= critical) return "critical";
  if (value >= warn) return "warn";
  return "none";
}

export function getPulse(
  db: DB,
  sqlite: Database,
  monitor: PulseMonitorInput,
  args: { hours: number; now?: number },
): PulseView {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const { bucketSeconds, consecutiveBuckets } = monitor;

  const windowEnd = alignBucket(now, bucketSeconds);
  const windowStart = windowEnd - args.hours * 3600;
  // Evaluate a few buckets before the window so the consecutive-run state is
  // warm by the time we reach the first bar the user sees. Without this the
  // leftmost bars could never be "confirmed", which would be an artefact of
  // where the window happens to start.
  const warmupStart = windowStart - consecutiveBuckets * bucketSeconds;

  // One read for everything the chart displays.
  const displayRows = db
    .select({
      metric: metrics.metric,
      bucketTs: metrics.bucketTs,
      value: metrics.value,
    })
    .from(metrics)
    .where(
      and(
        eq(metrics.monitor, monitor.id),
        eq(metrics.source, "cloudflare"),
        gte(metrics.bucketTs, warmupStart),
      ),
    )
    .orderBy(metrics.bucketTs)
    .all();

  const byBucket = new Map<number, CfBucket>();
  for (const row of displayRows) {
    let entry = byBucket.get(row.bucketTs);
    if (!entry) {
      entry = { requests: 0, threats: 0, status5xx: 0 };
      byBucket.set(row.bucketTs, entry);
    }
    if (row.metric === "cf_requests") entry.requests = row.value;
    else if (row.metric === "cf_threats") entry.threats = row.value;
    else if (row.metric === "cf_status_5xx") entry.status5xx = row.value;
  }

  // One read for the baseline history. Bounded to what the seasonal lookback
  // can actually reach, rather than the analysis cycle's unbounded read.
  const historySince =
    warmupStart - monitor.baselineWeeks * WEEK_SECONDS - bucketSeconds;
  const history = loadRequestsHistory(
    sqlite,
    monitor.id,
    windowEnd + bucketSeconds,
    historySince,
  );

  const lastEval = lastEvaluableBucket(now, monitor);
  const recent: TrafficAnomaly[] = [];
  const scored: PulseBucket[] = [];
  let baselineSource: PulseView["baselineSource"] = "insufficient";

  const ordered = [...byBucket.keys()].sort((a, b) => a - b);

  for (const bucketTs of ordered) {
    const value = byBucket.get(bucketTs)!.requests;

    // Never paint a verdict on a bucket no detector has looked at.
    if (bucketTs > lastEval) {
      scored.push({
        bucketTs,
        value,
        expected: null,
        low: null,
        high: null,
        state: "unevaluated",
      });
      continue;
    }

    // History strictly before this bucket — that filter is what keeps a bucket
    // out of its own baseline.
    const baseline = gatherBaseline(
      bucketTs,
      history.filter((h) => h.bucketTs < bucketTs),
      {
        bucketSeconds,
        baselineWeeks: monitor.baselineWeeks,
        minSamples: monitor.minSamples,
      },
    );
    baselineSource = baseline.source;

    if (baseline.samples.length === 0) {
      scored.push({
        bucketTs,
        value,
        expected: null,
        low: null,
        high: null,
        state: "no-baseline",
      });
      continue;
    }

    // Mirror the cycle exactly: it feeds the samples through regardless of
    // `source`, and lets the minBaseline guard do the suppressing.
    const traffic = evaluateTraffic(value, baseline.samples, {
      spikeZ: monitor.spikeZ,
      minBaseline: monitor.minBaseline,
      minRelativeChange: monitor.minRelativeChange,
    });
    recent.push(traffic);
    if (recent.length > 10) recent.shift();
    const confirmed = confirmConsecutive(recent, consecutiveBuckets);

    const z = robustZScore(value, baseline.samples);

    // Invert the guards to get the band. A bucket alerts only when it breaks
    // BOTH the z threshold and the relative-change threshold, so the band the
    // user should see is the wider of the two.
    const zHalf = (monitor.spikeZ * z.scale) / MAD_TO_SIGMA;
    const relHalf = monitor.minRelativeChange * Math.max(Math.abs(z.median), 1);
    const half = Math.max(zHalf, relHalf);

    let state: PulseState;
    if (baseline.source === "insufficient") state = "no-baseline";
    else if (z.median < monitor.minBaseline) state = "below-floor";
    else if (confirmed) state = "confirmed";
    else if (traffic.triggered) state = "deviating";
    else state = "normal";

    const trustworthy = state !== "no-baseline";
    scored.push({
      bucketTs,
      value,
      expected: trustworthy ? z.median : null,
      low: trustworthy ? Math.max(0, z.median - half) : null,
      high: trustworthy ? z.median + half : null,
      state,
    });

    // A confirmed run means the preceding buckets were part of the same run.
    // Showing only its last bucket would under-report what actually fired.
    if (state === "confirmed") {
      for (let k = 1; k < consecutiveBuckets; k += 1) {
        const prev = scored[scored.length - 1 - k];
        if (prev?.state === "deviating") prev.state = "confirmed";
      }
    }
  }

  const buckets = scored.filter((b) => b.bucketTs >= windowStart);

  // Secondary signals read off the newest bucket the detectors have judged —
  // not the newest bucket that exists, which may still be filling.
  const latestEvaluated = ordered.filter((ts) => ts <= lastEval).pop();
  const cf = latestEvaluated ? byBucket.get(latestEvaluated)! : null;
  const suppressed = cf === null || cf.requests < monitor.minRequests;

  const errorValue =
    cf && cf.requests > 0 ? cf.status5xx / cf.requests : cf ? 0 : null;
  const threatValue =
    cf && cf.requests > 0 ? cf.threats / cf.requests : cf ? 0 : null;

  const probe = db
    .select({ lastLatencyMs: probeState.lastLatencyMs })
    .from(probeState)
    .where(eq(probeState.monitor, monitor.id))
    .get();
  const latencyValue = probe?.lastLatencyMs ?? null;

  const latestBucket = buckets[buckets.length - 1] ?? null;

  return {
    monitor: monitor.id,
    bucketSeconds,
    windowHours: args.hours,
    baselineSource,
    buckets,
    latest: latestBucket
      ? { value: latestBucket.value, expected: latestBucket.expected }
      : null,
    latency: {
      value: latencyValue,
      warn: monitor.slowResponseMs,
      critical: null,
      breached:
        latencyValue === null
          ? "none"
          : classify(latencyValue, monitor.slowResponseMs, null),
      suppressed: false,
    },
    errors: {
      value: errorValue,
      warn: monitor.errorRatio,
      critical: null,
      breached:
        errorValue === null || suppressed
          ? "none"
          : classify(errorValue, monitor.errorRatio, null),
      suppressed,
    },
    threats: {
      value: threatValue,
      warn: monitor.threatRatioWarn,
      critical: monitor.threatRatioCrit,
      breached:
        threatValue === null || suppressed
          ? "none"
          : classify(
              threatValue,
              monitor.threatRatioWarn,
              monitor.threatRatioCrit,
            ),
      suppressed,
    },
  };
}

export function getMonitors(
  db: DB,
  configured: readonly MonitorIdentityInput[] = [],
): MonitorSummaryView[] {
  const byId = new Map(configured.map((m) => [m.id, m] as const));
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
  return probeRows.map((r) => {
    const cfg = byId.get(r.monitor);
    return {
      id: r.monitor,
      label: cfg?.label ?? null,
      url: cfg?.url ?? null,
      isDown: r.isDown,
      lastCheckAt: r.lastCheckAt,
      lastStatus: r.lastStatus,
      lastLatencyMs: r.lastLatencyMs,
      lastError: r.lastError,
      thresholds: cfg
        ? {
            probeIntervalSeconds: cfg.probeIntervalSeconds,
            slowResponseMs: cfg.slowResponseMs,
            errorRatio: cfg.errorRatio,
            threatRatioWarn: cfg.threatRatioWarn,
            threatRatioCrit: cfg.threatRatioCrit,
            minRequests: cfg.minRequests,
          }
        : null,
      currentAlerts: byMonitor.get(r.monitor) ?? [],
    };
  });
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
