import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export type MetricName =
  | "cf_requests"
  | "cf_bytes"
  | "cf_threats"
  | "cf_status_5xx"
  | "cf_status_4xx"
  | "cf_status_429"
  | "cf_cache_miss"
  | "ga_active_users"
  | "ga_page_views"
  | "latency_ms"
  | "up";

export const METRIC_NAMES = [
  "cf_requests",
  "cf_bytes",
  "cf_threats",
  "cf_status_5xx",
  "cf_status_4xx",
  "cf_status_429",
  "cf_cache_miss",
  "ga_active_users",
  "ga_page_views",
  "latency_ms",
  "up",
] as const satisfies readonly MetricName[];

export type MetricSource = "cloudflare" | "ga4" | "probe" | "internal";
export type AlertSeverity = "critical" | "warning" | "info";
export type AlertStatus = "firing" | "resolved";
export type AlertType = "traffic" | "uptime" | "ddos" | "latency";
export type Channel = "push" | "whatsapp";
export type DeliveryStatus = "sent" | "failed" | "skipped";
export type CommandStatus = "pending" | "done" | "failed";
export type CommandKind = "test_alert" | "wa_relink";

// Time-series metrics. The composite PK + WITHOUT ROWID (declared in the initial
// migration) is what makes upserts idempotent and storage compact.
export const metrics = sqliteTable(
  "metrics",
  {
    monitor: text("monitor").notNull(),
    source: text("source").$type<MetricSource>().notNull(),
    metric: text("metric").$type<MetricName>().notNull(),
    bucketTs: integer("bucket_ts").notNull(),
    value: real("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.monitor, t.source, t.metric, t.bucketTs] }),
    index("metrics_monitor_metric_ts").on(t.monitor, t.metric, t.bucketTs),
  ],
);

// Alerts are a state machine. The partial unique index on (fingerprint) WHERE status='firing'
// is what structurally prevents two open alerts for the same fingerprint — without it we'd
// need application-level locking and would still race.
export const alerts = sqliteTable(
  "alerts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fingerprint: text("fingerprint").notNull(),
    monitor: text("monitor").notNull(),
    type: text("type").$type<AlertType>().notNull(),
    severity: text("severity").$type<AlertSeverity>().notNull(),
    status: text("status").$type<AlertStatus>().notNull().default("firing"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
    startedAt: integer("started_at").notNull(),
    lastNotifiedAt: integer("last_notified_at"),
    notifyCount: integer("notify_count").notNull().default(0),
    resolvedAt: integer("resolved_at"),
  },
  (t) => [
    uniqueIndex("alerts_firing_fp")
      .on(t.fingerprint)
      .where(sql`${t.status} = 'firing'`),
    index("alerts_status").on(t.status, t.startedAt),
  ],
);

export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  label: text("label"),
  createdAt: integer("created_at").notNull(),
  lastOkAt: integer("last_ok_at"),
  failCount: integer("fail_count").notNull().default(0),
});

export const probeState = sqliteTable("probe_state", {
  monitor: text("monitor").primaryKey(),
  consecutiveFail: integer("consecutive_fail").notNull().default(0),
  consecutiveOk: integer("consecutive_ok").notNull().default(0),
  isDown: integer("is_down", { mode: "boolean" }).notNull().default(false),
  lastCheckAt: integer("last_check_at"),
  lastStatus: integer("last_status"),
  lastLatencyMs: integer("last_latency_ms"),
  lastError: text("last_error"),
});

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    alertId: integer("alert_id")
      .notNull()
      .references(() => alerts.id),
    channel: text("channel").$type<Channel>().notNull(),
    status: text("status").$type<DeliveryStatus>().notNull(),
    detail: text("detail"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("deliveries_alert").on(t.alertId, t.createdAt)],
);

export const commands = sqliteTable(
  "commands",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").$type<CommandKind>().notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    status: text("status").$type<CommandStatus>().notNull().default("pending"),
    createdAt: integer("created_at").notNull(),
    processedAt: integer("processed_at"),
    error: text("error"),
  },
  (t) => [index("commands_pending").on(t.status, t.createdAt)],
);

export const systemState = sqliteTable("system_state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>(),
  updatedAt: integer("updated_at").notNull(),
});
