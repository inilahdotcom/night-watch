import { describe, expect, it } from "bun:test";
import {
  applyProbeResult,
  initialProbeState,
  type ProbeResult,
  type ProbeState,
  type UptimeOptions,
} from "../uptime.ts";

const OPTS: UptimeOptions = {
  failThreshold: 3,
  recoverThreshold: 2,
  slowResponseMs: 3_000,
};

const ok = (latencyMs = 100, status = 200): ProbeResult => ({
  kind: "ok",
  latencyMs,
  status,
});
const fail = (reason = "timeout"): ProbeResult => ({ kind: "fail", reason });

function run(
  results: ProbeResult[],
  start: ProbeState = initialProbeState,
): ProbeState {
  let state = start;
  for (const r of results) {
    state = applyProbeResult(state, r, OPTS).next;
  }
  return state;
}

describe("applyProbeResult — happy path", () => {
  it("stays up on an OK probe from the initial state", () => {
    const d = applyProbeResult(initialProbeState, ok(), OPTS);
    expect(d.next.isDown).toBe(false);
    expect(d.transition).toBe("still-up");
    expect(d.slow).toBe(false);
  });

  it("does not flip to down before failThreshold consecutive fails", () => {
    const s2 = run([fail(), fail()]);
    expect(s2.isDown).toBe(false);
    expect(s2.consecutiveFail).toBe(2);
  });
});

describe("applyProbeResult — going down", () => {
  it("flips to down on the failThreshold-th consecutive fail (transition = went-down)", () => {
    let state = initialProbeState;
    // 1st fail
    state = applyProbeResult(state, fail(), OPTS).next;
    expect(state.isDown).toBe(false);
    // 2nd fail
    state = applyProbeResult(state, fail(), OPTS).next;
    expect(state.isDown).toBe(false);
    // 3rd fail: went-down
    const d = applyProbeResult(state, fail(), OPTS);
    expect(d.transition).toBe("went-down");
    expect(d.next.isDown).toBe(true);
    expect(d.next.consecutiveFail).toBe(3);
    expect(d.failReason).toBe("timeout");
  });

  it("resets consecutiveOk on any fail", () => {
    const state = run([ok(), ok(), fail()]);
    expect(state.consecutiveOk).toBe(0);
    expect(state.consecutiveFail).toBe(1);
  });

  it("does not re-emit went-down while already down", () => {
    const downState = run([fail(), fail(), fail()]);
    expect(downState.isDown).toBe(true);
    const d = applyProbeResult(downState, fail(), OPTS);
    expect(d.transition).toBe("still-down");
    expect(d.next.isDown).toBe(true);
  });
});

describe("applyProbeResult — recovery", () => {
  it("does not recover on a single OK after downtime", () => {
    const downState = run([fail(), fail(), fail()]);
    const d = applyProbeResult(downState, ok(), OPTS);
    expect(d.transition).toBe("still-down");
    expect(d.next.isDown).toBe(true);
    expect(d.next.consecutiveOk).toBe(1);
  });

  it("recovers on the recoverThreshold-th consecutive OK (transition = recovered)", () => {
    const downState = run([fail(), fail(), fail()]);
    const s1 = applyProbeResult(downState, ok(), OPTS).next;
    const d = applyProbeResult(s1, ok(), OPTS);
    expect(d.transition).toBe("recovered");
    expect(d.next.isDown).toBe(false);
    expect(d.next.consecutiveOk).toBe(2);
    expect(d.next.consecutiveFail).toBe(0);
  });
});

describe("applyProbeResult — slow flag (early-warning)", () => {
  it("marks slow when latency ≥ slowResponseMs on an OK probe", () => {
    const d = applyProbeResult(initialProbeState, ok(3500), OPTS);
    expect(d.slow).toBe(true);
    // Still up — slow ≠ down.
    expect(d.next.isDown).toBe(false);
  });

  it("does not mark slow just below the threshold", () => {
    const d = applyProbeResult(initialProbeState, ok(2999), OPTS);
    expect(d.slow).toBe(false);
  });

  it("does not mark slow on a fail probe", () => {
    const d = applyProbeResult(initialProbeState, fail(), OPTS);
    expect(d.slow).toBe(false);
  });
});

describe("applyProbeResult — misc invariants", () => {
  it("never sets both consecutiveOk > 0 and consecutiveFail > 0 in the same result", () => {
    const seq = [
      ok(),
      ok(),
      fail(),
      fail(),
      ok(),
      fail(),
      fail(),
      fail(),
      ok(),
      ok(),
    ];
    let state = initialProbeState;
    for (const r of seq) {
      const d = applyProbeResult(state, r, OPTS);
      state = d.next;
      const oneSideOnly =
        state.consecutiveOk === 0 || state.consecutiveFail === 0;
      expect(oneSideOnly).toBe(true);
    }
  });

  it("does not mutate the input state", () => {
    const start: ProbeState = {
      consecutiveOk: 0,
      consecutiveFail: 2,
      isDown: false,
    };
    const snapshot = { ...start };
    applyProbeResult(start, fail(), OPTS);
    expect(start).toEqual(snapshot);
  });
});
