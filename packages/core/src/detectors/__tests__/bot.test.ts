import { describe, expect, it } from "bun:test";
import { evaluateBotShare, type BotDetectorOptions } from "../bot.ts";

const OPTS: BotDetectorOptions = {
  botShareWarn: 0.6,
  botShareCrit: 0.85,
  minRequests: 300,
};

describe("evaluateBotShare — silence guard", () => {
  it("stays silent below minRequests, however lopsided the mix", () => {
    const r = evaluateBotShare(
      { botRequests: 100, humanRequests: 20, verifiedBotRequests: 0 },
      OPTS,
    );
    expect(r.suppressed).toBe(true);
    expect(r.severity).toBeNull();
    expect(r.share).toBe(0);
    expect(r.message).toContain("below the 300 floor");
  });

  it("reports no scored traffic as a non-verdict, not as 0% bots", () => {
    const r = evaluateBotShare(
      { botRequests: 0, humanRequests: 0, verifiedBotRequests: 0 },
      OPTS,
    );
    expect(r.suppressed).toBe(true);
    expect(r.severity).toBeNull();
    expect(Number.isNaN(r.share)).toBe(false);
    expect(r.message).toBe("no scored traffic in this bucket");
  });
});

describe("evaluateBotShare — verified bots", () => {
  it("does not fire on a heavy verified-bot recrawl", () => {
    // 900 verified Googlebot hits alongside a perfectly normal 10% automated
    // share. Counting verified bots in the numerator OR denominator here would
    // page someone for a sitemap refresh.
    const r = evaluateBotShare(
      { botRequests: 100, humanRequests: 900, verifiedBotRequests: 900 },
      OPTS,
    );
    expect(r.share).toBeCloseTo(0.1, 10);
    expect(r.severity).toBeNull();
    expect(r.verified).toBe(900);
  });
});

describe("evaluateBotShare — threshold bands", () => {
  it("warns inside the warn band", () => {
    const r = evaluateBotShare(
      { botRequests: 650, humanRequests: 350, verifiedBotRequests: 0 },
      OPTS,
    );
    expect(r.share).toBeCloseTo(0.65, 10);
    expect(r.severity).toBe("warning");
    expect(r.suppressed).toBe(false);
  });

  it("goes critical past the crit threshold", () => {
    const r = evaluateBotShare(
      { botRequests: 900, humanRequests: 100, verifiedBotRequests: 0 },
      OPTS,
    );
    expect(r.severity).toBe("critical");
    expect(r.message).toContain("automated");
  });

  it("stays quiet under the warn threshold", () => {
    const r = evaluateBotShare(
      { botRequests: 300, humanRequests: 700, verifiedBotRequests: 0 },
      OPTS,
    );
    expect(r.severity).toBeNull();
    expect(r.suppressed).toBe(false);
  });
});

describe("evaluateBotShare — inverted config", () => {
  // crit below warn would otherwise make every warning critical.
  const INVERTED: BotDetectorOptions = {
    botShareWarn: 0.8,
    botShareCrit: 0.5,
    minRequests: 300,
  };

  it("clamps crit up to warn rather than collapsing the bands", () => {
    const high = evaluateBotShare(
      { botRequests: 850, humanRequests: 150, verifiedBotRequests: 0 },
      INVERTED,
    );
    expect(high.severity).toBe("critical");

    const mid = evaluateBotShare(
      { botRequests: 600, humanRequests: 400, verifiedBotRequests: 0 },
      INVERTED,
    );
    expect(mid.severity).toBeNull();
  });
});
