import type { Database } from "bun:sqlite";
import type { AlertEngine } from "../alerts/engine.ts";
import type { Monitor } from "../config/monitors.ts";
import type { MetricName } from "../db/schema.ts";
import {
  confirmConsecutive,
  evaluateCert,
  evaluateContent,
  evaluateDDoS,
  evaluateTraffic,
  gatherBaseline,
} from "../detectors/index.ts";
import type { HistoricalPoint, TrafficAnomaly } from "../detectors/index.ts";
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
//   <monitor>:cert
//   <monitor>:content:forbidden
//   <monitor>:content:size
//   <monitor>:baseline:<metric>

const log = createLogger("analysis");

// Human names for the extra baselined metrics — these end up in WhatsApp
// messages, where "ga_active_users drop" reads worse than "active users drop".
const METRIC_LABELS: Partial<Record<MetricName, string>> = {
  ga_active_users: "active users",
  ga_page_views: "page views",
  latency_ms: "latency",
  cf_bytes: "bandwidth",
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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
  last_body_bytes: number | null;
  last_forbid_hits: string | null;
}

/** Serialised per-monitor state kept in system_state so cycles across
 *  restarts don't lose their consecutive-alarm history. */
export interface MonitorAnalysisState {
  recentTraffic: TrafficAnomaly[];
  cleanDDoSStreak: number;
  cleanSlowStreak: number;
  /**
   * Consecutive-bucket history for the extra baselined metrics, keyed by
   * metric name. Absent on state written before those existed, which is why
   * every read defaults it — a worker restart after an upgrade must not throw.
   */
  recentByMetric?: Record<string, TrafficAnomaly[]>;
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

export function alignBucket(ts: number, bucketSeconds: number): number {
  return Math.floor(ts / bucketSeconds) * bucketSeconds;
}

/**
 * The newest bucket the analysis cycle is willing to judge: back off the
 * ingest lag plus one full bucket so the bucket is definitely closed.
 *
 * Exported for the dashboard, which must not paint a verdict on buckets no
 * detector has evaluated yet — those are the 1-2 newest bars on every chart.
 */
export function lastEvaluableBucket(
  nowSec: number,
  monitor: Pick<Monitor, "ingestLagSeconds" | "bucketSeconds">,
): number {
  return alignBucket(
    nowSec - monitor.ingestLagSeconds - monitor.bucketSeconds,
    monitor.bucketSeconds,
  );
}

/**
 * The cf_requests history the baseline gatherer compares against.
 *
 * Exported because the dashboard has to draw the *same* baseline the detector
 * uses. Two copies of this query is exactly how the chart and the alert engine
 * drifted apart in the first place — the chart invented its own notion of
 * "normal" and coloured bars that no detector had ever looked at.
 *
 * `sinceTs` is optional and purely a bound on how much history to pull; the
 * analysis cycle leaves it open (retention is the only limit), while the web
 * read caps it at the few weeks the seasonal baseline can actually reach.
 */
export function loadMetricHistory(
  sqlite: Database,
  monitor: string,
  metric: MetricName,
  beforeTs: number,
  sinceTs?: number,
): HistoricalPoint[] {
  const rows =
    sinceTs === undefined
      ? (sqlite
          .prepare(
            `SELECT bucket_ts, value FROM metrics
              WHERE monitor = ? AND metric = ?
                AND bucket_ts < ?
              ORDER BY bucket_ts ASC`,
          )
          .all(monitor, metric, beforeTs) as HistoryRow[])
      : (sqlite
          .prepare(
            `SELECT bucket_ts, value FROM metrics
              WHERE monitor = ? AND metric = ?
                AND bucket_ts < ? AND bucket_ts >= ?
              ORDER BY bucket_ts ASC`,
          )
          .all(monitor, metric, beforeTs, sinceTs) as HistoryRow[]);
  return rows.map((r) => ({ bucketTs: r.bucket_ts, value: r.value }));
}

/**
 * Kept as a thin wrapper rather than replaced at every call site: `getPulse`
 * in the web layer calls this to draw the very same baseline the traffic
 * detector uses, and that alignment is the whole reason a coloured bar on the
 * chart means what a WhatsApp message means.
 */
export function loadRequestsHistory(
  sqlite: Database,
  monitor: string,
  beforeTs: number,
  sinceTs?: number,
): HistoricalPoint[] {
  return loadMetricHistory(sqlite, monitor, "cf_requests", beforeTs, sinceTs);
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
      `SELECT is_down, last_status, last_latency_ms, last_error,
              last_body_bytes, last_forbid_hits
         FROM probe_state WHERE monitor = ?`,
    )
    .get(monitor) as ProbeStateRow | undefined;
  return row ?? null;
}

/**
 * `last_forbid_hits` is written as a JSON array by the collector. A corrupt or
 * legacy value must not take the whole cycle down — an unreadable hit list is
 * treated as "no hits", which is the same state a monitor with no blocklist is
 * in, and the next probe overwrites it.
 */
function parseForbidHits(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
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
  const evalTs = lastEvaluableBucket(now(), monitor);
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
  // TLS certificate expiry — probe-driven, so it must run before the
  // Cloudflare early-return below. A monitor with no CF zone still has a
  // certificate, and that is exactly the monitor most likely to have nobody
  // watching its renewal.
  // ---------------------------------------------------------------
  const certFp = `${monitor.id}:cert`;
  const certRow = sqlite
    .prepare(
      `SELECT value FROM metrics
         WHERE monitor = ? AND metric = 'tls_days_left'
         ORDER BY bucket_ts DESC LIMIT 1`,
    )
    .get(monitor.id) as { value: number } | undefined;

  if (certRow) {
    const cert = evaluateCert(certRow.value, {
      certWarnDays: monitor.certWarnDays,
      certCritDays: monitor.certCritDays,
    });
    if (cert.severity !== null) {
      const outcome = await engine.raiseAlert({
        fingerprint: certFp,
        monitor: monitor.id,
        type: "cert",
        severity: cert.severity,
        title: `${monitor.id} TLS ${cert.daysLeft < 0 ? "certificate expired" : "certificate expiring"}`,
        body: `The TLS ${cert.message}. Renew it before browsers start refusing the connection.`,
        meta: { daysLeft: cert.daysLeft },
      });
      report.actions.push({ fingerprint: certFp, action: outcome.action });
    } else {
      // No clean-streak hysteresis here on purpose: unlike traffic or DDoS,
      // the renewal is a step change, not a noisy signal that can flap.
      const outcome = await engine.resolveAlert({
        fingerprint: certFp,
        title: `${monitor.id} TLS certificate renewed`,
        body: `The ${cert.message}.`,
      });
      if (outcome.action !== "not-found") {
        report.actions.push({ fingerprint: certFp, action: outcome.action });
      }
    }
  }

  // ---------------------------------------------------------------
  // Content integrity — probe-driven, so like the cert check it must run
  // before the Cloudflare early-return. This is the one detector that can
  // catch a site which is up, fast, and busy, and has still been defaced.
  // ---------------------------------------------------------------
  const forbiddenFp = `${monitor.id}:content:forbidden`;
  const sizeFp = `${monitor.id}:content:size`;

  if (probeState?.last_body_bytes != null) {
    const sizeHistory = sqlite
      .prepare(
        `SELECT value FROM metrics
           WHERE monitor = ? AND metric = 'body_bytes' AND bucket_ts < ?
           ORDER BY bucket_ts DESC LIMIT 60`,
      )
      .all(monitor.id, evalTs) as Array<{ value: number }>;

    const content = evaluateContent(
      {
        forbidHits: parseForbidHits(probeState.last_forbid_hits),
        bodyBytes: probeState.last_body_bytes,
        bodyBytesBaseline: sizeHistory.map((r) => r.value),
      },
      {
        spikeZ: monitor.spikeZ,
        minRelativeChange: monitor.minRelativeChange,
        minSamples: monitor.minSamples,
      },
    );

    for (const [kind, fp] of [
      ["forbidden", forbiddenFp],
      ["size", sizeFp],
    ] as const) {
      const finding = content.findings.find((f) => f.kind === kind);
      if (finding) {
        const outcome = await engine.raiseAlert({
          fingerprint: fp,
          monitor: monitor.id,
          type: "content",
          severity: finding.severity,
          title:
            kind === "forbidden"
              ? `${monitor.id} content injection`
              : `${monitor.id} unexpected page size`,
          body: `The ${finding.message}.`,
          meta: finding.meta,
        });
        report.actions.push({ fingerprint: fp, action: outcome.action });
      } else {
        const outcome = await engine.resolveAlert({
          fingerprint: fp,
          title:
            kind === "forbidden"
              ? `${monitor.id} content clean again`
              : `${monitor.id} page size back to normal`,
          body:
            kind === "forbidden"
              ? "No blocked terms found in the page body."
              : "Response body size is back within its usual range.",
        });
        if (outcome.action !== "not-found") {
          report.actions.push({ fingerprint: fp, action: outcome.action });
        }
      }
    }
  }

  // ---------------------------------------------------------------
  // Extra baselined metrics (GA4 users, latency, bytes).
  //
  // Reuses gatherBaseline + evaluateTraffic + confirmConsecutive unchanged —
  // those were always pure and metric-agnostic; only a caller was missing.
  //
  // `ga_active_users` dropping is the sharpest gap this closes: when the CDN
  // is healthy but the page is broken in the browser, Cloudflare still sees
  // normal request volume while GA4 watches the humans disappear. No other
  // detector here can see that.
  //
  // Runs before the Cloudflare early-return so a monitor with GA4 but no CF
  // zone is still covered.
  // ---------------------------------------------------------------
  const recentByMetric = state.recentByMetric ?? {};
  for (const [metricName, override] of Object.entries(monitor.baselines)) {
    if (!override.enabled) continue;
    const metric = metricName as MetricName;
    const fp = `${monitor.id}:baseline:${metric}`;

    const currentRow = sqlite
      .prepare(
        `SELECT value FROM metrics
           WHERE monitor = ? AND metric = ? AND bucket_ts = ?`,
      )
      .get(monitor.id, metric, evalTs) as { value: number } | undefined;

    if (!currentRow) continue;

    const history = loadMetricHistory(sqlite, monitor.id, metric, evalTs);
    const metricBaseline = gatherBaseline(evalTs, history, {
      bucketSeconds: monitor.bucketSeconds,
      baselineWeeks: monitor.baselineWeeks,
      minSamples: monitor.minSamples,
    });

    const result = evaluateTraffic(currentRow.value, metricBaseline.samples, {
      spikeZ: override.spikeZ ?? monitor.spikeZ,
      // Defaults to 0, not to the monitor's minBaseline: that floor is
      // expressed in requests-per-bucket and means nothing applied to
      // milliseconds or active users.
      minBaseline: override.minBaseline ?? 0,
      minRelativeChange:
        override.minRelativeChange ?? monitor.minRelativeChange,
    });

    const recent = [...(recentByMetric[metric] ?? []), result].slice(-10);
    recentByMetric[metric] = recent;

    const confirmed = confirmConsecutive(
      recent,
      override.consecutiveBuckets ?? monitor.consecutiveBuckets,
    );
    // Direction filtering happens here rather than inside the detector: only
    // the caller knows that a GA4 rise is good news and a latency fall is too.
    const directionWanted =
      override.direction === "both" || result.direction === override.direction;

    if (confirmed && result.direction !== null && directionWanted) {
      const outcome = await engine.raiseAlert({
        fingerprint: fp,
        monitor: monitor.id,
        type: metric === "latency_ms" ? "latency" : "traffic",
        severity: override.severity,
        title: `${monitor.id} ${METRIC_LABELS[metric] ?? metric} ${result.direction}`,
        body: `${METRIC_LABELS[metric] ?? metric}=${round2(currentRow.value)}, baseline median=${round2(result.median)}, z=${result.z.toFixed(2)}, Δrel=${(result.relativeChange * 100).toFixed(1)}%.`,
        meta: {
          metric,
          z: result.z,
          median: result.median,
          relativeChange: result.relativeChange,
        },
      });
      report.actions.push({ fingerprint: fp, action: outcome.action });
    } else {
      const outcome = await engine.resolveAlert({
        fingerprint: fp,
        title: `${monitor.id} ${METRIC_LABELS[metric] ?? metric} back to normal`,
        body: `${METRIC_LABELS[metric] ?? metric}=${round2(currentRow.value)}, within baseline range.`,
      });
      if (outcome.action !== "not-found") {
        report.actions.push({ fingerprint: fp, action: outcome.action });
      }
    }
  }
  state.recentByMetric = recentByMetric;

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
