// Uptime state machine. Pure function: previous state + probe result → next
// state + a transition tag the alert layer acts on. All the actual HTTP I/O
// and the control-URL sanity check happen in the collector — this file only
// interprets results.

export type ProbeResult =
  | { kind: "ok"; latencyMs: number; status: number }
  | {
      kind: "fail";
      reason: string;
      latencyMs?: number;
      status?: number;
    };

export interface ProbeState {
  consecutiveFail: number;
  consecutiveOk: number;
  isDown: boolean;
}

export interface UptimeOptions {
  failThreshold: number; // e.g. 3 consecutive fails → DOWN
  recoverThreshold: number; // e.g. 2 consecutive oks → UP
  slowResponseMs: number; // ok but latency ≥ this → also flag as slow
}

export type UptimeTransition =
  | "no-change"
  | "went-down"
  | "recovered"
  | "still-down"
  | "still-up";

export interface UptimeDecision {
  next: ProbeState;
  transition: UptimeTransition;
  slow: boolean;
  latencyMs: number | null;
  status: number | null;
  failReason: string | null;
}

export function applyProbeResult(
  prev: ProbeState,
  result: ProbeResult,
  opts: UptimeOptions,
): UptimeDecision {
  if (result.kind === "ok") {
    const consecutiveOk = prev.consecutiveOk + 1;
    const consecutiveFail = 0;
    const slow = result.latencyMs >= opts.slowResponseMs;

    if (prev.isDown && consecutiveOk >= opts.recoverThreshold) {
      return {
        next: { consecutiveOk, consecutiveFail, isDown: false },
        transition: "recovered",
        slow,
        latencyMs: result.latencyMs,
        status: result.status,
        failReason: null,
      };
    }
    return {
      next: { consecutiveOk, consecutiveFail, isDown: prev.isDown },
      transition: prev.isDown ? "still-down" : "still-up",
      slow,
      latencyMs: result.latencyMs,
      status: result.status,
      failReason: null,
    };
  }

  // Failure path
  const consecutiveFail = prev.consecutiveFail + 1;
  const consecutiveOk = 0;

  if (!prev.isDown && consecutiveFail >= opts.failThreshold) {
    return {
      next: { consecutiveOk, consecutiveFail, isDown: true },
      transition: "went-down",
      slow: false,
      latencyMs: result.latencyMs ?? null,
      status: result.status ?? null,
      failReason: result.reason,
    };
  }
  return {
    next: { consecutiveOk, consecutiveFail, isDown: prev.isDown },
    transition: prev.isDown ? "still-down" : "still-up",
    slow: false,
    latencyMs: result.latencyMs ?? null,
    status: result.status ?? null,
    failReason: result.reason,
  };
}

export const initialProbeState: ProbeState = {
  consecutiveFail: 0,
  consecutiveOk: 0,
  isDown: false,
};
