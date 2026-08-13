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
