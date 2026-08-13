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

interface GraphQLResponse {
  data?: {
    viewer?: {
      zones?: Array<{
        total?: Array<TotalGroup>;
        byStatus?: Array<StatusGroup>;
        byCache?: Array<CacheGroup>;
        firewall?: Array<FirewallGroup>;
      }>;
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

export async function collectCloudflare(
  opts: CloudflareCollectorOptions,
): Promise<CloudflareCollectorResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const errors: CollectorError[] = [];
  const metrics: MetricRow[] = [];
  let maxSampleInterval = 1;

  const body = {
    query: CLOUDFLARE_QUERY,
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
      metrics,
      errors: [
        {
          code: "TRANSPORT",
          message: (err as Error).message ?? String(err),
        },
      ],
      maxSampleInterval,
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      metrics,
      errors: [
        {
          code: `HTTP_${response.status}`,
          message: text || response.statusText,
        },
      ],
      maxSampleInterval,
    };
  }

  const json = (await response.json().catch(() => null)) as
    | GraphQLResponse
    | null;
  if (!json) {
    return {
      metrics,
      errors: [{ code: "BAD_JSON", message: "response was not JSON" }],
      maxSampleInterval,
    };
  }

  if (json.errors && json.errors.length > 0) {
    for (const e of json.errors) {
      errors.push({
        code: e.extensions?.code ?? "GRAPHQL",
        message: e.message,
        path: e.path,
      });
    }
  }

  const zone = json.data?.viewer?.zones?.[0];
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
