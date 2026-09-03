import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  getActiveAlerts,
  getActiveSnoozes,
  getAlertHistory,
  getBotSeries,
  getMonitors,
  getPulse,
  getPushHealth,
  getSeries,
  getStatus,
  getRecentAlertCount,
  getSystemHealth,
  getUptime,
} from "@night-watch/core/web";
import {
  enqueueCommand,
  subscribePush,
  unsubscribePush,
} from "@night-watch/core/web";
import { openDb, loadEnv, loadMonitors, METRIC_NAMES } from "@night-watch/core";
import { authMiddleware } from "./auth";

// Server functions the dashboard calls. All reads go through queries.ts,
// writes go through mutations.ts — that pair is the enforcement mechanism
// for brief §7 ("web can only write to push_subscriptions and commands").

// -----------------------------------------------------------------------
// READS
// -----------------------------------------------------------------------

export const fetchStatus = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .handler(async () => {
  const { db } = openDb();
  return getStatus(db);
});

export const fetchActiveAlerts = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .handler(
  async () => {
    const { db } = openDb();
    return getActiveAlerts(db);
  },
);

export const fetchAlertHistory = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .validator(z.object({ limit: z.number().int().positive().max(200).default(25) }))
  .handler(async ({ data }) => {
    const { db } = openDb();
    return getAlertHistory(db, data.limit);
  });

const SeriesInput = z.object({
  monitor: z.string().min(1),
  source: z.enum(["cloudflare", "ga4", "probe", "internal"]),
  // Derived from the single source of truth rather than re-listed here: the
  // hand-copied version had already drifted two names behind schema.ts.
  metric: z.enum(METRIC_NAMES),
  hours: z.number().int().positive().max(168).default(6),
});

export const fetchSeries = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .validator(SeriesInput)
  .handler(async ({ data }) => {
    const { db } = openDb();
    return getSeries(db, data);
  });

/** Bot / human / verified-bot request volume for one monitor's detail page. */
export const fetchBotSeries = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .validator(
    z.object({
      monitor: z.string().min(1),
      hours: z.number().int().positive().max(168).default(24),
    }),
  )
  .handler(async ({ data }) => {
    const { db } = openDb();
    return getBotSeries(db, data);
  });

export const fetchMonitors = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .handler(async () => {
  const { db } = openDb();
  const cfg = loadMonitors();
  // Config carries the human label, the URL, and the thresholds the detectors
  // compare against. Without it the dashboard can only show slugs and would
  // have to hard-code 3000ms / 10% / 15%.
  return getMonitors(db, cfg.monitors);
});

/**
 * Chart data for one monitor, scored with that monitor's own detector tuning.
 * Replaces the card's `fetchSeries` call: one round trip carries the traffic
 * series, its baseline band, and the three threshold signals.
 */
export const fetchPulse = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .validator(
    z.object({
      monitor: z.string().min(1),
      hours: z.number().int().positive().max(168).default(6),
    }),
  )
  .handler(async ({ data }) => {
    const { db, sqlite } = openDb();
    const cfg = loadMonitors();
    const monitor = cfg.monitors.find((m) => m.id === data.monitor);
    if (!monitor) {
      throw new Error(`unknown monitor: ${data.monitor}`);
    }
    return getPulse(db, sqlite, monitor, { hours: data.hours });
  });

/** Push subscription health — how many devices quietly stopped receiving. */
export const fetchPushHealth = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .handler(async () => {
    const { db } = openDb();
    return getPushHealth(db);
  });

/** Global "N alerts in the last 24h" — one number, all monitors. */
export const fetchRecentAlertCount = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .handler(async () => {
    const { db } = openDb();
    return { count: getRecentAlertCount(db, 24), hours: 24 };
  });

/**
 * Uptime ratios for one monitor. Separate from fetchPulse: the pulse window is
 * hours, this one reaches back 30 days, and pairing them in one round trip
 * would make the card wait on the chart.
 */
export const fetchUptime = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .validator(z.object({ monitor: z.string().min(1) }))
  .handler(async ({ data }) => {
    const { db } = openDb();
    return getUptime(db, data.monitor);
  });

export const fetchSystemHealth = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .handler(async () => {
  const { db } = openDb();
  const env = loadEnv();
  const cfg = loadMonitors();
  return getSystemHealth(db, {
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
    timezone: cfg.timezone,
    quietHours: cfg.quietHours,
  });
});

export const fetchSnoozes = createServerFn({ method: "GET", strict: { output: false } })
  .middleware([authMiddleware])
  .handler(async () => {
  const { sqlite } = openDb();
  const cfg = loadMonitors();
  return getActiveSnoozes(
    sqlite,
    cfg.monitors.map((m) => ({
      id: m.id,
      maintenanceWindows: m.maintenanceWindows,
    })),
  );
});

// -----------------------------------------------------------------------
// WRITES (the two allowed tables only)
// -----------------------------------------------------------------------

export const doSubscribePush = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      endpoint: z.string().url(),
      p256dh: z.string().min(1),
      auth: z.string().min(1),
      label: z.string().max(120).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { db } = openDb();
    return subscribePush(db, data);
  });

export const doUnsubscribePush = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(z.object({ endpoint: z.string().url() }))
  .handler(async ({ data }) => {
    const { db } = openDb();
    return unsubscribePush(db, data.endpoint);
  });

export const doEnqueueCommand = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    z.object({
      kind: z.enum([
        "test_alert",
        "wa_relink",
        "snooze",
        "unsnooze",
        "ack",
        "unack",
      ]),
      payload: z.record(z.string(), z.unknown()).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { sqlite } = openDb();
    return enqueueCommand(sqlite, data.kind, data.payload);
  });
