import type { Database } from "bun:sqlite";
import type { AlertEngine } from "../alerts/engine.ts";
import type { Monitor } from "../config/monitors.ts";
import {
  confirmConsecutive,
  evaluateDDoS,
  evaluateTraffic,
  gatherBaseline,
  type HistoricalPoint,
  type TrafficAnomaly,
} from "../detectors/index.ts";
import { createLogger } from "../logger.ts";

// One analysis cycle per monitor. Reads the most-recent mature buckets from
// the metrics table, runs the traffic + DDoS detectors, correlates with the
// probe_state written by the uptime collector, and raises or resolves alerts
// via the engine.
//
// Alert fingerprints use a fixed scheme so the same conceptual problem lands
// on the same row across cycles — the engine's partial unique index then
// enforces "at most one firing per fingerprint":
//
//   <monitor>:traffic:spike
//   <monitor>:traffic:drop
//   <monitor>:ddos
//   <monitor>:uptime
//   <monitor>:slow

const log = createLogger("analysis");

interface HistoryRow {
  bucket_ts: number;
  value: number;
}

interface CurrentSnapshot {
  bucketTs: number;
  requests: number;
  threats: number;
  status5xx: number;
  status429: number;
  cacheMiss: number;
}

interface ProbeStateRow {
  is_down: number;
  last_status: number | null;
  last_latency_ms: number | null;
  last_error: string | null;
}

/** Serialised per-monitor state kept in system_state so cycles across
 *  restarts don't lose their consecutive-alarm history. */
export interface MonitorAnalysisState {
  recentTraffic: TrafficAnomaly[];
  cleanDDoSStreak: number;
  cleanSlowStreak: number;
}

const STATE_KEY_PREFIX = "analysis:";

function loadState(sqlite: Database, monitorId: string): MonitorAnalysisState {
  const row = sqlite
    .prepare("SELECT value FROM system_state WHERE key = ?")
    .get(`${STATE_KEY_PREFIX}${monitorId}`) as { value: string } | undefined;
  if (!row) {
    return { recentTraffic: [], cleanDDoSStreak: 0, cleanSlowStreak: 0 };
  }
  try {
    return JSON.parse(row.value) as MonitorAnalysisState;
  } catch {
    return { recentTraffic: [], cleanDDoSStreak: 0, cleanSlowStreak: 0 };
  }
}

function saveState(
  sqlite: Database,
  monitorId: string,
  state: MonitorAnalysisState,
): void {
  sqlite
    .prepare(
      `INSERT INTO system_state (key, value, updated_at)
         VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(`${STATE_KEY_PREFIX}${monitorId}`, JSON.stringify(state), Date.now());
}

function alignBucket(ts: number, bucketSeconds: number): number {
  return Math.floor(ts / bucketSeconds) * bucketSeconds;
}

function loadRequestsHistory(
  sqlite: Database,
  monitor: string,
  beforeTs: number,
): HistoricalPoint[] {
  const rows = sqlite
    .prepare(
      `SELECT bucket_ts, value FROM metrics
        WHERE monitor = ? AND source = 'cloudflare' AND metric = 'cf_requests'
          AND bucket_ts < ?
        ORDER BY bucket_ts ASC`,
    )
    .all(monitor, beforeTs) as HistoryRow[];
  return rows.map((r) => ({ bucketTs: r.bucket_ts, value: r.value }));
}

function loadCurrentSnapshot(
  sqlite: Database,
  monitor: string,
  bucketTs: number,
): CurrentSnapshot | null {
  const rows = sqlite
    .prepare(
      `SELECT metric, value FROM metrics
        WHERE monitor = ? AND source = 'cloudflare' AND bucket_ts = ?`,
    )
    .all(monitor, bucketTs) as Array<{ metric: string; value: number }>;
  if (rows.length === 0) return null;
  const byMetric = new Map(rows.map((r) => [r.metric, r.value] as const));
  return {
    bucketTs,
    requests: byMetric.get("cf_requests") ?? 0,
    threats: byMetric.get("cf_threats") ?? 0,
    status5xx: byMetric.get("cf_status_5xx") ?? 0,
    status429: byMetric.get("cf_status_429") ?? 0,
    cacheMiss: byMetric.get("cf_cache_miss") ?? 0,
  };
}

function loadProbeState(
  sqlite: Database,
  monitor: string,
): ProbeStateRow | null {
  const row = sqlite
    .prepare(
      "SELECT is_down, last_status, last_latency_ms, last_error FROM probe_state WHERE monitor = ?",
    )
    .get(monitor) as ProbeStateRow | undefined;
  return row ?? null;
}

export interface AnalysisCycleOptions {
  monitor: Monitor;
  engine: AlertEngine;
  sqlite: Database;
  now?: () => number;
}

export interface CycleReport {
  monitor: string;
  analyzedBucketTs: number | null;
  actions: Array<{ fingerprint: string; action: string }>;
  skipReason?: string;
}

export async function runAnalysisCycle(
  opts: AnalysisCycleOptions,
): Promise<CycleReport> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const { monitor, engine, sqlite } = opts;
  const report: CycleReport = {
    monitor: monitor.id,
    analyzedBucketTs: null,
    actions: [],
  };

  // Per brief §9: never analyse an immature bucket. Back off ingestLag +
  // one full bucket so the one we look at is definitely closed.
  const evalTs = alignBucket(
    now() - monitor.ingestLagSeconds - monitor.bucketSeconds,
    monitor.bucketSeconds,
  );
  report.analyzedBucketTs = evalTs;

  const state = loadState(sqlite, monitor.id);

  // ---------------------------------------------------------------
  // Uptime — separate from Cloudflare data; driven by probe_state.
  // ---------------------------------------------------------------
  const probeState = loadProbeState(sqlite, monitor.id);
  const uptimeFp = `${monitor.id}:uptime`;
  const slowFp = `${monitor.id}:slow`;
  if (probeState) {
    if (probeState.is_down === 1) {
      const outcome = await engine.raiseAlert({
        fingerprint: uptimeFp,
        monitor: monitor.id,
        type: "uptime",
        severity: "critical",
        title: `${monitor.id} is DOWN`,
        body: `Probe failing (${probeState.last_error ?? "unknown"}). Last status: ${probeState.last_status ?? "n/a"}, last latency: ${probeState.last_latency_ms ?? "n/a"}ms.`,
        meta: { lastError: probeState.last_error },
      });
      report.actions.push({ fingerprint: uptimeFp, action: outcome.action });
    } else {
      const outcome = await engine.resolveAlert({
        fingerprint: uptimeFp,
        title: `${monitor.id} recovered`,
        body: `Probe succeeded again (status ${probeState.last_status ?? "n/a"}, latency ${probeState.last_latency_ms ?? "n/a"}ms).`,
      });
      if (outcome.action !== "not-found") {
        report.actions.push({ fingerprint: uptimeFp, action: outcome.action });
      }
    }

    // Slow-response warning: latency above threshold while otherwise up.
    if (
      probeState.is_down === 0 &&
      typeof probeState.last_latency_ms === "number" &&
      probeState.last_latency_ms >= monitor.slowResponseMs
    ) {
      state.cleanSlowStreak = 0;
      const outcome = await engine.raiseAlert({
        fingerprint: slowFp,
        monitor: monitor.id,
        type: "latency",
        severity: "warning",
        title: `${monitor.id} responding slowly`,
        body: `Last probe latency ${probeState.last_latency_ms}ms exceeds threshold of ${monitor.slowResponseMs}ms.`,
        meta: { lastLatencyMs: probeState.last_latency_ms },
      });
      report.actions.push({ fingerprint: slowFp, action: outcome.action });
    } else if (probeState.is_down === 0) {
      state.cleanSlowStreak += 1;
      if (state.cleanSlowStreak >= 3) {
        const outcome = await engine.resolveAlert({
          fingerprint: slowFp,
          title: `${monitor.id} latency back to normal`,
          body: `Recent probes within acceptable range.`,
        });
        if (outcome.action !== "not-found") {
          report.actions.push({ fingerprint: slowFp, action: outcome.action });
        }
      }
    }
  }

  // ---------------------------------------------------------------
  // Cloudflare-driven: traffic + DDoS
  // ---------------------------------------------------------------
  const snapshot = loadCurrentSnapshot(sqlite, monitor.id, evalTs);
  if (!snapshot) {
    // No Cloudflare data yet for the mature bucket — nothing to say. That's
    // normal in the first few minutes after boot, or if this monitor doesn't
    // have a Cloudflare zone configured.
    saveState(sqlite, monitor.id, state);
    report.skipReason = `no cloudflare metrics at bucket ${evalTs}`;
    return report;
  }

  const history = loadRequestsHistory(sqlite, monitor.id, evalTs);
  const baseline = gatherBaseline(evalTs, history, {
    bucketSeconds: monitor.bucketSeconds,
    baselineWeeks: monitor.baselineWeeks,
    minSamples: monitor.minSamples,
  });

  // Traffic evaluation — with consecutive-bucket confirmation.
  const trafficResult = evaluateTraffic(snapshot.requests, baseline.samples, {
    spikeZ: monitor.spikeZ,
    minBaseline: monitor.minBaseline,
    minRelativeChange: monitor.minRelativeChange,
  });
  const recentTraffic = [...state.recentTraffic, trafficResult].slice(-10);
  const confirmed = confirmConsecutive(recentTraffic, monitor.consecutiveBuckets);
  state.recentTraffic = recentTraffic;

  const spikeFp = `${monitor.id}:traffic:spike`;
  const dropFp = `${monitor.id}:traffic:drop`;
  const trafficFp =
    trafficResult.direction === "spike"
      ? spikeFp
      : trafficResult.direction === "drop"
        ? dropFp
        : null;

  if (confirmed && trafficFp) {
    const outcome = await engine.raiseAlert({
      fingerprint: trafficFp,
      monitor: monitor.id,
      type: "traffic",
      severity: "warning",
      title: `${monitor.id} traffic ${trafficResult.direction}`,
      body: `Requests=${Math.round(snapshot.requests)}, baseline median=${Math.round(trafficResult.median)}, z=${trafficResult.z.toFixed(2)}, Δrel=${(trafficResult.relativeChange * 100).toFixed(1)}%.`,
      meta: {
        z: trafficResult.z,
        median: trafficResult.median,
        relativeChange: trafficResult.relativeChange,
      },
    });
    report.actions.push({ fingerprint: trafficFp, action: outcome.action });
  } else {
    // If not currently anomalous, resolve either direction that might be open.
    for (const fp of [spikeFp, dropFp]) {
      const outcome = await engine.resolveAlert({
        fingerprint: fp,
        title: `${monitor.id} traffic back to normal`,
        body: `Requests=${Math.round(snapshot.requests)}, within baseline range.`,
      });
      if (outcome.action !== "not-found") {
        report.actions.push({ fingerprint: fp, action: outcome.action });
      }
    }
  }

  // DDoS evaluation — recovery requires 3 clean periods (brief §5.5).
  const ddos = evaluateDDoS(
    {
      requests: snapshot.requests,
      requestsBaseline: baseline.samples,
      threatRequests: snapshot.threats,
      status5xx: snapshot.status5xx,
      status429: snapshot.status429,
      cacheMissRatio:
        snapshot.requests > 0 ? snapshot.cacheMiss / snapshot.requests : 0,
    },
    {
      spikeZ: monitor.spikeZ,
      threatRatioCrit: monitor.threatRatioCrit,
      threatRatioWarn: monitor.threatRatioWarn,
      errorRatio: monitor.errorRatio,
      minRequests: monitor.minRequests,
    },
  );

  const ddosFp = `${monitor.id}:ddos`;
  if (ddos.severity !== null) {
    state.cleanDDoSStreak = 0;
    const outcome = await engine.raiseAlert({
      fingerprint: ddosFp,
      monitor: monitor.id,
      type: "ddos",
      severity: ddos.severity,
      title: `${monitor.id} DDoS pattern (${ddos.severity})`,
      body:
        `Score ${ddos.score}. Signals: ` +
        ddos.signals.map((s) => `${s.name} (${s.detail})`).join("; "),
      meta: {
        score: ddos.score,
        signals: ddos.signals,
        suggestedAction: ddos.suggestedAction,
      },
    });
    report.actions.push({ fingerprint: ddosFp, action: outcome.action });
  } else {
    state.cleanDDoSStreak += 1;
    if (state.cleanDDoSStreak >= 3) {
      const outcome = await engine.resolveAlert({
        fingerprint: ddosFp,
        title: `${monitor.id} DDoS pattern cleared`,
        body: `3 consecutive clean buckets. Requests=${Math.round(snapshot.requests)}.`,
      });
      if (outcome.action !== "not-found") {
        report.actions.push({ fingerprint: ddosFp, action: outcome.action });
      }
    }
  }

  saveState(sqlite, monitor.id, state);
  log.debug(
    {
      monitor: monitor.id,
      bucketTs: evalTs,
      baselineSource: baseline.source,
      actions: report.actions.length,
    },
    "analysis cycle complete",
  );
  return report;
}
