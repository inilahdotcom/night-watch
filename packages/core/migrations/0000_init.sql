-- Initial schema. Hand-written (not drizzle-kit generated) because SQLite
-- specifics we need — WITHOUT ROWID on metrics and the partial unique index
-- on alerts — aren't cleanly expressed by drizzle-kit's SQL generator.
-- Keep this in sync with packages/core/src/db/schema.ts.

CREATE TABLE metrics (
  monitor   TEXT    NOT NULL,
  source    TEXT    NOT NULL,
  metric    TEXT    NOT NULL,
  bucket_ts INTEGER NOT NULL,
  value     REAL    NOT NULL,
  PRIMARY KEY (monitor, source, metric, bucket_ts)
) WITHOUT ROWID;

CREATE INDEX metrics_monitor_metric_ts
  ON metrics(monitor, metric, bucket_ts DESC);

CREATE TABLE alerts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint       TEXT    NOT NULL,
  monitor           TEXT    NOT NULL,
  type              TEXT    NOT NULL,
  severity          TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'firing',
  title             TEXT    NOT NULL,
  body              TEXT    NOT NULL,
  meta              TEXT,
  started_at        INTEGER NOT NULL,
  last_notified_at  INTEGER,
  notify_count      INTEGER NOT NULL DEFAULT 0,
  resolved_at       INTEGER
);

-- Structurally prevents two firing rows for the same fingerprint.
CREATE UNIQUE INDEX alerts_firing_fp
  ON alerts(fingerprint) WHERE status = 'firing';

CREATE INDEX alerts_status
  ON alerts(status, started_at DESC);

CREATE TABLE push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint    TEXT    NOT NULL UNIQUE,
  p256dh      TEXT    NOT NULL,
  auth        TEXT    NOT NULL,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  last_ok_at  INTEGER,
  fail_count  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE probe_state (
  monitor           TEXT    PRIMARY KEY,
  consecutive_fail  INTEGER NOT NULL DEFAULT 0,
  consecutive_ok    INTEGER NOT NULL DEFAULT 0,
  is_down           INTEGER NOT NULL DEFAULT 0,
  last_check_at     INTEGER,
  last_status       INTEGER,
  last_latency_ms   INTEGER,
  last_error        TEXT
);

CREATE TABLE deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id    INTEGER NOT NULL REFERENCES alerts(id),
  channel     TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX deliveries_alert
  ON deliveries(alert_id, created_at DESC);

CREATE TABLE commands (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,
  payload       TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  processed_at  INTEGER,
  error         TEXT
);

CREATE INDEX commands_pending
  ON commands(status, created_at);

CREATE TABLE system_state (
  key         TEXT    PRIMARY KEY,
  value       TEXT,
  updated_at  INTEGER NOT NULL
);
