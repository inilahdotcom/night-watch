import { describe, expect, it } from "bun:test";
import {
  CLOUDFLARE_QUERY,
  collectCloudflare,
  collectCloudflareBots,
  parseBucketTs,
  type MetricRow,
} from "../cloudflare.ts";

// ---------------------------------------------------------------------------
// Helpers to build a fake fetch that returns a canned GraphQL payload.
// ---------------------------------------------------------------------------

function fakeFetch(payload: unknown, opts?: { status?: number }): typeof fetch {
  return ((async () =>
    new Response(JSON.stringify(payload), {
      status: opts?.status ?? 200,
      headers: { "content-type": "application/json" },
    })) as unknown) as typeof fetch;
}

const BASE_TS = 1_780_000_000; // aligned enough for tests
const BUCKET_ISO_A = new Date(BASE_TS * 1000).toISOString();
const BUCKET_ISO_B = new Date((BASE_TS + 300) * 1000).toISOString();

function callOpts(fetchImpl: typeof fetch, overrides?: Partial<Parameters<typeof collectCloudflare>[0]>) {
  return {
    zoneId: "zone-x",
    apiToken: "tok",
    monitor: "example",
    sinceTs: BASE_TS,
    untilTs: BASE_TS + 900,
    fetchImpl,
    ...(overrides ?? {}),
  };
}

function metricsFor(rows: readonly MetricRow[], metric: string) {
  return rows
    .filter((r) => r.metric === metric)
    .sort((a, b) => a.bucketTs - b.bucketTs);
}

// ---------------------------------------------------------------------------

describe("parseBucketTs", () => {
  it("returns unix seconds for a valid ISO", () => {
    expect(parseBucketTs("1970-01-01T00:00:00Z")).toBe(0);
    // 2026-08-13T11:00:00Z → Date.parse says 1786618800 (millisecond precision, then /1000)
    expect(parseBucketTs("2026-08-13T11:00:00Z")).toBe(1786618800);
  });

  it("returns null on garbage or missing input", () => {
    expect(parseBucketTs(undefined)).toBeNull();
    expect(parseBucketTs("not a date")).toBeNull();
  });
});

describe("collectCloudflare — happy path", () => {
  const payload = {
    data: {
      viewer: {
        zones: [
          {
            total: [
              {
                count: 100,
                sum: { edgeResponseBytes: 5_000_000 },
                avg: { sampleInterval: 1 },
                dimensions: { datetimeFiveMinutes: BUCKET_ISO_A },
              },
              {
                count: 120,
                sum: { edgeResponseBytes: 6_000_000 },
                avg: { sampleInterval: 1 },
                dimensions: { datetimeFiveMinutes: BUCKET_ISO_B },
              },
            ],
            byStatus: [
              {
                count: 5,
                avg: { sampleInterval: 1 },
                dimensions: {
                  datetimeFiveMinutes: BUCKET_ISO_A,
                  edgeResponseStatus: 502,
                },
              },
              {
                count: 2,
                avg: { sampleInterval: 1 },
                dimensions: {
                  datetimeFiveMinutes: BUCKET_ISO_A,
                  edgeResponseStatus: 429,
                },
              },
              {
                count: 3,
                avg: { sampleInterval: 1 },
                dimensions: {
                  datetimeFiveMinutes: BUCKET_ISO_A,
                  edgeResponseStatus: 404,
                },
              },
            ],
            byCache: [
              {
                count: 40,
                avg: { sampleInterval: 1 },
                dimensions: {
                  datetimeFiveMinutes: BUCKET_ISO_A,
                  cacheStatus: "miss",
                },
              },
              {
                count: 10,
                avg: { sampleInterval: 1 },
                dimensions: {
                  datetimeFiveMinutes: BUCKET_ISO_A,
                  cacheStatus: "expired",
                },
              },
              {
                count: 60,
                avg: { sampleInterval: 1 },
                dimensions: {
                  datetimeFiveMinutes: BUCKET_ISO_A,
                  cacheStatus: "hit",
                },
              },
            ],
            firewall: [
              {
                count: 12,
                dimensions: {
                  datetimeFiveMinutes: BUCKET_ISO_A,
                  action: "block",
                },
              },
              {
                count: 3,
                dimensions: {
                  datetimeFiveMinutes: BUCKET_ISO_A,
                  action: "log", // NOT a threat action — ignored
                },
              },
              {
                count: 4,
                dimensions: {
                  datetimeFiveMinutes: BUCKET_ISO_A,
                  action: "managed_challenge",
                },
              },
            ],
          },
        ],
      },
    },
  };

  it("emits cf_requests + cf_bytes for every total bucket", async () => {
    const r = await collectCloudflare(callOpts(fakeFetch(payload)));
    expect(r.errors).toEqual([]);
    const requests = metricsFor(r.metrics, "cf_requests");
    const bytes = metricsFor(r.metrics, "cf_bytes");
    expect(requests).toHaveLength(2);
    expect(bytes).toHaveLength(2);
    expect(requests[0]!.value).toBe(100);
    expect(requests[1]!.value).toBe(120);
    expect(bytes[0]!.value).toBe(5_000_000);
  });

  it("folds status buckets into cf_status_5xx / 4xx / 429 correctly", async () => {
    const r = await collectCloudflare(callOpts(fakeFetch(payload)));
    const s5xx = metricsFor(r.metrics, "cf_status_5xx");
    const s4xx = metricsFor(r.metrics, "cf_status_4xx");
    const s429 = metricsFor(r.metrics, "cf_status_429");
    expect(s5xx).toHaveLength(1);
    expect(s5xx[0]!.value).toBe(5); // just the 502
    expect(s429[0]!.value).toBe(2);
    // 429 is folded into 4xx AND its own bucket:
    expect(s4xx[0]!.value).toBe(3 + 2); // 404 + 429
  });

  it("counts cache-miss states (miss + expired) but not hit", async () => {
    const r = await collectCloudflare(callOpts(fakeFetch(payload)));
    const miss = metricsFor(r.metrics, "cf_cache_miss");
    expect(miss).toHaveLength(1);
    expect(miss[0]!.value).toBe(50); // 40 + 10
  });

  it("only counts firewall threat actions (block, challenge, managed_challenge)", async () => {
    const r = await collectCloudflare(callOpts(fakeFetch(payload)));
    const threats = metricsFor(r.metrics, "cf_threats");
    expect(threats).toHaveLength(1);
    expect(threats[0]!.value).toBe(16); // 12 block + 4 managed_challenge
  });

  it("tags every emitted row with source=cloudflare and the requested monitor", async () => {
    const r = await collectCloudflare(callOpts(fakeFetch(payload)));
    for (const row of r.metrics) {
      expect(row.source).toBe("cloudflare");
      expect(row.monitor).toBe("example");
    }
  });
});

describe("collectCloudflare — sampling correction (brief §9)", () => {
  it("multiplies count by sampleInterval for adaptive groups", async () => {
    const payload = {
      data: {
        viewer: {
          zones: [
            {
              total: [
                {
                  count: 1000,
                  sum: { edgeResponseBytes: 1 },
                  avg: { sampleInterval: 10 }, // 10× sampling
                  dimensions: { datetimeFiveMinutes: BUCKET_ISO_A },
                },
              ],
              byStatus: [
                {
                  count: 50,
                  avg: { sampleInterval: 10 },
                  dimensions: {
                    datetimeFiveMinutes: BUCKET_ISO_A,
                    edgeResponseStatus: 500,
                  },
                },
              ],
              byCache: [],
              firewall: [
                {
                  count: 4,
                  dimensions: {
                    datetimeFiveMinutes: BUCKET_ISO_A,
                    action: "block",
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const r = await collectCloudflare(callOpts(fakeFetch(payload)));
    expect(metricsFor(r.metrics, "cf_requests")[0]!.value).toBe(10_000);
    expect(metricsFor(r.metrics, "cf_status_5xx")[0]!.value).toBe(500);
    // firewall is NOT sampled — count stays raw.
    expect(metricsFor(r.metrics, "cf_threats")[0]!.value).toBe(4);
    expect(r.maxSampleInterval).toBe(10);
  });
});

describe("collectCloudflare — error surfacing", () => {
  it("returns GraphQL errors in .errors, does not throw", async () => {
    const payload = {
      errors: [
        {
          message: "field not available on this plan",
          extensions: { code: "PLAN_LIMIT" },
          path: ["viewer", "zones", 0, "firewall"],
        },
      ],
      data: { viewer: { zones: [{ total: [], byStatus: [], byCache: [], firewall: [] }] } },
    };
    const r = await collectCloudflare(callOpts(fakeFetch(payload)));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.code).toBe("PLAN_LIMIT");
    expect(r.metrics).toEqual([]);
  });

  it("surfaces HTTP errors with body text", async () => {
    const fetchImpl = ((async () =>
      new Response("unauthorized", { status: 401 })) as unknown) as typeof fetch;
    const r = await collectCloudflare(callOpts(fetchImpl));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.code).toBe("HTTP_401");
    expect(r.errors[0]!.message).toMatch(/unauthorized/);
  });

  it("surfaces transport errors without throwing", async () => {
    const fetchImpl = ((async () => {
      throw new Error("ECONNRESET");
    }) as unknown) as typeof fetch;
    const r = await collectCloudflare(callOpts(fetchImpl));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.code).toBe("TRANSPORT");
    expect(r.errors[0]!.message).toBe("ECONNRESET");
  });

  it("handles a missing zone gracefully (wrong zone id)", async () => {
    const r = await collectCloudflare(
      callOpts(fakeFetch({ data: { viewer: { zones: [] } } })),
    );
    expect(r.metrics).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});

describe("collectCloudflare — request shape", () => {
  it("sends the query + variables via POST with the bearer token", async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fetchImpl = (async (url, init) => {
      captured = { url: url.toString(), init };
      return new Response(
        JSON.stringify({ data: { viewer: { zones: [] } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    await collectCloudflare(callOpts(fetchImpl, { endpoint: "https://cf-mock/gql" }));
    expect(captured.url).toBe("https://cf-mock/gql");
    expect(captured.init?.method).toBe("POST");
    const headers = new Headers(captured.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer tok");
    const body = JSON.parse(captured.init?.body as string) as {
      variables: { zoneTag: string; since: string; until: string };
      query: string;
    };
    expect(body.variables.zoneTag).toBe("zone-x");
    expect(body.query).toContain("httpRequestsAdaptiveGroups");
    expect(body.query).toContain("firewallEventsAdaptiveGroups");
  });
});

// ---------------------------------------------------------------------------
// Bot scoring — a SECOND document, deliberately kept out of the main one.
// ---------------------------------------------------------------------------

function botGroup(
  iso: string,
  botScore: number,
  count: number,
  botScoreSrc = "Heuristics",
  sampleInterval = 1,
) {
  return {
    count,
    avg: { sampleInterval },
    dimensions: { datetimeFiveMinutes: iso, botScore, botScoreSrc },
  };
}

function botPayload(groups: unknown[]) {
  return { data: { viewer: { zones: [{ bots: groups }] } } };
}

describe("collectCloudflareBots — score fold", () => {
  it("splits scores into bot / human and ignores score 0", async () => {
    const r = await collectCloudflareBots(
      callOpts(
        fakeFetch(
          botPayload([
            botGroup(BUCKET_ISO_A, 5, 10),
            botGroup(BUCKET_ISO_A, 20, 30),
            botGroup(BUCKET_ISO_A, 45, 100),
            botGroup(BUCKET_ISO_A, 90, 200),
            // "Not Computed" — belongs in neither bucket.
            botGroup(BUCKET_ISO_A, 0, 5000, "Not Computed"),
          ]),
        ),
      ),
    );
    expect(metricsFor(r.metrics, "cf_bot_requests")[0]!.value).toBe(40);
    expect(metricsFor(r.metrics, "cf_human_requests")[0]!.value).toBe(300);
    expect(metricsFor(r.metrics, "cf_verified_bot_requests")[0]!.value).toBe(0);
  });

  it("routes verified bots away from cf_bot_requests despite a low score", async () => {
    const r = await collectCloudflareBots(
      callOpts(
        fakeFetch(
          botPayload([
            botGroup(BUCKET_ISO_A, 3, 500, "Verified Bot"),
            botGroup(BUCKET_ISO_A, 10, 25),
          ]),
        ),
      ),
    );
    expect(metricsFor(r.metrics, "cf_verified_bot_requests")[0]!.value).toBe(500);
    expect(metricsFor(r.metrics, "cf_bot_requests")[0]!.value).toBe(25);
  });

  it("emits all three metrics per bucket, zeros included", async () => {
    const r = await collectCloudflareBots(
      callOpts(
        fakeFetch(
          botPayload([
            botGroup(BUCKET_ISO_A, 90, 10),
            botGroup(BUCKET_ISO_B, 90, 20),
          ]),
        ),
      ),
    );
    expect(r.metrics).toHaveLength(6);
    expect(metricsFor(r.metrics, "cf_bot_requests").map((m) => m.value)).toEqual([
      0, 0,
    ]);
  });

  it("multiplies count by sampleInterval", async () => {
    const r = await collectCloudflareBots(
      callOpts(
        fakeFetch(botPayload([botGroup(BUCKET_ISO_A, 5, 10, "Heuristics", 10)])),
      ),
    );
    expect(metricsFor(r.metrics, "cf_bot_requests")[0]!.value).toBe(100);
    expect(r.maxSampleInterval).toBe(10);
  });
});

describe("collectCloudflareBots — graceful degradation", () => {
  it("returns zero rows and one error when the zone rejects botScore", async () => {
    const r = await collectCloudflareBots(
      callOpts(
        fakeFetch({
          errors: [
            {
              message: "Unknown field botScore",
              extensions: { code: "validation" },
            },
          ],
        }),
      ),
    );
    expect(r.metrics).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.code).toBe("validation");
  });

  it("keeps the bot dimensions out of the main document", () => {
    // Merging the two documents would let a plan-rejection take cf_requests,
    // cf_threats and every cf_status_* down with it.
    expect(CLOUDFLARE_QUERY).not.toContain("botScore");
  });
});
