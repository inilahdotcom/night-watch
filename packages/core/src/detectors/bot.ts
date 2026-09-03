// Bot-share ratio — companion to the `cf_bot_requests` baseline entry.
//
// The baseline entry answers "is this unusual *for this site*". This answers
// "is this absurd *for any site*": a flat floor that fires when a zone which
// normally sees 20% automated traffic is suddenly 90% automated, on a bucket
// where the seasonal baseline has not yet caught up.
//
// ponytail: flat ratio, no baseline of its own. The `cf_bot_requests` entry in
// `monitor.baselines` already covers the seasonal question. Add a seasonal
// bot-share baseline only if flat thresholds prove untunable.

export interface BotDetectorOptions {
  botShareWarn: number; // 0..1
  botShareCrit: number; // 0..1
  minRequests: number; // silence entirely below this, measured on scored traffic
}

export interface BotInput {
  botRequests: number; // botScore 1..29, not verified
  humanRequests: number; // botScore 30..99
  verifiedBotRequests: number; // botScoreSrc = "Verified Bot"
}

export type BotSeverity = "warning" | "critical" | null;

export interface BotResult {
  /** Unverified bots as a fraction of scored, unverified traffic. 0 when suppressed. */
  share: number;
  /** The denominator, stated out loud — a ratio over 12 requests means nothing. */
  scored: number;
  verified: number;
  severity: BotSeverity;
  message: string;
  /** True when the bucket is too thin, or nothing was scored at all. */
  suppressed: boolean;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function evaluateBotShare(
  input: BotInput,
  opts: BotDetectorOptions,
): BotResult {
  // Verified bots are excluded from BOTH sides of the ratio. A hard Googlebot
  // re-crawl is not an incident, and leaving it in the denominator would dilute
  // the numerator exactly when a real scraper piggybacks on one.
  const scored = input.botRequests + input.humanRequests;
  const verified = input.verifiedBotRequests;

  // Two ways to be unjudgeable: too little traffic, or a zone where nothing was
  // scored at all (no Bot Analytics, or an all-static path set). Both must read
  // as "no verdict", never as "0% bots, all clear". This also covers the
  // divide-by-zero.
  if (scored < opts.minRequests) {
    return {
      share: 0,
      scored,
      verified,
      severity: null,
      message:
        scored === 0
          ? "no scored traffic in this bucket"
          : `only ${Math.round(scored)} scored requests, below the ${opts.minRequests} floor`,
      suppressed: true,
    };
  }

  const share = input.botRequests / scored;

  // A config with crit below warn would make every warning critical and
  // silently destroy the distinction. Clamp rather than reject: an operator who
  // typo'd their thresholds should still get alerts, just conservative ones.
  // Mirrors threatRatioWarn/threatRatioCrit, which have the same latent problem.
  const crit = Math.max(opts.botShareCrit, opts.botShareWarn);

  let severity: BotSeverity = null;
  if (share >= crit) severity = "critical";
  else if (share >= opts.botShareWarn) severity = "warning";

  const limit = severity === "critical" ? crit : opts.botShareWarn;
  return {
    share,
    scored,
    verified,
    severity,
    message:
      severity === null
        ? `${pct(share)} automated of ${Math.round(scored)} scored requests, under the ${pct(opts.botShareWarn)} threshold`
        : `${pct(share)} of ${Math.round(scored)} scored requests were automated (threshold ${pct(limit)}), excluding ${Math.round(verified)} verified-bot requests`,
    suppressed: false,
  };
}
