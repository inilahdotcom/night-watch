// Deterministic pattern primitives for the synthetic seed. Everything here is
// pure — same seed in, same time series out — so the demo output is stable
// across reruns and we can put unit tests around the shapes.
//
// Kept in Asia/Jakarta (WIB, UTC+7) by default: business peaks near noon
// local, evening bump around 8pm, trough around 3am. Weekends run at ~65%
// of the weekday shape.

// ---------------------------------------------------------------------------
// PRNG — Mulberry32. Small, decent quality, no dependency.
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller. Use a stateless (throw-away) draw — good enough for shaping
// noise, not for cryptography.
export function gaussian(
  rand: () => number,
  mean = 0,
  stddev = 1,
): number {
  const u1 = Math.max(rand(), 1e-9); // avoid log(0)
  const u2 = rand();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + stddev * z;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;

/**
 * Returns local-time (hour-of-day, day-of-week) for a unix-seconds timestamp
 * under a fixed UTC offset (in hours). We don't want real DST — the seed is
 * synthetic — so a static offset is honest and reproducible.
 */
export function localHourAndDow(
  bucketTs: number,
  utcOffsetHours: number,
): { hour: number; dow: number } {
  const shifted = bucketTs + utcOffsetHours * SECONDS_PER_HOUR;
  const totalHours = Math.floor(shifted / SECONDS_PER_HOUR);
  const hour = ((totalHours % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
  // Unix epoch (1970-01-01) is Thursday → dow=4 in Sun=0 convention
  const totalDays = Math.floor(shifted / (HOURS_PER_DAY * SECONDS_PER_HOUR));
  const dow = ((totalDays + 4) % 7 + 7) % 7;
  return { hour, dow };
}

// ---------------------------------------------------------------------------
// Shape functions
// ---------------------------------------------------------------------------

/**
 * Daily traffic shape. Returns a multiplier in roughly [0.15, 1.0] for the
 * given hour of day (0..23). Two Gaussian bumps — daytime work + evening
 * scroll — over a low nighttime floor.
 */
export function dailyShape(hour: number): number {
  const workBump = 0.55 * Math.exp(-Math.pow((hour - 13) / 4, 2));
  const eveningBump = 0.35 * Math.exp(-Math.pow((hour - 20) / 2.5, 2));
  const floor = 0.15;
  return floor + workBump + eveningBump;
}

/**
 * Weekly multiplier. Weekdays = 1.0, Sat/Sun = ~0.65. dow: Sun=0..Sat=6.
 */
export function weeklyShape(dow: number): number {
  return dow === 0 || dow === 6 ? 0.65 : 1.0;
}

/**
 * Combined mean value at time t: baseline × daily × weekly, with optional
 * per-bucket multiplicative noise. Baseline is expressed in the same unit
 * as the metric (e.g. requests per 5-min bucket at peak).
 */
export function meanValueAt(
  bucketTs: number,
  peakBaseline: number,
  utcOffsetHours: number,
): number {
  const { hour, dow } = localHourAndDow(bucketTs, utcOffsetHours);
  return peakBaseline * dailyShape(hour) * weeklyShape(dow);
}
