// Anomaly injections describe deliberate disturbances layered on top of the
// clean baseline. The generator applies them at the right buckets and the
// demo uses the same list as the ground-truth answer key ("this one should
// have been caught, this one should have been ignored").

export type Injection =
  | {
      kind: "spike";
      /** Bucket timestamp (unix seconds) where the spike starts. */
      atBucketTs: number;
      /** Number of consecutive buckets affected. */
      durationBuckets: number;
      /** Multiplier on baseline traffic during the spike (e.g. 3 = 3× traffic). */
      volumeFactor: number;
      /** Human label for the report. */
      label: string;
      /** What the detectors *should* do with this injection. */
      expected: "traffic-alert" | "ddos-alert" | "no-alert";
    }
  | {
      kind: "drop";
      atBucketTs: number;
      durationBuckets: number;
      /** Fraction remaining (e.g. 0.2 = 80% drop). */
      volumeFactor: number;
      label: string;
      expected: "traffic-alert" | "no-alert";
    }
  | {
      kind: "attack";
      atBucketTs: number;
      durationBuckets: number;
      volumeFactor: number; // usually ≥ 2× to trigger the volume signal too
      threatRatio: number; // fraction of requests flagged by firewall
      errorRatio: number; // fraction of origin 5xx
      cacheMissRatio: number; // fraction of requests missing cache
      label: string;
      expected: "ddos-alert";
    };

/** True if the injection's window contains this bucket. */
export function injectionCovers(inj: Injection, bucketTs: number): boolean {
  const bucketSeconds = 300;
  const start = inj.atBucketTs;
  const end = inj.atBucketTs + inj.durationBuckets * bucketSeconds;
  return bucketTs >= start && bucketTs < end;
}

/** Returns the first injection covering a bucket, or null. */
export function injectionAt(
  bucketTs: number,
  injections: readonly Injection[],
): Injection | null {
  for (const inj of injections) if (injectionCovers(inj, bucketTs)) return inj;
  return null;
}
