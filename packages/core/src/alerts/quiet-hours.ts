// "22:00-07:00" style quiet-hours window. Fixed timezone offset in hours —
// no DST math on purpose. The alert engine consults this before sending
// non-critical WhatsApp; critical alerts always break through.

export interface QuietWindow {
  startMinutes: number; // minutes since local midnight, inclusive
  endMinutes: number; // exclusive
}

/**
 * Parse "HH:MM-HH:MM" into local-minute offsets. Returns null for null/undefined
 * input (i.e. "no quiet hours configured"). Throws on malformed input — the
 * config loader catches this at boot rather than letting it explode at 3am.
 */
export function parseQuietHours(spec: string | null | undefined): QuietWindow | null {
  if (!spec) return null;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(spec);
  if (!match) {
    throw new Error(`invalid quiet-hours spec "${spec}" (expected HH:MM-HH:MM)`);
  }
  const [, sh, sm, eh, em] = match;
  const startMinutes = Number(sh) * 60 + Number(sm);
  const endMinutes = Number(eh) * 60 + Number(em);
  if (startMinutes === endMinutes) {
    // Same start/end = zero-width window, effectively "always awake". Treat
    // as no quiet hours so the caller doesn't accidentally mute forever.
    return null;
  }
  return { startMinutes, endMinutes };
}

/**
 * True if `unixSeconds` falls inside the quiet window when interpreted in
 * `utcOffsetHours` local time. Windows that cross midnight (start > end)
 * are handled by inverting the check.
 */
export function isQuietAt(
  unixSeconds: number,
  window: QuietWindow,
  utcOffsetHours: number,
): boolean {
  const localSeconds = unixSeconds + utcOffsetHours * 3600;
  const secondsOfDay = ((localSeconds % 86400) + 86400) % 86400;
  const minutesOfDay = Math.floor(secondsOfDay / 60);

  if (window.startMinutes < window.endMinutes) {
    return minutesOfDay >= window.startMinutes && minutesOfDay < window.endMinutes;
  }
  // Overnight window (e.g. 22:00-07:00): quiet from start-of-day OR up to end
  return (
    minutesOfDay >= window.startMinutes || minutesOfDay < window.endMinutes
  );
}
