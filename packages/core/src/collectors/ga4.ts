import type { MetricRow } from "./cloudflare.ts";
import type { CollectorError } from "./cloudflare.ts";

// GA4 Realtime collector. Per brief §9, the Realtime API returns a snapshot,
// not a time series — every poll produces exactly one bucket-row for the
// metrics we care about (active users, page views). The worker's cadence
// decides how often we sample it.

export interface GA4CollectorOptions {
  propertyId: string;
  monitor: string;
  /** The bucket to attribute this snapshot to (unix seconds). */
  bucketTs: number;
  keyFilename?: string;
  /**
   * Injected client for tests. Defaults to the real
   * @google-analytics/data BetaAnalyticsDataClient.
   */
  client?: GA4Client;
}

export interface GA4CollectorResult {
  metrics: MetricRow[];
  errors: CollectorError[];
}

/** Minimum surface of the SDK client we depend on — makes it easy to mock. */
export interface GA4Client {
  runRealtimeReport(request: {
    property: string;
    metrics: Array<{ name: string }>;
  }): Promise<
    [
      {
        rows?: Array<{
          metricValues?: Array<{ value?: string | null }>;
        }>;
        metricHeaders?: Array<{ name?: string | null }>;
      },
      ...unknown[],
    ]
  >;
}

// Which realtime metrics we ask for, and how to map them into our schema.
const METRIC_REQUEST = [
  { name: "activeUsers" },
  { name: "screenPageViews" },
];
const METRIC_MAP: Record<string, "ga_active_users" | "ga_page_views"> = {
  activeUsers: "ga_active_users",
  screenPageViews: "ga_page_views",
};

async function makeDefaultClient(keyFilename?: string): Promise<GA4Client> {
  // Dynamic import so this module doesn't drag the SDK into contexts that
  // never use it (e.g. the seed CLI). The SDK is heavy.
  const mod = await import("@google-analytics/data");
  const Ctor = mod.BetaAnalyticsDataClient;
  return new Ctor(keyFilename ? { keyFilename } : {}) as unknown as GA4Client;
}

export async function collectGA4(
  opts: GA4CollectorOptions,
): Promise<GA4CollectorResult> {
  const errors: CollectorError[] = [];
  const metrics: MetricRow[] = [];

  let client: GA4Client;
  try {
    client = opts.client ?? (await makeDefaultClient(opts.keyFilename));
  } catch (err) {
    return {
      metrics,
      errors: [
        {
          code: "CLIENT_INIT",
          message: (err as Error).message ?? String(err),
        },
      ],
    };
  }

  let response: Awaited<ReturnType<GA4Client["runRealtimeReport"]>>[0];
  try {
    [response] = await client.runRealtimeReport({
      property: `properties/${opts.propertyId}`,
      metrics: METRIC_REQUEST,
    });
  } catch (err) {
    return {
      metrics,
      errors: [
        {
          code: "GA4_TRANSPORT",
          message: (err as Error).message ?? String(err),
        },
      ],
    };
  }

  const headers = (response.metricHeaders ?? []).map((h) => h.name ?? "");
  const row = response.rows?.[0];
  if (!row) {
    // No rows means literally zero active users. Still record a zero so the
    // baseline reflects "we polled and got a definitive nothing", not a gap.
    for (const req of METRIC_REQUEST) {
      const metric = METRIC_MAP[req.name];
      if (!metric) continue;
      metrics.push({
        monitor: opts.monitor,
        source: "ga4",
        metric,
        bucketTs: opts.bucketTs,
        value: 0,
      });
    }
    return { metrics, errors };
  }

  for (let i = 0; i < headers.length; i += 1) {
    const headerName = headers[i]!;
    const metric = METRIC_MAP[headerName];
    if (!metric) continue;
    const raw = row.metricValues?.[i]?.value;
    const value = raw ? Number.parseFloat(raw) : 0;
    if (!Number.isFinite(value)) {
      errors.push({
        code: "BAD_METRIC_VALUE",
        message: `non-numeric value for ${headerName}: ${String(raw)}`,
      });
      continue;
    }
    metrics.push({
      monitor: opts.monitor,
      source: "ga4",
      metric,
      bucketTs: opts.bucketTs,
      value,
    });
  }

  return { metrics, errors };
}
