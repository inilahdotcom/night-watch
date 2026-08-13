import { describe, expect, it } from "bun:test";
import { checkControl, probe } from "../probe.ts";

// Build a fake fetch that returns a canned response, optionally after a
// delay, and captures its invocation.
function makeFetch(config: {
  status?: number;
  body?: string;
  delayMs?: number;
  throwName?: string;
  throwMessage?: string;
}): typeof fetch {
  return (async (_input, init) => {
    if (config.delayMs && init?.signal) {
      // Race the delay against the abort signal.
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, config.delayMs);
        init.signal!.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("aborted");
          (err as { name?: string }).name = "AbortError";
          reject(err);
        });
      });
    }
    if (config.throwName) {
      const err = new Error(config.throwMessage ?? "boom");
      (err as { name?: string }).name = config.throwName;
      throw err;
    }
    return new Response(config.body ?? "OK", { status: config.status ?? 200 });
  }) as typeof fetch;
}

const BASE_OPTS = { timeoutMs: 1000, expectStatusBelow: 400 };

describe("probe — happy paths", () => {
  it("returns ok on 200 with no expectText", async () => {
    const r = await probe(
      "https://example.com",
      BASE_OPTS,
      makeFetch({ status: 200, body: "Hello" }),
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.status).toBe(200);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns ok when expectText is present", async () => {
    const r = await probe(
      "https://example.com",
      { ...BASE_OPTS, expectText: "Domain" },
      makeFetch({ status: 200, body: "Example Domain page" }),
    );
    expect(r.kind).toBe("ok");
  });
});

describe("probe — HTTP-level failures", () => {
  it("returns fail on a 500", async () => {
    const r = await probe(
      "https://example.com",
      BASE_OPTS,
      makeFetch({ status: 500, body: "err" }),
    );
    expect(r.kind).toBe("fail");
    if (r.kind === "fail") {
      expect(r.reason).toMatch(/status 500/);
      expect(r.status).toBe(500);
    }
  });

  it("returns fail on a 404 when expectStatusBelow=400", async () => {
    const r = await probe(
      "https://example.com",
      BASE_OPTS,
      makeFetch({ status: 404 }),
    );
    expect(r.kind).toBe("fail");
    if (r.kind === "fail") expect(r.status).toBe(404);
  });

  it("returns fail when expectText is missing — even on 200 (catches error page)", async () => {
    const r = await probe(
      "https://example.com",
      { ...BASE_OPTS, expectText: "IMPORTANT" },
      makeFetch({ status: 200, body: "generic error page" }),
    );
    expect(r.kind).toBe("fail");
    if (r.kind === "fail") {
      expect(r.reason).toMatch(/expected text/);
      expect(r.status).toBe(200);
    }
  });
});

describe("probe — timeouts and transport errors", () => {
  it("reports timeout when fetch exceeds timeoutMs", async () => {
    const r = await probe(
      "https://slow.example",
      { timeoutMs: 30, expectStatusBelow: 400 },
      makeFetch({ delayMs: 500, status: 200 }),
    );
    expect(r.kind).toBe("fail");
    if (r.kind === "fail") expect(r.reason).toBe("timeout");
  });

  it("passes through arbitrary transport errors as fail with message", async () => {
    const r = await probe(
      "https://broken.example",
      BASE_OPTS,
      makeFetch({ throwName: "TypeError", throwMessage: "fetch failed" }),
    );
    expect(r.kind).toBe("fail");
    if (r.kind === "fail") expect(r.reason).toBe("fetch failed");
  });
});

describe("checkControl", () => {
  it("returns reachable=true on 2xx", async () => {
    // Avoid status 204: the Response constructor rejects a body with 204/205/304.
    const r = await checkControl("https://1.1.1.1", 500, makeFetch({ status: 200, body: "ok" }));
    expect(r.reachable).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("returns reachable=false on 5xx", async () => {
    const r = await checkControl("https://1.1.1.1", 500, makeFetch({ status: 502 }));
    expect(r.reachable).toBe(false);
    expect(r.reason).toMatch(/502/);
  });

  it("returns reachable=false on timeout", async () => {
    const r = await checkControl(
      "https://1.1.1.1",
      30,
      makeFetch({ delayMs: 500 }),
    );
    expect(r.reachable).toBe(false);
    expect(r.reason).toMatch(/timeout/);
  });

  it("returns reachable=false on transport error", async () => {
    const r = await checkControl(
      "https://1.1.1.1",
      500,
      makeFetch({ throwName: "TypeError", throwMessage: "ENETUNREACH" }),
    );
    expect(r.reachable).toBe(false);
    expect(r.reason).toBe("ENETUNREACH");
  });
});
