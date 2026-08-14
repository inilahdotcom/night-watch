import type { Database } from "bun:sqlite";

// Snooze & maintenance windows — the "shush this alert" surface.
//
// Two mechanisms, one hook point (engine.deliver):
//
//   1. Recurring maintenance windows — declared per-monitor in monitors.json
//      like quietHours: {start:"02:00", end:"04:00", daysOfWeek:[0]}.
//      Static; loaded once at boot; evaluated against the local wall clock.
//
//   2. Ad-hoc snoozes — operator clicks "Snooze 15m" in the dashboard. The
//      command outbox flows this into `system_state` keyed by scope. Absolute
//      `endsAt` (unix seconds) so no cron cleanup needed — expired entries
//      simply stop suppressing.
//
// During an active window: the alert row is still inserted, but every channel
// delivery is recorded as skipped with detail `maintenance: <reason>`. Resolve
// notifications always break through (operator wants to know "we're back").

export interface MaintenanceWindow {
  /** "HH:MM" local time, inclusive. */
  start: string;
  /** "HH:MM" local time, exclusive. Set > start to cross midnight. */
  end: string;
  /** 0=Sun..6=Sat. Omit or empty array = every day. */
  daysOfWeek?: number[];
}

export type SnoozeScope = "global" | { monitor: string };

export interface AdhocSnooze {
  scope: SnoozeScope;
  /** Unix seconds. */
  startedAt: number;
  /** Unix seconds. Absolute — engine checks `now < endsAt`. */
  endsAt: number;
  reason?: string;
}

const SNOOZE_KEY_GLOBAL = "snooze:global";
const SNOOZE_KEY_MONITOR_PREFIX = "snooze:monitor:";

// --------------------------------------------------------------------------
// Recurring window match
// --------------------------------------------------------------------------

/**
 * True if `unixSeconds` falls inside the window in the given local timezone.
 * Same overnight-window handling as quiet-hours (start > end means the window
 * wraps midnight). If `daysOfWeek` is set, the LOCAL day must be listed.
 *
 * For overnight windows we check the day at the *start* boundary — a window
 * "22:00-02:00 dow=[5]" (Fri night) fires when local time is 22:30 on Fri
 * and 01:30 on Sat.
 */
export function isInMaintenanceAt(
  unixSeconds: number,
  window: MaintenanceWindow,
  utcOffsetHours: number,
): boolean {
  const localSeconds = unixSeconds + utcOffsetHours * 3600;
  const secondsOfDay = ((localSeconds % 86400) + 86400) % 86400;
  const minutesOfDay = Math.floor(secondsOfDay / 60);
  const localDay = Math.floor(localSeconds / 86400);
  const dow = ((localDay % 7) + 7 + 4) % 7; // 1970-01-01 was Thursday (4).

  const startMinutes = parseHHMM(window.start);
  const endMinutes = parseHHMM(window.end);
  if (startMinutes === endMinutes) return false; // zero-width = never

  const inWindow =
    startMinutes < endMinutes
      ? minutesOfDay >= startMinutes && minutesOfDay < endMinutes
      : minutesOfDay >= startMinutes || minutesOfDay < endMinutes;
  if (!inWindow) return false;

  if (!window.daysOfWeek || window.daysOfWeek.length === 0) return true;
  const anchorDow =
    startMinutes < endMinutes || minutesOfDay >= startMinutes
      ? dow
      : (dow + 6) % 7; // wrap: attribute the tail to the day we started
  return window.daysOfWeek.includes(anchorDow);
}

function parseHHMM(spec: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(spec);
  if (!match) throw new Error(`invalid HH:MM value "${spec}"`);
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) throw new Error(`out-of-range HH:MM value "${spec}"`);
  return h * 60 + m;
}

// --------------------------------------------------------------------------
// Ad-hoc snooze storage (system_state KV)
// --------------------------------------------------------------------------

interface StoredSnoozeRow {
  key: string;
  value: string | null;
}

function scopeKey(scope: SnoozeScope): string {
  return scope === "global"
    ? SNOOZE_KEY_GLOBAL
    : `${SNOOZE_KEY_MONITOR_PREFIX}${scope.monitor}`;
}

function keyScope(key: string): SnoozeScope | null {
  if (key === SNOOZE_KEY_GLOBAL) return "global";
  if (key.startsWith(SNOOZE_KEY_MONITOR_PREFIX)) {
    return { monitor: key.slice(SNOOZE_KEY_MONITOR_PREFIX.length) };
  }
  return null;
}

/**
 * All snoozes still active (`endsAt > now`). Callers get a fresh read each
 * time — cheap SELECT, and the command processor can update whenever.
 */
export function readActiveSnoozes(
  sqlite: Database,
  nowSeconds: number,
): AdhocSnooze[] {
  const rows = sqlite
    .prepare(
      "SELECT key, value FROM system_state WHERE key = ? OR key LIKE ?",
    )
    .all(SNOOZE_KEY_GLOBAL, `${SNOOZE_KEY_MONITOR_PREFIX}%`) as StoredSnoozeRow[];

  const out: AdhocSnooze[] = [];
  for (const row of rows) {
    if (!row.value) continue;
    const scope = keyScope(row.key);
    if (!scope) continue;
    let parsed: { endsAt?: number; startedAt?: number; reason?: string };
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (typeof parsed.endsAt !== "number" || parsed.endsAt <= nowSeconds) continue;
    out.push({
      scope,
      startedAt: parsed.startedAt ?? nowSeconds,
      endsAt: parsed.endsAt,
      reason: parsed.reason,
    });
  }
  return out;
}

/** UPSERT the snooze row keyed by scope. */
export function writeSnooze(sqlite: Database, snooze: AdhocSnooze): void {
  const key = scopeKey(snooze.scope);
  const value = JSON.stringify({
    startedAt: snooze.startedAt,
    endsAt: snooze.endsAt,
    reason: snooze.reason,
  });
  sqlite
    .prepare(
      `INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, snooze.startedAt);
}

/** Delete the snooze row for the given scope. Safe to call when absent. */
export function clearSnooze(sqlite: Database, scope: SnoozeScope): void {
  sqlite.prepare("DELETE FROM system_state WHERE key = ?").run(scopeKey(scope));
}

// --------------------------------------------------------------------------
// Combined evaluation (what engine.deliver calls)
// --------------------------------------------------------------------------

export type SnoozeResult =
  | { suppressed: true; reason: string }
  | { suppressed: false };

/**
 * Compact "should we mute alerts for this monitor right now?" answer.
 * Checks ad-hoc snoozes first (global then per-monitor), then recurring
 * windows. First match wins; the returned `reason` is short and safe to
 * put in a `deliveries.detail` cell.
 */
export function isSnoozedNow(
  monitorId: string,
  nowSeconds: number,
  adhoc: readonly AdhocSnooze[],
  windows: readonly MaintenanceWindow[],
  utcOffsetHours: number,
): SnoozeResult {
  for (const s of adhoc) {
    if (s.scope === "global") {
      return { suppressed: true, reason: shortReason("adhoc-global", s, nowSeconds) };
    }
    if (typeof s.scope === "object" && s.scope.monitor === monitorId) {
      return { suppressed: true, reason: shortReason("adhoc-monitor", s, nowSeconds) };
    }
  }
  for (const w of windows) {
    if (isInMaintenanceAt(nowSeconds, w, utcOffsetHours)) {
      const label = `${w.start}-${w.end}`;
      return { suppressed: true, reason: `window ${label}` };
    }
  }
  return { suppressed: false };
}

function shortReason(kind: string, s: AdhocSnooze, nowSeconds: number): string {
  const remain = Math.max(0, s.endsAt - nowSeconds);
  const suffix = s.reason ? ` (${s.reason.slice(0, 60)})` : "";
  return `${kind} ${remain}s left${suffix}`;
}
