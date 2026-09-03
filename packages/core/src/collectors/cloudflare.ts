import type { MetricName, MetricSource } from "../db/schema.ts";

// Cloudflare GraphQL Analytics collector.
//
// One document, four aliases (brief §4): the API allows sibling selections
// so we spend one round-trip for total volume/bytes, status breakdown, cache
// breakdown, and firewall events. Four separate queries would be four times
// the auth overhead and four separate throttle counters.
//
// Two gotchas the brief pre-warned us about:
//   1. httpRequestsAdaptiveGroups samples at high volume; multiply `count`
//      by `avg.sampleInterval` to recover the estimated true count.
//   2. Field availability differs by plan. We surface API errors in a
//      structured `.errors` field instead of throwing so one bad monitor
//      doesn't kill the whole poll cycle.

export interface CloudflareCollectorOptions {
  zoneId: string;
  apiToken: string;
  monitor: string;
  /** Inclusive start bucket (unix seconds). */
  sinceTs: number;
  /** Exclusive end bucket (unix seconds). */
  untilTs: number;
  endpoint?: string; // override for tests
  fetchImpl?: typeof fetch;
}

export interface CollectorError {
  code: string;
  message: string;
  path?: readonly (string | number)[];
}

export interface MetricRow {
  monitor: string;
  source: MetricSource;
  metric: MetricName;
  bucketTs: number;
  value: number;
}

export interface CloudflareCollectorResult {
  metrics: MetricRow[];
  errors: CollectorError[];
  /** Highest sampleInterval encountered — useful to expose in logs. */
  maxSampleInterval: number;
}

const DEFAULT_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

// The GraphQL doc. Kept as a const string so callers can inspect it in tests.
export const CLOUDFLARE_QUERY = `
query NightWatchCollector($zoneTag: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      total: httpRequestsAdaptiveGroups(
        limit: 10000,
        filter: { datetime_geq: $since, datetime_lt: $until },
        orderBy: [datetimeFiveMinutes_ASC]
      ) {
        count
        sum { edgeResponseBytes }
        avg { sampleInterval }
        dimensions { datetimeFiveMinutes }
      }
      byStatus: httpRequestsAdaptiveGroups(
        limit: 10000,
        filter: { datetime_geq: $since, datetime_lt: $until }
      ) {
        count
        avg { sampleInterval }
        dimensions { datetimeFiveMinutes, edgeResponseStatus }
      }
      byCache: httpRequestsAdaptiveGroups(
        limit: 10000,
        filter: { datetime_geq: $since, datetime_lt: $until }
      ) {
        count
        avg { sampleInterval }
        dimensions { datetimeFiveMinutes, cacheStatus }
      }
      firewall: firewallEventsAdaptiveGroups(
        limit: 10000,
        filter: { datetime_geq: $since, datetime_lt: $until }
      ) {
        count
        dimensions { datetimeFiveMinutes, action }
      }
    }
  }
}
`;

// Bot scoring lives in a SECOND document on purpose. GraphQL rejects the ENTIRE
// document at validation when a field is absent on the zone's plan, so folding
// this in as a fifth alias would take cf_requests, cf_bytes, cf_threats,
// cf_status_* and cf_cache_miss down with it on every non-Bot-Management zone.
// One extra round trip, only for monitors that opted in, contains the failure
// to three metric names nothing else reads.
export const CLOUDFLARE_BOT_QUERY = `
query NightWatchBots($zoneTag: String!, $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      bots: httpRequestsAdaptiveGroups(
        limit: 10000,
        filter: { datetime_geq: $since, datetime_lt: $until }
      ) {
        count
        avg { sampleInterval }
        dimensions { datetimeFiveMinutes, botScore, botScoreSrc }
      }
    }
  }
}
`;

interface MainZone {
  total?: Array<TotalGroup>;
  byStatus?: Array<StatusGroup>;
  byCache?: Array<CacheGroup>;
  firewall?: Array<FirewallGroup>;
}

interface BotZone {
  bots?: Array<BotGroup>;
}

interface GraphQLResponse<TZone> {
  data?: {
    viewer?: {
      zones?: Array<TZone>;
    };
  };
  errors?: Array<{
    message: string;
    path?: (string | number)[];
    extensions?: { code?: string };
  }>;
}

interface TotalGroup {
  count: number;
  sum?: { edgeResponseBytes?: number };
  avg?: { sampleInterval?: number };
  dimensions?: { datetimeFiveMinutes?: string };
}

interface StatusGroup {
  count: number;
  avg?: { sampleInterval?: number };
  dimensions?: {
    datetimeFiveMinutes?: string;
    edgeResponseStatus?: number;
  };
}

interface CacheGroup {
  count: number;
  avg?: { sampleInterval?: number };
  dimensions?: {
    datetimeFiveMinutes?: string;
    cacheStatus?: string;
  };
}

interface FirewallGroup {
  count: number;
  dimensions?: {
    datetimeFiveMinutes?: string;
    action?: string;
  };
}

interface BotGroup {
  count: number;
  avg?: { sampleInterval?: number };
  dimensions?: {
    datetimeFiveMinutes?: string;
    botScore?: number;
    botScoreSrc?: string;
  };
}

/** Round an ISO timestamp (Cloudflare's 5-min bucket dim) to unix seconds. */
export function parseBucketTs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

// Firewall actions that indicate blocked/challenged traffic — anything from
// this set counts toward `cf_threats`.
const THREAT_ACTIONS = new Set([
  "block",
  "challenge",
  "jschallenge",
  "managed_challenge",
  "connectionClose",
]);

// Cache statuses that count as "miss" for our cf_cache_miss metric.
const CACHE_MISS_STATES = new Set(["miss", "expired", "bypass", "dynamic"]);

// Shared transport for both documents below. Returns the first zone plus any
// structured errors; never throws, so one bad monitor cannot kill a poll cycle.
async function postGraphQL<TZone>(
  opts: CloudflareCollectorOptions,
  query: string,
): Promise<{ zone: TZone | null; errors: CollectorError[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;

  const body = {
    query,
    variables: {
      zoneTag: opts.zoneId,
      since: new Date(opts.sinceTs * 1000).toISOString(),
      until: new Date(opts.untilTs * 1000).toISOString(),
    },
  };

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      zone: null,
      errors: [
        { code: "TRANSPORT", message: (err as Error).message ?? String(err) },
      ],
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      zone: null,
      errors: [
        {
          code: `HTTP_${response.status}`,
          message: text || response.statusText,
        },
      ],
    };
  }

  const json = (await response.json().catch(() => null)) as
    | GraphQLResponse<TZone>
    | null;
  if (!json) {
    return {
      zone: null,
      errors: [{ code: "BAD_JSON", message: "response was not JSON" }],
    };
  }

  const errors: CollectorError[] = [];
  for (const e of json.errors ?? []) {
    errors.push({
      code: e.extensions?.code ?? "GRAPHQL",
      message: e.message,
      path: e.path,
    });
  }

  return { zone: json.data?.viewer?.zones?.[0] ?? null, errors };
}

export async function collectCloudflare(
  opts: CloudflareCollectorOptions,
): Promise<CloudflareCollectorResult> {
  const metrics: MetricRow[] = [];
  let maxSampleInterval = 1;

  const { zone, errors } = await postGraphQL<MainZone>(opts, CLOUDFLARE_QUERY);
  if (!zone) {
    return { metrics, errors, maxSampleInterval };
  }

  const push = (metric: MetricName, bucketTs: number, value: number) => {
    metrics.push({
      monitor: opts.monitor,
      source: "cloudflare",
      metric,
      bucketTs,
      value,
    });
  };

  // total → cf_requests (sampling-corrected) + cf_bytes
  for (const g of zone.total ?? []) {
    const bucketTs = parseBucketTs(g.dimensions?.datetimeFiveMinutes);
    if (bucketTs === null) continue;
    const sampleInterval = g.avg?.sampleInterval ?? 1;
    maxSampleInterval = Math.max(maxSampleInterval, sampleInterval);
    const trueCount = g.count * sampleInterval;
    push("cf_requests", bucketTs, trueCount);
    push("cf_bytes", bucketTs, g.sum?.edgeResponseBytes ?? 0);
  }

  // byStatus → cf_status_5xx / 4xx / 429 (bucketed sums)
  interface StatusSums {
    s5xx: number;
    s4xx: number;
    s429: number;
  }
  const statusByBucket = new Map<number, StatusSums>();
  for (const g of zone.byStatus ?? []) {
    const bucketTs = parseBucketTs(g.dimensions?.datetimeFiveMinutes);
    const status = g.dimensions?.edgeResponseStatus;
    if (bucketTs === null || typeof status !== "number") continue;
    const sampleInterval = g.avg?.sampleInterval ?? 1;
    maxSampleInterval = Math.max(maxSampleInterval, sampleInterval);
    const value = g.count * sampleInterval;

    let sums = statusByBucket.get(bucketTs);
    if (!sums) {
      sums = { s5xx: 0, s4xx: 0, s429: 0 };
      statusByBucket.set(bucketTs, sums);
    }
    if (status >= 500) sums.s5xx += value;
    else if (status === 429) {
      sums.s429 += value;
      sums.s4xx += value; // 429 is still a 4xx from the origin's perspective
    } else if (status >= 400) sums.s4xx += value;
  }
  for (const [bucketTs, sums] of statusByBucket) {
    push("cf_status_5xx", bucketTs, sums.s5xx);
    push("cf_status_4xx", bucketTs, sums.s4xx);
    push("cf_status_429", bucketTs, sums.s429);
  }

  // byCache → cf_cache_miss (bucketed sum)
  const cacheMissByBucket = new Map<number, number>();
  for (const g of zone.byCache ?? []) {
    const bucketTs = parseBucketTs(g.dimensions?.datetimeFiveMinutes);
    const cacheStatus = g.dimensions?.cacheStatus;
    if (bucketTs === null || typeof cacheStatus !== "string") continue;
    if (!CACHE_MISS_STATES.has(cacheStatus)) continue;
    const sampleInterval = g.avg?.sampleInterval ?? 1;
    maxSampleInterval = Math.max(maxSampleInterval, sampleInterval);
    const value = g.count * sampleInterval;
    cacheMissByBucket.set(
      bucketTs,
      (cacheMissByBucket.get(bucketTs) ?? 0) + value,
    );
  }
  for (const [bucketTs, sum] of cacheMissByBucket) {
    push("cf_cache_miss", bucketTs, sum);
  }

  // firewall → cf_threats
  const threatsByBucket = new Map<number, number>();
  for (const g of zone.firewall ?? []) {
    const bucketTs = parseBucketTs(g.dimensions?.datetimeFiveMinutes);
    const action = g.dimensions?.action;
    if (bucketTs === null || typeof action !== "string") continue;
    if (!THREAT_ACTIONS.has(action)) continue;
    // firewallEventsAdaptiveGroups is not sampled — no sampleInterval field.
    threatsByBucket.set(
      bucketTs,
      (threatsByBucket.get(bucketTs) ?? 0) + g.count,
    );
  }
  for (const [bucketTs, sum] of threatsByBucket) {
    push("cf_threats", bucketTs, sum);
  }

  return { metrics, errors, maxSampleInterval };
}

// Cloudflare bot score: 1 = definitely automated, 99 = definitely human, and 0
// means "Not Computed" — which belongs in NEITHER bucket. Counting unscored
// traffic as human inflates the denominator and silences the detector; counting
// it as bot fires on every Cloudflare-handled path.
//
// ponytail: bot/human split hard-coded at 29, Cloudflare's own "likely
// automated" line. Promote to a per-monitor config field only if a zone needs a
// different split.
const BOT_SCORE_MAX = 29;
const VERIFIED_BOT_SRC = "Verified Bot";

export async function collectCloudflareBots(
  opts: CloudflareCollectorOptions,
): Promise<CloudflareCollectorResult> {
  const metrics: MetricRow[] = [];
  let maxSampleInterval = 1;

  const { zone, errors } = await postGraphQL<BotZone>(
    opts,
    CLOUDFLARE_BOT_QUERY,
  );
  if (!zone) {
    return { metrics, errors, maxSampleInterval };
  }

  const byBucket = new Map<
    number,
    { bot: number; human: number; verified: number }
  >();

  for (const g of zone.bots ?? []) {
    const bucketTs = parseBucketTs(g.dimensions?.datetimeFiveMinutes);
    const score = g.dimensions?.botScore;
    if (bucketTs === null || typeof score !== "number") continue;

    const sampleInterval = g.avg?.sampleInterval ?? 1;
    maxSampleInterval = Math.max(maxSampleInterval, sampleInterval);
    const trueCount = g.count * sampleInterval;

    let b = byBucket.get(bucketTs);
    if (!b) {
      b = { bot: 0, human: 0, verified: 0 };
      byBucket.set(bucketTs, b);
    }

    // botScoreSrc wins over the score: a verified Googlebot scores low and is
    // not the threat.
    if (g.dimensions?.botScoreSrc === VERIFIED_BOT_SRC) b.verified += trueCount;
    else if (score >= 1 && score <= BOT_SCORE_MAX) b.bot += trueCount;
    else if (score > BOT_SCORE_MAX) b.human += trueCount;
  }

  // Every bucket gets all three rows, zeros included. A missing cf_bot_requests
  // row silently deletes the detector's denominator and draws a fake gap in the
  // chart.
  for (const [bucketTs, b] of byBucket) {
    metrics.push(
      { monitor: opts.monitor, source: "cloudflare", metric: "cf_bot_requests", bucketTs, value: b.bot },
      { monitor: opts.monitor, source: "cloudflare", metric: "cf_human_requests", bucketTs, value: b.human },
      { monitor: opts.monitor, source: "cloudflare", metric: "cf_verified_bot_requests", bucketTs, value: b.verified },
    );
  }

  return { metrics, errors, maxSampleInterval };
}
