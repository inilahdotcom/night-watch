-- Content integrity (defacement / SEO-injection detection).
--
-- The probe already reads the response body for `expectText`, so hashing it
-- and scanning for forbidden terms costs no extra network. What we need is
-- somewhere to remember the last reading per monitor.
--
-- `last_body_hash` is kept for forensics ("when did this page last change?"),
-- deliberately NOT as an alert trigger: a news portal's HTML changes every
-- minute, so hash-change alerting would fire constantly and be muted within a
-- week. `last_body_bytes` mirrors the `body_bytes` metric so a card can show
-- the current reading without a metrics scan.

-- `last_forbid_hits` is a JSON array of the terms matched on the most recent
-- probe. It lives in probe_state rather than being passed in memory because
-- the collector and the analysis cycle are separate steps that communicate
-- only through the database — the same reason uptime state lives here.

ALTER TABLE probe_state ADD COLUMN last_body_hash TEXT;
ALTER TABLE probe_state ADD COLUMN last_body_bytes INTEGER;
ALTER TABLE probe_state ADD COLUMN last_forbid_hits TEXT;
