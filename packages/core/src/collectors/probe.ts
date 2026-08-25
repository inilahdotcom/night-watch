// HTTP uptime probe. Emits a ProbeResult in the shape the Stage 2 uptime
// detector already consumes, so the worker just wires the two together.
//
// The control-URL sanity check lives here but is a *separate* function —
// per brief §5.4 the worker runs the probe first, and only invokes the
// control check when the probe fails. Bundling them would double the
// outbound traffic every 60 seconds for no reason.

import type { ProbeContent, ProbeResult } from "../detectors/uptime.ts";
import { findForbidden } from "../detectors/content.ts";

export interface ProbeOptions {
  timeoutMs: number;
  expectStatusBelow: number;
  expectText?: string;
  /**
   * Terms that must not appear in the body. Supplying this (or `expectText`)
   * costs nothing extra: the body is read and drained on every request
   * regardless, so hashing and scanning it is pure CPU on bytes we already
   * have in hand.
   */
  forbidText?: readonly string[];
  /** Optional User-Agent override; useful for logs and to identify ourselves. */
  userAgent?: string;
}

function inspectBody(body: string, forbidText: readonly string[]): ProbeContent {
  return {
    bodyHash: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
    bodyBytes: Buffer.byteLength(body, "utf8"),
    forbidHits: findForbidden(body, forbidText),
  };
}

/**
 * Runs a single HTTP GET against `url`. Never throws — every failure mode
 * ends up in a `{ kind: 'fail', reason }` result so callers can uniformly
 * feed it into the uptime state machine.
 */
export async function probe(
  url: string,
  opts: ProbeOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const start = performance.now();

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": opts.userAgent ?? "night-watch/0.1 (+monitoring)",
      },
    });
    const latencyMs = Math.round(performance.now() - start);

    // Read the body once, unconditionally. It has to be drained anyway so the
    // socket returns to the pool, so reading it costs nothing we were not
    // already paying — and it is what every content check below works from.
    const body = await response.text().catch(() => "");
    const forbidText = opts.forbidText ?? [];
    const content = inspectBody(body, forbidText);

    if (response.status >= opts.expectStatusBelow) {
      return {
        kind: "fail",
        reason: `status ${response.status} >= ${opts.expectStatusBelow}`,
        status: response.status,
        latencyMs,
        content,
      };
    }

    if (opts.expectText && !body.includes(opts.expectText)) {
      return {
        kind: "fail",
        reason: `expected text not found in body`,
        status: response.status,
        latencyMs,
        content,
      };
    }

    return { kind: "ok", status: response.status, latencyMs, content };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    const name = (err as { name?: string }).name;
    const message = (err as Error).message ?? String(err);
    if (name === "AbortError" || name === "TimeoutError") {
      return { kind: "fail", reason: "timeout", latencyMs };
    }
    return { kind: "fail", reason: message, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reachability check for the monitor's OWN outbound network — this is what
 * separates "the site is down" from "the monitor can't reach anything right
 * now" (brief §5.4). Kept intentionally simple: any 2xx/3xx counts as
 * "network is fine".
 */
export async function checkControl(
  controlUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ reachable: boolean; reason: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(controlUrl, {
      method: "GET",
      signal: controller.signal,
    });
    await response.text().catch(() => "");
    if (response.status >= 500) {
      return {
        reachable: false,
        reason: `control returned ${response.status}`,
      };
    }
    return { reachable: true, reason: null };
  } catch (err) {
    const name = (err as { name?: string }).name;
    const message = (err as Error).message ?? String(err);
    if (name === "AbortError" || name === "TimeoutError") {
      return { reachable: false, reason: "control timeout" };
    }
    return { reachable: false, reason: message };
  } finally {
    clearTimeout(timer);
  }
}
