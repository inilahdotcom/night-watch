import { describe, expect, it } from "bun:test";
import { collectGA4, type GA4Client } from "../ga4.ts";

function stubClient(
  runRealtimeReport: GA4Client["runRealtimeReport"],
): GA4Client {
  return { runRealtimeReport };
}

const BUCKET_TS = 1_780_000_000;

describe("collectGA4 — happy path", () => {
  it("maps activeUsers + screenPageViews into ga_active_users + ga_page_views", async () => {
    const client = stubClient(async () => [
      {
        metricHeaders: [
          { name: "activeUsers" },
          { name: "screenPageViews" },
        ],
        rows: [
          {
            metricValues: [{ value: "42" }, { value: "173" }],
          },
        ],
      },
    ]);
    const r = await collectGA4({
      propertyId: "12345",
      monitor: "example",
      bucketTs: BUCKET_TS,
      client,
    });
    expect(r.errors).toEqual([]);
    expect(r.metrics).toHaveLength(2);
    const users = r.metrics.find((m) => m.metric === "ga_active_users")!;
    const views = r.metrics.find((m) => m.metric === "ga_page_views")!;
    expect(users.value).toBe(42);
    expect(views.value).toBe(173);
    expect(users.source).toBe("ga4");
    expect(users.bucketTs).toBe(BUCKET_TS);
  });

  it("emits zeros when the response has no rows", async () => {
    const client = stubClient(async () => [{ metricHeaders: [], rows: [] }]);
    const r = await collectGA4({
      propertyId: "12345",
      monitor: "example",
      bucketTs: BUCKET_TS,
      client,
    });
    expect(r.metrics).toHaveLength(2);
    expect(r.metrics.every((m) => m.value === 0)).toBe(true);
  });
});

describe("collectGA4 — error handling", () => {
  it("returns an error (not a throw) when the API call rejects", async () => {
    const client = stubClient(async () => {
      throw new Error("PERMISSION_DENIED");
    });
    const r = await collectGA4({
      propertyId: "12345",
      monitor: "example",
      bucketTs: BUCKET_TS,
      client,
    });
    expect(r.metrics).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.code).toBe("GA4_TRANSPORT");
    expect(r.errors[0]!.message).toBe("PERMISSION_DENIED");
  });

  it("surfaces bad numeric values as errors, keeps going for other metrics", async () => {
    const client = stubClient(async () => [
      {
        metricHeaders: [
          { name: "activeUsers" },
          { name: "screenPageViews" },
        ],
        rows: [
          {
            metricValues: [{ value: "not a number" }, { value: "50" }],
          },
        ],
      },
    ]);
    const r = await collectGA4({
      propertyId: "12345",
      monitor: "example",
      bucketTs: BUCKET_TS,
      client,
    });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.code).toBe("BAD_METRIC_VALUE");
    expect(r.metrics).toHaveLength(1);
    expect(r.metrics[0]!.metric).toBe("ga_page_views");
  });

  it("ignores unknown metric headers instead of crashing", async () => {
    const client = stubClient(async () => [
      {
        metricHeaders: [{ name: "activeUsers" }, { name: "brandNewMetric" }],
        rows: [{ metricValues: [{ value: "10" }, { value: "99" }] }],
      },
    ]);
    const r = await collectGA4({
      propertyId: "12345",
      monitor: "example",
      bucketTs: BUCKET_TS,
      client,
    });
    expect(r.metrics).toHaveLength(1);
    expect(r.metrics[0]!.metric).toBe("ga_active_users");
    expect(r.errors).toEqual([]);
  });
});
