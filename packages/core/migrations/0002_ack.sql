-- Alert acknowledgement.
--
-- Without this, a firing critical keeps re-notifying every
-- ALERT_COOLDOWN_MINUTES even while someone is actively working on it — the
-- alert has no way to represent "seen, in hand". `acked_at` gates the cooldown
-- re-notify only; escalation from warning to critical still breaks through,
-- because acknowledging a warning must never silence its promotion.

ALTER TABLE alerts ADD COLUMN acked_at INTEGER;
ALTER TABLE alerts ADD COLUMN acked_by TEXT;
