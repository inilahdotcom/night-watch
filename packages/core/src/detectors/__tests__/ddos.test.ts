import { describe, expect, it } from "bun:test";
import { evaluateDDoS, type DDoSDetectorOptions } from "../ddos.ts";

const OPTS: DDoSDetectorOptions = {
  spikeZ: 3.5,
  threatRatioCrit: 0.35,
  threatRatioWarn: 0.15,
  errorRatio: 0.1,
  minRequests: 300,
};

// A baseline of ~1000 rps that produces a real (non-floor) MAD so volume z
// scores line up predictably.
const CALM_BASELINE = [900, 950, 1000, 1010, 1050, 1000, 980, 1020];

describe("evaluateDDoS — silence guard", () => {
  it("stays silent below minRequests, even if every signal maxes out", () => {
    const r = evaluateDDoS(
      {
        requests: 200,
        requestsBaseline: CALM_BASELINE,
        threatRequests: 100,
        status5xx: 50,
        status429: 20,
        cacheMissRatio: 0.9,
      },
      OPTS,
    );
    expect(r.score).toBe(0);
    expect(r.severity).toBeNull();
    expect(r.signals).toEqual([]);
  });

  it("engages once total requests reach minRequests", () => {
    const r = evaluateDDoS(
      {
        requests: 500,
        requestsBaseline: CALM_BASELINE,
        threatRequests: 200, // 40% blocked
        status5xx: 0,
        status429: 0,
        cacheMissRatio: 0.1,
      },
      OPTS,
    );
    expect(r.signals.some((s) => s.name === "firewall_blocking_heavy")).toBe(
      true,
    );
  });
});

describe("evaluateDDoS — the anti-alarm shape (volume-only)", () => {
  it("does not alert on volume spike alone — could be marketing", () => {
    // Big volume jump, no firewall, no origin errors, no cache-bust.
    const r = evaluateDDoS(
      {
        requests: 8000, // >> baseline median 1000
        requestsBaseline: CALM_BASELINE,
        threatRequests: 0,
        status5xx: 0,
        status429: 0,
        cacheMissRatio: 0.05,
      },
      OPTS,
    );
    expect(r.signals.some((s) => s.name.startsWith("volume_spike"))).toBe(true);
    // Volume alone maxes at weight 3 (extreme), warning starts at 3.
    // At extreme, score = 3 → warning. At normal spike, score = 2 → silent.
    // The point of the test: volume alone can be warning at most, never critical.
    expect(r.severity).not.toBe("critical");
  });
});

describe("evaluateDDoS — full attack shape (critical)", () => {
  it("goes critical when volume spike + firewall heavy + origin 5xx coincide", () => {
    const r = evaluateDDoS(
      {
        requests: 8000,
        requestsBaseline: CALM_BASELINE,
        threatRequests: 3200, // 40%
        status5xx: 1200, // 15%
        status429: 500, // 6.25%
        cacheMissRatio: 0.85,
      },
      OPTS,
    );
    // volume 3 + firewall 3 + 5xx 2 + cache-bust 2 + rate-limit 1 = 11 → critical
    expect(r.severity).toBe("critical");
    expect(r.score).toBeGreaterThanOrEqual(5);
    expect(r.suggestedAction).toContain("Under Attack Mode");
  });

  it("warns on moderate mix without cache-busting", () => {
    const r = evaluateDDoS(
      {
        requests: 5000, // spike
        requestsBaseline: CALM_BASELINE,
        threatRequests: 900, // 18% → warn ratio, weight 2
        status5xx: 200, // 4% → below errorRatio
        status429: 100, // 2%
        cacheMissRatio: 0.2,
      },
      OPTS,
    );
    // volume 2 or 3 + firewall 2 = 4 or 5 → warning (or just barely critical)
    expect(r.severity === "warning" || r.severity === "critical").toBe(true);
  });
});

describe("evaluateDDoS — cache-busting signature", () => {
  it("does not count cache_busting without a volume spike", () => {
    // High cache miss but volume is flat — probably a cache purge, not attack.
    const r = evaluateDDoS(
      {
        requests: 1000, // right on baseline
        requestsBaseline: CALM_BASELINE,
        threatRequests: 0,
        status5xx: 0,
        status429: 0,
        cacheMissRatio: 0.95,
      },
      OPTS,
    );
    expect(r.signals.every((s) => s.name !== "cache_busting")).toBe(true);
  });

  it("counts cache_busting when it coincides with a volume spike", () => {
    const r = evaluateDDoS(
      {
        requests: 8000,
        requestsBaseline: CALM_BASELINE,
        threatRequests: 0,
        status5xx: 0,
        status429: 0,
        cacheMissRatio: 0.95,
      },
      OPTS,
    );
    expect(r.signals.some((s) => s.name === "cache_busting")).toBe(true);
  });
});

describe("evaluateDDoS — firewall bucket exclusivity", () => {
  it("uses the critical firewall weight (3), not both, when ratio exceeds crit", () => {
    const r = evaluateDDoS(
      {
        requests: 1000,
        requestsBaseline: CALM_BASELINE,
        threatRequests: 500, // 50% → crit
        status5xx: 0,
        status429: 0,
        cacheMissRatio: 0,
      },
      OPTS,
    );
    const firewallSignals = r.signals.filter((s) => s.name.startsWith("firewall"));
    expect(firewallSignals).toHaveLength(1);
    expect(firewallSignals[0]!.name).toBe("firewall_blocking_heavy");
    expect(firewallSignals[0]!.weight).toBe(3);
  });

  it("uses the warning firewall weight (2) when only in the warn band", () => {
    const r = evaluateDDoS(
      {
        requests: 1000,
        requestsBaseline: CALM_BASELINE,
        threatRequests: 200, // 20% → warn only
        status5xx: 0,
        status429: 0,
        cacheMissRatio: 0,
      },
      OPTS,
    );
    const firewallSignals = r.signals.filter((s) => s.name.startsWith("firewall"));
    expect(firewallSignals).toHaveLength(1);
    expect(firewallSignals[0]!.name).toBe("firewall_mitigating");
    expect(firewallSignals[0]!.weight).toBe(2);
  });
});

describe("evaluateDDoS — recovery / clean input", () => {
  it("returns severity=null and score=0 on a completely quiet bucket", () => {
    const r = evaluateDDoS(
      {
        requests: 1000,
        requestsBaseline: CALM_BASELINE,
        threatRequests: 5,
        status5xx: 2,
        status429: 0,
        cacheMissRatio: 0.1,
      },
      OPTS,
    );
    expect(r.severity).toBeNull();
    expect(r.score).toBe(0);
    expect(r.signals).toEqual([]);
  });

  it("does not recommend under-attack-mode below critical", () => {
    const r = evaluateDDoS(
      {
        requests: 1000,
        requestsBaseline: CALM_BASELINE,
        threatRequests: 200, // 20% warn
        status5xx: 150, // 15% → weight 2
        status429: 0,
        cacheMissRatio: 0.1,
      },
      OPTS,
    );
    expect(r.severity).toBe("warning");
    expect(r.suggestedAction).toBeNull();
  });
});
