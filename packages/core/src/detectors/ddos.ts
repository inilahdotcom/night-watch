import { robustZScore } from "./stats.ts";

// DDoS composite score (brief §5.5).
//
// No single Cloudflare metric can call "attack" on its own. A volume spike
// might be a Hacker News post; firewall activity might be a bot sweep. What
// separates an incident is the *combination*: volume up AND firewall busy
// AND origin sweating AND cache being sidestepped, all at once.
//
// Weights are additive. Cache-miss only counts when it coincides with a
// volume spike — that pattern is the signature of cache-busting, where an
// attacker asks for random URLs to force origin hits.

export interface DDoSDetectorOptions {
  spikeZ: number;
  threatRatioCrit: number;
  threatRatioWarn: number;
  errorRatio: number;
  minRequests: number; // silence entirely below this
}

export interface DDoSInput {
  requests: number;
  requestsBaseline: readonly number[];
  threatRequests: number; // firewall blocked/challenged/managed-ruled
  status5xx: number;
  status429: number;
  cacheMissRatio: number; // 0..1
}

export type DDoSSeverity = "warning" | "critical" | null;

export interface DDoSSignal {
  name: string;
  weight: number;
  detail: string;
}

export interface DDoSResult {
  score: number;
  severity: DDoSSeverity;
  signals: DDoSSignal[];
  volumeZ: number | null;
  suggestedAction: string | null;
}

const WARN_SCORE = 3;
const CRIT_SCORE = 5;
const CACHE_MISS_TRIGGER = 0.7;
const RATE_LIMIT_TRIGGER = 0.05;

const SUGGESTED_ACTION_CRIT =
  'Consider enabling "Under Attack Mode" on the Cloudflare dashboard.';

export function evaluateDDoS(
  input: DDoSInput,
  opts: DDoSDetectorOptions,
): DDoSResult {
  // Silence at low traffic — otherwise every quiet-period fluctuation looks
  // like an attack in relative terms.
  if (input.requests < opts.minRequests) {
    return {
      score: 0,
      severity: null,
      signals: [],
      volumeZ: null,
      suggestedAction: null,
    };
  }

  const signals: DDoSSignal[] = [];
  let volumeSpiked = false;
  let volumeZ: number | null = null;

  // Volume signal
  if (input.requestsBaseline.length > 0) {
    const z = robustZScore(input.requests, input.requestsBaseline);
    volumeZ = z.z;
    if (z.z >= 2 * opts.spikeZ) {
      signals.push({
        name: "volume_spike_extreme",
        weight: 3,
        detail: `z=${z.z.toFixed(2)} ≥ 2×spikeZ=${(2 * opts.spikeZ).toFixed(1)}`,
      });
      volumeSpiked = true;
    } else if (z.z >= opts.spikeZ) {
      signals.push({
        name: "volume_spike",
        weight: 2,
        detail: `z=${z.z.toFixed(2)} ≥ spikeZ=${opts.spikeZ}`,
      });
      volumeSpiked = true;
    }
  }

  // Firewall signals — critical bucket wins if both would qualify.
  const threatRatio = input.threatRequests / input.requests;
  if (threatRatio >= opts.threatRatioCrit) {
    signals.push({
      name: "firewall_blocking_heavy",
      weight: 3,
      detail: `${(threatRatio * 100).toFixed(1)}% blocked ≥ ${(opts.threatRatioCrit * 100).toFixed(0)}%`,
    });
  } else if (threatRatio >= opts.threatRatioWarn) {
    signals.push({
      name: "firewall_mitigating",
      weight: 2,
      detail: `${(threatRatio * 100).toFixed(1)}% mitigated ≥ ${(opts.threatRatioWarn * 100).toFixed(0)}%`,
    });
  }

  // Origin errors
  const errorRatio = input.status5xx / input.requests;
  if (errorRatio >= opts.errorRatio) {
    signals.push({
      name: "origin_5xx",
      weight: 2,
      detail: `${(errorRatio * 100).toFixed(1)}% 5xx ≥ ${(opts.errorRatio * 100).toFixed(0)}%`,
    });
  }

  // Cache-busting signature: high cache miss only counts when it coincides
  // with a volume spike.
  if (input.cacheMissRatio >= CACHE_MISS_TRIGGER && volumeSpiked) {
    signals.push({
      name: "cache_busting",
      weight: 2,
      detail: `cache miss ${(input.cacheMissRatio * 100).toFixed(1)}% + volume spike`,
    });
  }

  // Rate-limit pressure
  const rateLimitRatio = input.status429 / input.requests;
  if (rateLimitRatio >= RATE_LIMIT_TRIGGER) {
    signals.push({
      name: "rate_limited",
      weight: 1,
      detail: `${(rateLimitRatio * 100).toFixed(1)}% 429 ≥ ${(RATE_LIMIT_TRIGGER * 100).toFixed(0)}%`,
    });
  }

  const score = signals.reduce((s, x) => s + x.weight, 0);
  let severity: DDoSSeverity = null;
  if (score >= CRIT_SCORE) severity = "critical";
  else if (score >= WARN_SCORE) severity = "warning";

  return {
    score,
    severity,
    signals,
    volumeZ,
    suggestedAction: severity === "critical" ? SUGGESTED_ACTION_CRIT : null,
  };
}
