// Assembles the baseline sample set the traffic detector compares against.
//
// The seasonal path — compare bucket T against the same time-of-day on the
// previous N weeks — is the honest one, because 3am is legitimately quiet and
// 9am legitimately busy, and any threshold that ignores that will either miss
// the 3am incident or false-alarm every morning.
//
// The rolling-window fallback is what makes the system usable on day one,
// before there is any weekly history. It's noisier but functional.

export interface HistoricalPoint {
  bucketTs: number; // unix seconds
  value: number;
}

export interface BaselineOptions {
  bucketSeconds: number; // e.g. 300
  baselineWeeks: number; // how many prior weeks to sample
  minSamples: number; // below this, fall back to rolling
  rollingHours?: number; // fallback window size, default 3
}

export interface BaselineResult {
  samples: number[];
  source: "seasonal" | "rolling" | "insufficient";
}

const WEEK_SECONDS = 7 * 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;

/**
 * Gather baseline samples for the bucket ending at `targetBucketTs`.
 *
 * Seasonal: for each week k in 1..N, take every point within ±1 bucket of
 * (targetBucketTs - k*week). ±1 bucket is a tolerance for slightly misaligned
 * ingestion — the collector doesn't guarantee exact-second boundaries.
 *
 * Fallback: rolling window of `rollingHours` immediately preceding the target
 * bucket (exclusive of the target itself, so we don't feed the value we're
 * evaluating back into its own baseline).
 */
export function gatherBaseline(
  targetBucketTs: number,
  history: readonly HistoricalPoint[],
  opts: BaselineOptions,
): BaselineResult {
  const tolerance = opts.bucketSeconds;
  const seasonalSamples: number[] = [];

  for (let k = 1; k <= opts.baselineWeeks; k += 1) {
    const anchor = targetBucketTs - k * WEEK_SECONDS;
    for (const point of history) {
      if (Math.abs(point.bucketTs - anchor) <= tolerance) {
        seasonalSamples.push(point.value);
      }
    }
  }

  if (seasonalSamples.length >= opts.minSamples) {
    return { samples: seasonalSamples, source: "seasonal" };
  }

  const rollingHours = opts.rollingHours ?? 3;
  const windowStart = targetBucketTs - rollingHours * HOUR_SECONDS;
  const rollingSamples: number[] = [];
  for (const point of history) {
    if (point.bucketTs >= windowStart && point.bucketTs < targetBucketTs) {
      rollingSamples.push(point.value);
    }
  }

  if (rollingSamples.length >= opts.minSamples) {
    return { samples: rollingSamples, source: "rolling" };
  }

  // Not enough history to say anything. Caller must decline to alert; the
  // "insufficient" tag surfaces that decision instead of silently returning
  // a tiny sample set that would produce nonsense z-scores.
  return {
    samples:
      rollingSamples.length > seasonalSamples.length
        ? rollingSamples
        : seasonalSamples,
    source: "insufficient",
  };
}
