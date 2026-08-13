import { robustZScore, type RobustZResult } from "./stats.ts";

// Traffic anomaly evaluator.
//
// Three guards must ALL pass before we alert (brief §5.3). Any one alone is
// not enough — statistical significance on a tiny baseline is meaningless, and
// large relative moves on tiny numbers are noise. The combination is what
// separates real incidents from "the intern refreshed the page five times".

export interface TrafficDetectorOptions {
  spikeZ: number; // e.g. 3.5
  minBaseline: number; // e.g. 50
  minRelativeChange: number; // e.g. 0.4
}

export interface TrafficAnomaly {
  triggered: boolean;
  direction: "spike" | "drop" | null;
  z: number;
  median: number;
  relativeChange: number; // (value - median) / max(median, 1)
  scaleSource: RobustZResult["scaleSource"];
  reasons: string[]; // when not triggered, why the guards blocked it
}

export function evaluateTraffic(
  value: number,
  baselineSamples: readonly number[],
  opts: TrafficDetectorOptions,
): TrafficAnomaly {
  if (baselineSamples.length === 0) {
    return {
      triggered: false,
      direction: null,
      z: 0,
      median: 0,
      relativeChange: 0,
      scaleSource: "floor",
      reasons: ["empty baseline"],
    };
  }

  const z = robustZScore(value, baselineSamples);
  const relativeChange = (value - z.median) / Math.max(Math.abs(z.median), 1);

  const reasons: string[] = [];
  if (Math.abs(z.z) < opts.spikeZ) {
    reasons.push(`|z|=${z.z.toFixed(2)} < spikeZ=${opts.spikeZ}`);
  }
  if (z.median < opts.minBaseline) {
    reasons.push(
      `median=${z.median.toFixed(1)} < minBaseline=${opts.minBaseline}`,
    );
  }
  if (Math.abs(relativeChange) < opts.minRelativeChange) {
    reasons.push(
      `|Δrel|=${Math.abs(relativeChange).toFixed(2)} < minRelativeChange=${opts.minRelativeChange}`,
    );
  }

  const triggered = reasons.length === 0;
  const direction: TrafficAnomaly["direction"] = !triggered
    ? null
    : z.z > 0
      ? "spike"
      : "drop";

  return {
    triggered,
    direction,
    z: z.z,
    median: z.median,
    relativeChange,
    scaleSource: z.scaleSource,
    reasons,
  };
}

/**
 * Confirmation gate — an anomaly must persist for `required` consecutive
 * buckets in the same direction before it graduates from "possible ripple"
 * to "worth alerting". Give it the recent evaluations with the most recent
 * one last.
 */
export function confirmConsecutive(
  recent: readonly TrafficAnomaly[],
  required: number,
): boolean {
  if (recent.length < required) return false;
  const window = recent.slice(-required);
  const first = window[0]!;
  if (!first.triggered || first.direction === null) return false;
  return window.every(
    (r) => r.triggered && r.direction === first.direction,
  );
}
