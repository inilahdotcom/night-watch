import { and, eq } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import { alerts, deliveries, pushSubscriptions } from "../db/schema.ts";
import { createLogger } from "../logger.ts";
import { renderAlert } from "./render.ts";
import { isQuietAt, type QuietWindow } from "./quiet-hours.ts";
import type {
  AlertInput,
  DeliveryResult,
  NotificationChannel,
  RenderedAlert,
  ResolveInput,
} from "./types.ts";
import type { Database } from "bun:sqlite";

// The alert state machine (brief §6). Two public functions, both idempotent:
//
//   raiseAlert(input)   — create a firing row if none exists; otherwise
//                         update details. Re-notify ONLY on escalation
//                         warning→critical, or on critical whose last
//                         notification is older than `cooldownMinutes`.
//
//   resolveAlert(input) — close a firing row and (if configured) fan out
//                         a recovery notification to the same channels.
//
// Idempotency is enforced structurally by the `alerts_firing_fp` partial
// unique index in the schema: at most one firing row per fingerprint.

export interface AlertEngineConfig {
  db: DB;
  sqlite: Database;
  channels: readonly NotificationChannel[];
  cooldownMinutes: number;
  notifyOnResolve: boolean;
  quietHours: QuietWindow | null;
  utcOffsetHours: number;
  timezoneLabel?: string;
  /** Injectable clock (unix seconds). Defaults to Date.now/1000. */
  now?: () => number;
  /**
   * Optional per-monitor maintenance / snooze check. When it returns
   * `suppressed: true`, `deliver()` records every channel as skipped
   * (with `maintenance: <reason>` detail) and returns early — except
   * for resolves, which always break through.
   */
  getMaintenanceStatus?: (
    monitorId: string,
    nowSeconds: number,
  ) => { suppressed: boolean; reason?: string };
}

export type AlertAction =
  | "created"
  | "updated-silent"
  | "updated-notified"
  | "escalated"
  | "resolved"
  | "not-found";

export interface AlertOutcome {
  alertId: number | null;
  action: AlertAction;
  channelResults: Array<{
    channel: string;
    result: DeliveryResult;
  }>;
}

interface StoredAlertRow {
  id: number;
  fingerprint: string;
  monitor: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  body: string;
  meta: string | null;
  started_at: number;
  last_notified_at: number | null;
  notify_count: number;
  resolved_at: number | null;
}

export interface AlertEngine {
  raiseAlert(input: AlertInput): Promise<AlertOutcome>;
  resolveAlert(input: ResolveInput): Promise<AlertOutcome>;
}

export function createAlertEngine(config: AlertEngineConfig): AlertEngine {
  const log = createLogger("alerts");
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));

  const selectFiring = config.sqlite.prepare(
    "SELECT * FROM alerts WHERE fingerprint = ? AND status = 'firing' LIMIT 1",
  );
  const insertAlertStmt = config.sqlite.prepare(
    `INSERT INTO alerts (fingerprint, monitor, type, severity, status, title, body, meta, started_at, last_notified_at, notify_count)
     VALUES (?, ?, ?, ?, 'firing', ?, ?, ?, ?, NULL, 0)
     RETURNING id`,
  );
  const updateAlertDetailsStmt = config.sqlite.prepare(
    "UPDATE alerts SET title = ?, body = ?, meta = ?, severity = ? WHERE id = ?",
  );
  const markNotifiedStmt = config.sqlite.prepare(
    "UPDATE alerts SET last_notified_at = ?, notify_count = notify_count + 1 WHERE id = ?",
  );
  const markResolvedStmt = config.sqlite.prepare(
    "UPDATE alerts SET status = 'resolved', resolved_at = ? WHERE id = ?",
  );

  function readStored(id: number): StoredAlertRow {
    const row = config.sqlite
      .prepare("SELECT * FROM alerts WHERE id = ?")
      .get(id) as StoredAlertRow | undefined;
    if (!row) throw new Error(`alert ${id} not found immediately after write`);
    return row;
  }

  function render(row: StoredAlertRow): RenderedAlert {
    return renderAlert(
      {
        id: row.id,
        fingerprint: row.fingerprint,
        monitor: row.monitor,
        type: row.type as RenderedAlert["type"],
        severity: row.severity as RenderedAlert["severity"],
        status: row.status as "firing" | "resolved",
        title: row.title,
        body: row.body,
        meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {},
        startedAt: row.started_at,
        resolvedAt: row.resolved_at,
      },
      { utcOffsetHours: config.utcOffsetHours, timezoneLabel: config.timezoneLabel },
    );
  }

  async function deliver(
    rendered: RenderedAlert,
  ): Promise<AlertOutcome["channelResults"]> {
    const results: AlertOutcome["channelResults"] = [];
    const nowTs = now();

    // Maintenance / snooze: suppress every channel for firing alerts.
    // Resolves always break through — the operator wants to know "we're back".
    if (rendered.status !== "resolved" && config.getMaintenanceStatus) {
      const m = config.getMaintenanceStatus(rendered.monitor, nowTs);
      if (m.suppressed) {
        const reason = m.reason ?? "active";
        const detail = `maintenance: ${reason}`;
        log.info(
          { monitor: rendered.monitor, alertId: rendered.id, reason },
          "alert suppressed by maintenance window / snooze",
        );
        for (const channel of config.channels) {
          recordDelivery(rendered.id, channel.name, "skipped", detail);
          results.push({
            channel: channel.name,
            result: { ok: false, detail: `skipped: ${detail}` },
          });
        }
        return results;
      }
    }

    const isQuiet =
      config.quietHours !== null &&
      isQuietAt(nowTs, config.quietHours, config.utcOffsetHours);

    for (const channel of config.channels) {
      const isRecovery = rendered.status === "resolved";
      const isCritical = rendered.severity === "critical" && !isRecovery;

      // Quiet hours: only mute WhatsApp for non-critical alerts. Critical
      // always breaks through, per brief §6.
      if (
        channel.name === "whatsapp" &&
        !isCritical &&
        isQuiet
      ) {
        recordDelivery(rendered.id, "whatsapp", "skipped", "quiet hours");
        results.push({
          channel: "whatsapp",
          result: { ok: false, detail: "skipped: quiet hours" },
        });
        continue;
      }

      if (!channel.isReady()) {
        recordDelivery(rendered.id, channel.name, "skipped", "channel not ready");
        results.push({
          channel: channel.name,
          result: { ok: false, detail: "channel not ready" },
        });
        continue;
      }

      try {
        const r = await channel.send(rendered);
        recordDelivery(
          rendered.id,
          channel.name,
          r.ok ? "sent" : "failed",
          r.detail,
        );
        if (r.removeSubscriptionIds?.length) {
          for (const subId of r.removeSubscriptionIds) {
            try {
              config.db
                .delete(pushSubscriptions)
                .where(eq(pushSubscriptions.id, subId))
                .run();
            } catch (err) {
              log.warn(
                { subId, err: (err as Error).message },
                "failed to drop stale push subscription",
              );
            }
          }
        }
        results.push({ channel: channel.name, result: r });
      } catch (err) {
        const detail = (err as Error).message ?? String(err);
        recordDelivery(rendered.id, channel.name, "failed", detail);
        results.push({
          channel: channel.name,
          result: { ok: false, detail },
        });
      }
    }
    return results;
  }

  function recordDelivery(
    alertId: number,
    channel: string,
    status: "sent" | "failed" | "skipped",
    detail: string,
  ): void {
    config.db
      .insert(deliveries)
      .values({
        alertId,
        channel: channel as "push" | "whatsapp",
        status,
        detail,
        createdAt: now(),
      })
      .run();
  }

  return {
    async raiseAlert(input) {
      const existing = selectFiring.get(input.fingerprint) as
        | StoredAlertRow
        | undefined;

      if (existing) {
        // Update details in-place (title/body/meta may have refined).
        updateAlertDetailsStmt.run(
          input.title,
          input.body,
          input.meta ? JSON.stringify(input.meta) : null,
          input.severity,
          existing.id,
        );

        const nowTs = now();
        const escalated =
          existing.severity !== "critical" && input.severity === "critical";
        const cooledDown =
          input.severity === "critical" &&
          existing.last_notified_at !== null &&
          nowTs - existing.last_notified_at >= config.cooldownMinutes * 60;

        if (!escalated && !cooledDown) {
          return {
            alertId: existing.id,
            action: "updated-silent",
            channelResults: [],
          };
        }

        const stored = readStored(existing.id);
        const rendered = render(stored);
        const results = await deliver(rendered);
        markNotifiedStmt.run(now(), existing.id);
        return {
          alertId: existing.id,
          action: escalated ? "escalated" : "updated-notified",
          channelResults: results,
        };
      }

      // New alert: insert then notify.
      const inserted = insertAlertStmt.get(
        input.fingerprint,
        input.monitor,
        input.type,
        input.severity,
        input.title,
        input.body,
        input.meta ? JSON.stringify(input.meta) : null,
        now(),
      ) as { id: number };

      const stored = readStored(inserted.id);
      const rendered = render(stored);
      const results = await deliver(rendered);
      markNotifiedStmt.run(now(), inserted.id);
      return {
        alertId: inserted.id,
        action: "created",
        channelResults: results,
      };
    },

    async resolveAlert(input) {
      const existing = selectFiring.get(input.fingerprint) as
        | StoredAlertRow
        | undefined;
      if (!existing) {
        return { alertId: null, action: "not-found", channelResults: [] };
      }

      markResolvedStmt.run(now(), existing.id);

      if (!config.notifyOnResolve) {
        return { alertId: existing.id, action: "resolved", channelResults: [] };
      }

      const stored = readStored(existing.id);
      // Allow the caller to override the recovery title/body while
      // preserving severity/type/monitor from the original record.
      if (input.title) stored.title = input.title;
      if (input.body) stored.body = input.body;
      const rendered = render(stored);
      const results = await deliver(rendered);
      return {
        alertId: existing.id,
        action: "resolved",
        channelResults: results,
      };
    },
  };
}

/** Convenience: current active alerts, most-recent first. Useful for the web dashboard. */
export function listActiveAlerts(db: DB) {
  return db
    .select()
    .from(alerts)
    .where(and(eq(alerts.status, "firing")))
    .all();
}
