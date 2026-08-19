// Robust statistics for anomaly detection.
//
// Median + MAD instead of mean + stddev because a single bad hour last week
// otherwise poisons the mean, quietly stretches the threshold, and the
// detector silently stops catching the next incident.

export function median(xs: readonly number[]): number {
  if (xs.length === 0) {
    throw new Error("median of empty input");
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

// Median of the absolute deviations from the median.
export function medianAbsoluteDeviation(
  xs: readonly number[],
  med?: number,
): number {
  if (xs.length === 0) {
    throw new Error("MAD of empty input");
  }
  const m = med ?? median(xs);
  const deviations = xs.map((x) => Math.abs(x - m));
  return median(deviations);
}

// Fallback for when MAD is 0 (majority of samples identical — common at low
// traffic where you get long runs of zeros). Uses the mean of absolute
// deviations, which is still robust-ish and rarely zero.
export function averageAbsoluteDeviation(
  xs: readonly number[],
  med?: number,
): number {
  if (xs.length === 0) {
    throw new Error("avgAbsDev of empty input");
  }
  const m = med ?? median(xs);
  let sum = 0;
  for (const x of xs) sum += Math.abs(x - m);
  return sum / xs.length;
}

export interface RobustZResult {
  z: number;
  median: number;
  scale: number; // the divisor actually used (MAD, or fallback)
  scaleSource: "mad" | "avgAbsDev" | "floor";
}

// 0.6745 = quantile(Normal, 0.75), makes MAD comparable to stddev under normal.
//
// Exported because the dashboard has to invert the z-score to draw the band:
// the value at which |z| hits spikeZ is median ± (spikeZ × scale) / MAD_TO_SIGMA.
// Re-typing 0.6745 over there would let the drawn band drift from the tested one.
export const MAD_TO_SIGMA = 0.6745;

/**
 * Robust z-score with a documented fallback ladder:
 *   1. MAD — the normal case
 *   2. avgAbsDev — when MAD = 0 (many identical samples)
 *   3. floor of max(1, median × 0.1) — when both are 0 (all samples identical)
 *
 * Without step 3, a run of zeros makes both MAD and avgAbsDev zero, then the
 * division blows up to Infinity and every subsequent bucket alerts. Ask me
 * how I know.
 */
export function robustZScore(
  value: number,
  samples: readonly number[],
): RobustZResult {
  if (samples.length === 0) {
    throw new Error("robustZScore of empty samples");
  }
  const med = median(samples);
  const mad = medianAbsoluteDeviation(samples, med);
  if (mad > 0) {
    return {
      z: (MAD_TO_SIGMA * (value - med)) / mad,
      median: med,
      scale: mad,
      scaleSource: "mad",
    };
  }
  const aad = averageAbsoluteDeviation(samples, med);
  if (aad > 0) {
    return {
      z: (MAD_TO_SIGMA * (value - med)) / aad,
      median: med,
      scale: aad,
      scaleSource: "avgAbsDev",
    };
  }
  const floor = Math.max(1, Math.abs(med) * 0.1);
  return {
    z: (MAD_TO_SIGMA * (value - med)) / floor,
    median: med,
    scale: floor,
    scaleSource: "floor",
  };
}
