import { describe, expect, it } from "bun:test";
import { renderAlert } from "../render.ts";

const STARTED = 1786964400; // 2026-08-13 11:00:00 UTC (aligned)

const baseAlert = {
  id: 1,
  fingerprint: "fp",
  monitor: "example",
  type: "traffic" as const,
  severity: "critical" as const,
  status: "firing" as const,
  title: "Traffic spike detected",
  body: "Requests up 4× vs. seasonal median",
  meta: {},
  startedAt: STARTED,
  resolvedAt: null,
};

describe("renderAlert — firing critical", () => {
  const r = renderAlert(baseAlert, { utcOffsetHours: 7, timezoneLabel: "WIB" });

  it("includes severity emoji + title with bold heading", () => {
    expect(r.textBody).toContain("*🔴 CRITICAL — Traffic spike detected*");
  });

  it("includes monitor name and body", () => {
    expect(r.textBody).toContain("monitor: *example*");
    expect(r.textBody).toContain("Requests up 4×");
  });

  it("includes WIB local time (2026-08-13 11:00 UTC + 7h = 18:00 WIB)", () => {
    expect(r.textBody).toContain("18:00 WIB");
  });

  it("push payload sets requireInteraction=true for critical", () => {
    expect(r.pushPayload.requireInteraction).toBe(true);
    expect(r.pushPayload.severity).toBe("critical");
    expect(r.pushPayload.status).toBe("firing");
  });
});

describe("renderAlert — includes suggestedAction on critical DDoS", () => {
  const r = renderAlert(
    {
      ...baseAlert,
      type: "ddos",
      meta: { suggestedAction: "Enable Under Attack Mode" },
    },
    { utcOffsetHours: 7 },
  );
  it("appends the suggested action as a > blockquote", () => {
    expect(r.textBody).toContain("> Enable Under Attack Mode");
  });
});

describe("renderAlert — warning does not require interaction", () => {
  const r = renderAlert(
    { ...baseAlert, severity: "warning" },
    { utcOffsetHours: 7 },
  );
  it("push requireInteraction=false", () => {
    expect(r.pushPayload.requireInteraction).toBe(false);
  });
  it("uses the yellow warning tag", () => {
    expect(r.textBody).toContain("🟡 WARNING");
  });
});

describe("renderAlert — resolved uses recovery heading + duration", () => {
  const r = renderAlert(
    {
      ...baseAlert,
      status: "resolved",
      resolvedAt: STARTED + 630, // 10m 30s later
    },
    { utcOffsetHours: 7, timezoneLabel: "WIB" },
  );

  it("uses the ✅ recovered heading", () => {
    expect(r.textBody).toContain("✅ RECOVERED");
  });

  it("does NOT flag requireInteraction on recovery", () => {
    expect(r.pushPayload.requireInteraction).toBe(false);
  });

  it("prints a human duration (10m for 630s)", () => {
    expect(r.textBody).toContain("was firing for 10m");
  });

  it("does not append suggested action on recovery", () => {
    const r2 = renderAlert(
      {
        ...baseAlert,
        status: "resolved",
        resolvedAt: STARTED + 100,
        meta: { suggestedAction: "Enable Under Attack Mode" },
      },
      { utcOffsetHours: 7 },
    );
    expect(r2.textBody).not.toContain("Enable Under Attack Mode");
  });
});

describe("renderAlert — htmlBody for Telegram", () => {
  const r = renderAlert(baseAlert, { utcOffsetHours: 7, timezoneLabel: "WIB" });

  it("uses <b> tags and never leaks WhatsApp asterisks", () => {
    expect(r.htmlBody).toContain("<b>🔴 CRITICAL — Traffic spike detected</b>");
    expect(r.htmlBody).toContain("monitor: <b>example</b>");
    expect(r.htmlBody).not.toContain("*");
  });

  it("carries the same information as textBody, only marked up differently", () => {
    const strip = (s: string) =>
      s.replace(/<\/?b>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(strip(r.htmlBody)).toBe(r.textBody.replace(/\*/g, ""));
  });

  it("escapes angle brackets and ampersands in the alert body", () => {
    // Detector messages genuinely contain these — e.g. "z=-4.2 < -3.5" and
    // "cache miss & volume spike". Unescaped, Telegram rejects the message.
    const escaped = renderAlert(
      {
        ...baseAlert,
        body: "z=-4.2 < -3.5 & cache miss <b>not a tag</b>",
      },
      { utcOffsetHours: 7 },
    );
    expect(escaped.htmlBody).toContain("z=-4.2 &lt; -3.5 &amp; cache miss");
    expect(escaped.htmlBody).toContain("&lt;b&gt;not a tag&lt;/b&gt;");
    // The only real <b> tags are the three the renderer adds itself:
    // heading, monitor name, and the timestamp.
    expect(escaped.htmlBody.match(/<b>/g)).toHaveLength(3);
  });

  it("escapes a title that contains markup too", () => {
    const escaped = renderAlert(
      { ...baseAlert, title: "5xx > 10%" },
      { utcOffsetHours: 7 },
    );
    expect(escaped.htmlBody).toContain("5xx &gt; 10%");
  });
});
