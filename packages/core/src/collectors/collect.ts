import { loadEnv, loadMonitors, type Monitor } from "../config/index.ts";
import { openDb } from "../db/client.ts";
import { metrics as metricsTable } from "../db/schema.ts";
import { createLogger } from "../logger.ts";
import { collectCloudflare } from "./cloudflare.ts";
import { collectGA4 } from "./ga4.ts";
import { checkControl, probe } from "./probe.ts";
import { checkTls, tlsTargetFor } from "./tls.ts";
import { applyProbeResult } from "../detectors/uptime.ts";
import type { CollectorMetricRow } from "./index.ts";

// One-shot collection driver. Runs probe + (if configured) cloudflare + ga4
// against every configured monitor, upserts into the metrics table, updates
// probe state, and prints a per-monitor summary. Wired as `bun run db:collect`.
//
// The scheduler (Stage 6) will call the same driver on a cron. Keeping the
// two entry points sharing this function means what you test manually with
// the CLI is exactly what runs in the worker loop.

const log = createLogger("collect");

// A certificate moves once every ~90 days; checking hourly is already
// generous. See the TLS block in collectOne().
const TLS_CHECK_INTERVAL_SECONDS = 3600;

function alignBucket(ts: number, bucketSeconds: number): number {
  return Math.floor(ts / bucketSeconds) * bucketSeconds;
}

export interface MonitorReport {
  monitor: string;
  probe?: { transition: string; latencyMs: number | null; reason: string | null };
  content?: { bodyBytes: number; forbidHits: number };
  tls?: { daysLeft: number | null; skipped: boolean; reason: string | null };
  cloudflare?: { rowCount: number; errors: number; maxSampleInterval: number };
  ga4?: { rowCount: number; errors: number };
  totalRowsWritten: number;
  fatal?: string;
}

export async function collectOne(monitor: Monitor, controlUrl: string): Promise<MonitorReport> {
  const env = loadEnv();
  const { db, sqlite } = openDb();
  const report: MonitorReport = {
    monitor: monitor.id,
    totalRowsWritten: 0,
  };
  const rows: CollectorMetricRow[] = [];
  const now = Math.floor(Date.now() / 1000);

  // ----- probe --------------------------------------------------------
  const probeResult = await probe(monitor.url, {
    timeoutMs: monitor.probeTimeoutMs,
    expectStatusBelow: monitor.expectStatusBelow,
    expectText: monitor.expectText,
    forbidText: monitor.forbidText,
  });

  // Sanity check per brief §5.4: if probe failed, verify our own outbound
  // link before declaring the site down. Failed control → don't attribute
  // the failure to the monitored site.
  if (probeResult.kind === "fail") {
    const control = await checkControl(controlUrl, 5000);
    if (!control.reachable) {
      log.warn(
        { monitor: monitor.id, controlReason: control.reason },
        "control-url unreachable — discarding probe failure",
      );
      // Present as a synthetic "no data" — do NOT update state or record.
      report.probe = {
        transition: "control-unreachable",
        latencyMs: probeResult.latencyMs ?? null,
        reason: `control unreachable: ${control.reason}`,
      };
      // Skip everything else: if our network is broken, CF/GA4 calls would
      // also fail spuriously.
      return report;
    }
  }

  // Fetch prev probe state, apply transition, persist back.
  const prevRow = sqlite
    .prepare("SELECT * FROM probe_state WHERE monitor = ?")
    .get(monitor.id) as
    | {
        consecutive_fail: number;
        consecutive_ok: number;
        is_down: number;
      }
    | undefined;
  const prev = prevRow
    ? {
        consecutiveFail: prevRow.consecutive_fail,
        consecutiveOk: prevRow.consecutive_ok,
        isDown: prevRow.is_down === 1,
      }
    : { consecutiveFail: 0, consecutiveOk: 0, isDown: false };

  const decision = applyProbeResult(prev, probeResult, {
    failThreshold: monitor.failThreshold,
    recoverThreshold: monitor.recoverThreshold,
    slowResponseMs: monitor.slowResponseMs,
  });

  sqlite
    .prepare(
      `INSERT INTO probe_state
         (monitor, consecutive_fail, consecutive_ok, is_down, last_check_at, last_status, last_latency_ms, last_error, last_body_hash, last_body_bytes, last_forbid_hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(monitor) DO UPDATE SET
         consecutive_fail = excluded.consecutive_fail,
         consecutive_ok = excluded.consecutive_ok,
         is_down = excluded.is_down,
         last_check_at = excluded.last_check_at,
         last_status = excluded.last_status,
         last_latency_ms = excluded.last_latency_ms,
         last_error = excluded.last_error,
         last_body_hash = COALESCE(excluded.last_body_hash, probe_state.last_body_hash),
         last_body_bytes = COALESCE(excluded.last_body_bytes, probe_state.last_body_bytes),
         last_forbid_hits = COALESCE(excluded.last_forbid_hits, probe_state.last_forbid_hits)`,
    )
    .run(
      monitor.id,
      decision.next.consecutiveFail,
      decision.next.consecutiveOk,
      decision.next.isDown ? 1 : 0,
      now,
      decision.status,
      decision.latencyMs,
      decision.failReason,
      probeResult.content?.bodyHash ?? null,
      probeResult.content?.bodyBytes ?? null,
      probeResult.content
        ? JSON.stringify(probeResult.content.forbidHits)
        : null,
    );

  report.probe = {
    transition: decision.transition,
    latencyMs: decision.latencyMs,
    reason: decision.failReason,
  };
  if (probeResult.content) {
    report.content = {
      bodyBytes: probeResult.content.bodyBytes,
      forbidHits: probeResult.content.forbidHits.length,
    };
  }

  // Emit latency + up metrics per bucket (aligned to configured bucketSeconds).
  const bucketTs = alignBucket(now, monitor.bucketSeconds);
  rows.push({
    monitor: monitor.id,
    source: "probe",
    metric: "latency_ms",
    bucketTs,
    value: decision.latencyMs ?? 0,
  });
  rows.push({
    monitor: monitor.id,
    source: "probe",
    metric: "up",
    bucketTs,
    value: decision.next.isDown ? 0 : 1,
  });
  // Only when we actually got a body. Writing 0 for a connection failure
  // would poison the size baseline with values that mean "no response",
  // not "empty page".
  if (probeResult.content) {
    rows.push({
      monitor: monitor.id,
      source: "probe",
      metric: "body_bytes",
      bucketTs,
      value: probeResult.content.bodyBytes,
    });
  }

  // ----- tls certificate ----------------------------------------------
  //
  // Rate-limited to once an hour per monitor. A certificate does not change
  // between two ticks, and a real TLS handshake every 60s per monitor would
  // be 1440 needless handshakes a day for a number that moves once every
  // 90 days.
  const tlsTarget = tlsTargetFor(monitor.url);
  if (tlsTarget) {
    const stateKey = `tls:${monitor.id}`;
    const lastRow = sqlite
      .prepare("SELECT value FROM system_state WHERE key = ?")
      .get(stateKey) as { value: string } | undefined;
    let lastCheckedAt = 0;
    if (lastRow?.value) {
      try {
        lastCheckedAt = (JSON.parse(lastRow.value) as { checkedAt?: number })
          .checkedAt ?? 0;
      } catch {
        lastCheckedAt = 0;
      }
    }

    if (now - lastCheckedAt < TLS_CHECK_INTERVAL_SECONDS) {
      report.tls = { daysLeft: null, skipped: true, reason: null };
    } else {
      const tls = await checkTls(tlsTarget.hostname, tlsTarget.port, {
        timeoutMs: monitor.probeTimeoutMs,
      });
      if (tls.kind === "ok") {
        rows.push({
          monitor: monitor.id,
          source: "probe",
          metric: "tls_days_left",
          bucketTs,
          value: tls.daysLeft,
        });
        report.tls = { daysLeft: tls.daysLeft, skipped: false, reason: null };
      } else {
        // A failed TLS read is not a failed site — the HTTP probe above is
        // the authority on reachability. Record the reason and move on
        // rather than writing a misleading metric value.
        report.tls = { daysLeft: null, skipped: false, reason: tls.reason };
        log.warn(
          { monitor: monitor.id, reason: tls.reason },
          "tls check failed",
        );
      }
      sqlite
        .prepare(
          `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(stateKey, JSON.stringify({ checkedAt: now }), now);
    }
  }

  // ----- cloudflare ---------------------------------------------------
  if (monitor.cloudflareZoneId) {
    if (!env.CLOUDFLARE_API_TOKEN) {
      log.warn(
        { monitor: monitor.id },
        "cloudflareZoneId configured but CLOUDFLARE_API_TOKEN missing — skipping",
      );
    } else {
      // Query the last 4 buckets, minus ingest lag. Idempotent upserts.
      const lag = monitor.ingestLagSeconds;
      const untilTs = alignBucket(now - lag, monitor.bucketSeconds);
      const sinceTs = untilTs - 4 * monitor.bucketSeconds;
      const cf = await collectCloudflare({
        zoneId: monitor.cloudflareZoneId,
        apiToken: env.CLOUDFLARE_API_TOKEN,
        monitor: monitor.id,
        sinceTs,
        untilTs,
      });
      rows.push(...cf.metrics);
      report.cloudflare = {
        rowCount: cf.metrics.length,
        errors: cf.errors.length,
        maxSampleInterval: cf.maxSampleInterval,
      };
      for (const err of cf.errors) {
        log.error({ monitor: monitor.id, ...err }, "cloudflare error");
      }
    }
  }

  // ----- ga4 ----------------------------------------------------------
  if (monitor.ga4PropertyId) {
    const ga = await collectGA4({
      propertyId: monitor.ga4PropertyId,
      monitor: monitor.id,
      bucketTs,
      keyFilename: env.GA4_SERVICE_ACCOUNT_KEY_PATH,
    });
    rows.push(...ga.metrics);
    report.ga4 = {
      rowCount: ga.metrics.length,
      errors: ga.errors.length,
    };
    for (const err of ga.errors) {
      log.error({ monitor: monitor.id, ...err }, "ga4 error");
    }
  }

  // ----- persist metrics (idempotent upsert on composite PK) ----------
  if (rows.length > 0) {
    const CHUNK = 200;
    const tx = sqlite.transaction((batch: CollectorMetricRow[]) => {
      db.insert(metricsTable)
        .values(batch)
        .onConflictDoUpdate({
          target: [
            metricsTable.monitor,
            metricsTable.source,
            metricsTable.metric,
            metricsTable.bucketTs,
          ],
          set: { value: metricsTable.value },
        })
        .run();
    });
    for (let i = 0; i < rows.length; i += CHUNK) {
      tx(rows.slice(i, i + CHUNK));
    }
    report.totalRowsWritten = rows.length;
  }

  return report;
}

/** Reusable driver used by both the CLI and the worker scheduler. */
export async function collectAllMonitors(): Promise<MonitorReport[]> {
  const config = loadMonitors();
  const reports: MonitorReport[] = [];
  for (const monitor of config.monitors) {
    try {
      const r = await collectOne(monitor, config.controlUrl);
      reports.push(r);
    } catch (err) {
      reports.push({
        monitor: monitor.id,
        totalRowsWritten: 0,
        fatal: (err as Error).message ?? String(err),
      });
    }
  }
  return reports;
}

async function main(): Promise<void> {
  const reports = await collectAllMonitors();

  // Pretty summary.
  console.log("");
  console.log("Night Watch — collect run");
  console.log("─".repeat(72));
  for (const r of reports) {
    console.log(`monitor: ${r.monitor}`);
    if (r.fatal) {
      console.log(`  ✗ fatal: ${r.fatal}`);
      continue;
    }
    if (r.probe) {
      console.log(
        `  probe:      ${r.probe.transition}  latency=${r.probe.latencyMs ?? "-"}ms  ${r.probe.reason ? "reason=" + r.probe.reason : ""}`,
      );
    }
    if (r.content) {
      console.log(
        `  content:    ${r.content.bodyBytes} bytes  forbidden hits=${r.content.forbidHits}`,
      );
    }
    if (r.tls) {
      console.log(
        `  tls:        ${r.tls.skipped ? "skipped (checked within the hour)" : r.tls.reason ? "failed: " + r.tls.reason : r.tls.daysLeft + " days left"}`,
      );
    }
    if (r.cloudflare) {
      console.log(
        `  cloudflare: rows=${r.cloudflare.rowCount}  errors=${r.cloudflare.errors}  sampleInterval≤${r.cloudflare.maxSampleInterval}`,
      );
    }
    if (r.ga4) {
      console.log(`  ga4:        rows=${r.ga4.rowCount}  errors=${r.ga4.errors}`);
    }
    console.log(`  total written: ${r.totalRowsWritten}`);
  }
  console.log("─".repeat(72));
  console.log("");

  const hadFatal = reports.some((r) => r.fatal);
  process.exit(hadFatal ? 1 : 0);
}

// Only run the CLI when invoked directly (bun run …/collect.ts), never when
// imported by the worker.
if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
