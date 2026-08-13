import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../db/schema.ts";
import { createAlertEngine } from "../engine.ts";
import { parseQuietHours } from "../quiet-hours.ts";
import type {
  DeliveryResult,
  NotificationChannel,
  RenderedAlert,
} from "../types.ts";

// A single MemoryChannel captures everything sent, plus lets tests toggle
// readiness and force failures without any real network I/O.
class MemoryChannel implements NotificationChannel {
  readonly name = "push" as const;
  ready = true;
  responder: (a: RenderedAlert) => DeliveryResult = () => ({
    ok: true,
    detail: "delivered",
  });
  sends: RenderedAlert[] = [];

  isReady(): boolean {
    return this.ready;
  }

  async send(a: RenderedAlert): Promise<DeliveryResult> {
    this.sends.push(a);
    return this.responder(a);
  }
}

class MemoryWhatsApp implements NotificationChannel {
  readonly name = "whatsapp" as const;
  ready = true;
  sends: RenderedAlert[] = [];
  isReady(): boolean {
    return this.ready;
  }
  async send(a: RenderedAlert): Promise<DeliveryResult> {
    this.sends.push(a);
    return { ok: true, detail: "delivered" };
  }
}

// Load the schema by executing the init migration into an in-memory DB.
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "migrations",
);

function newDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const sql = readFileSync(join(MIGRATIONS_DIR, "0000_init.sql"), "utf8");
  sqlite.exec(sql);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

const NOW_ANCHOR = 1_800_000_000;
let clockOffset = 0;
function fakeNow() {
  return NOW_ANCHOR + clockOffset;
}

beforeEach(() => {
  clockOffset = 0;
});

function engineWith(
  channels: NotificationChannel[],
  overrides?: {
    cooldownMinutes?: number;
    notifyOnResolve?: boolean;
    quietHours?: string | null;
  },
) {
  const { sqlite, db } = newDb();
  const engine = createAlertEngine({
    db,
    sqlite,
    channels,
    cooldownMinutes: overrides?.cooldownMinutes ?? 15,
    notifyOnResolve: overrides?.notifyOnResolve ?? true,
    quietHours: parseQuietHours(overrides?.quietHours ?? null),
    utcOffsetHours: 7,
    timezoneLabel: "WIB",
    now: fakeNow,
  });
  return { engine, sqlite, db };
}

const BASE_INPUT = {
  fingerprint: "example:traffic-spike",
  monitor: "example",
  type: "traffic" as const,
  severity: "warning" as const,
  title: "Traffic spike",
  body: "Requests up 4×",
};

describe("raiseAlert — creation", () => {
  it("inserts a firing row and notifies every ready channel exactly once", async () => {
    const push = new MemoryChannel();
    const wa = new MemoryWhatsApp();
    const { engine, sqlite } = engineWith([push, wa]);
    const r = await engine.raiseAlert(BASE_INPUT);
    expect(r.action).toBe("created");
    expect(r.alertId).toBeGreaterThan(0);
    expect(push.sends).toHaveLength(1);
    expect(wa.sends).toHaveLength(1);

    // deliveries table
    const deliveryRows = sqlite
      .prepare("SELECT * FROM deliveries WHERE alert_id = ?")
      .all(r.alertId) as Array<{ channel: string; status: string }>;
    expect(deliveryRows).toHaveLength(2);
    expect(deliveryRows.every((d) => d.status === "sent")).toBe(true);
  });

  it("increments notify_count on delivery", async () => {
    const push = new MemoryChannel();
    const { engine, sqlite } = engineWith([push]);
    const r = await engine.raiseAlert(BASE_INPUT);
    const row = sqlite
      .prepare("SELECT notify_count, last_notified_at FROM alerts WHERE id = ?")
      .get(r.alertId) as { notify_count: number; last_notified_at: number };
    expect(row.notify_count).toBe(1);
    expect(row.last_notified_at).toBe(NOW_ANCHOR);
  });
});

describe("raiseAlert — idempotency (already firing)", () => {
  it("updates details but does NOT re-notify a firing warning", async () => {
    const push = new MemoryChannel();
    const { engine, sqlite } = engineWith([push]);
    const first = await engine.raiseAlert(BASE_INPUT);
    expect(push.sends).toHaveLength(1);

    clockOffset += 60; // 1 minute later
    const second = await engine.raiseAlert({
      ...BASE_INPUT,
      body: "Requests up 5× (refined)",
    });

    expect(second.action).toBe("updated-silent");
    expect(second.alertId).toBe(first.alertId);
    expect(push.sends).toHaveLength(1); // NOT re-sent

    // Details updated in DB
    const row = sqlite
      .prepare("SELECT body FROM alerts WHERE id = ?")
      .get(first.alertId) as { body: string };
    expect(row.body).toContain("5×");
  });
});

describe("raiseAlert — escalation warning → critical", () => {
  it("always notifies immediately, regardless of cooldown", async () => {
    const push = new MemoryChannel();
    const { engine } = engineWith([push], { cooldownMinutes: 60 });
    await engine.raiseAlert(BASE_INPUT); // warning
    expect(push.sends).toHaveLength(1);

    clockOffset += 30; // half a minute — well inside cooldown
    const r = await engine.raiseAlert({ ...BASE_INPUT, severity: "critical" });
    expect(r.action).toBe("escalated");
    expect(push.sends).toHaveLength(2);
    expect(push.sends[1]!.severity).toBe("critical");
  });
});

describe("raiseAlert — critical cooldown", () => {
  const critical = { ...BASE_INPUT, severity: "critical" as const };

  it("does NOT re-notify a firing critical before cooldown elapses", async () => {
    const push = new MemoryChannel();
    const { engine } = engineWith([push], { cooldownMinutes: 15 });
    await engine.raiseAlert(critical);
    expect(push.sends).toHaveLength(1);

    clockOffset += 10 * 60; // 10 minutes — cooldown is 15
    const r = await engine.raiseAlert(critical);
    expect(r.action).toBe("updated-silent");
    expect(push.sends).toHaveLength(1);
  });

  it("re-notifies once cooldown has elapsed", async () => {
    const push = new MemoryChannel();
    const { engine } = engineWith([push], { cooldownMinutes: 15 });
    await engine.raiseAlert(critical);
    clockOffset += 16 * 60;
    const r = await engine.raiseAlert(critical);
    expect(r.action).toBe("updated-notified");
    expect(push.sends).toHaveLength(2);
  });
});

describe("resolveAlert", () => {
  it("closes the alert and (when configured) notifies the same channels", async () => {
    const push = new MemoryChannel();
    const wa = new MemoryWhatsApp();
    const { engine, sqlite } = engineWith([push, wa]);
    const raised = await engine.raiseAlert(BASE_INPUT);
    push.sends.length = 0;
    wa.sends.length = 0;

    clockOffset += 300;
    const r = await engine.resolveAlert({
      fingerprint: BASE_INPUT.fingerprint,
    });
    expect(r.action).toBe("resolved");
    expect(r.alertId).toBe(raised.alertId);
    expect(push.sends).toHaveLength(1);
    expect(push.sends[0]!.status).toBe("resolved");
    expect(wa.sends).toHaveLength(1);
    expect(wa.sends[0]!.status).toBe("resolved");

    const row = sqlite
      .prepare("SELECT status, resolved_at FROM alerts WHERE id = ?")
      .get(raised.alertId) as { status: string; resolved_at: number };
    expect(row.status).toBe("resolved");
    expect(row.resolved_at).toBe(NOW_ANCHOR + 300);
  });

  it("closes the alert but suppresses notify when notifyOnResolve=false", async () => {
    const push = new MemoryChannel();
    const { engine } = engineWith([push], { notifyOnResolve: false });
    await engine.raiseAlert(BASE_INPUT);
    push.sends.length = 0;
    const r = await engine.resolveAlert({ fingerprint: BASE_INPUT.fingerprint });
    expect(r.action).toBe("resolved");
    expect(push.sends).toHaveLength(0);
  });

  it("returns not-found and sends nothing when no firing alert matches", async () => {
    const push = new MemoryChannel();
    const { engine } = engineWith([push]);
    const r = await engine.resolveAlert({ fingerprint: "does-not-exist" });
    expect(r.action).toBe("not-found");
    expect(r.alertId).toBeNull();
    expect(push.sends).toHaveLength(0);
  });
});

describe("engine — quiet hours behaviour", () => {
  // NOW_ANCHOR = 1_800_000_000. Let's compute its WIB hour.
  // 1_800_000_000 UTC seconds = 2027-01-15 08:00:00 UTC. In WIB (+7) = 15:00.
  // So NOW_ANCHOR is 15:00 WIB. Quiet window "10:00-16:00" covers that;
  // "22:00-07:00" does not.

  it("mutes WhatsApp for warning during quiet hours; push still fires", async () => {
    const push = new MemoryChannel();
    const wa = new MemoryWhatsApp();
    const { engine, sqlite } = engineWith([push, wa], {
      quietHours: "10:00-16:00",
    });
    const r = await engine.raiseAlert(BASE_INPUT); // severity: warning
    expect(push.sends).toHaveLength(1);
    expect(wa.sends).toHaveLength(0);

    const rows = sqlite
      .prepare(
        "SELECT channel, status, detail FROM deliveries WHERE alert_id = ?",
      )
      .all(r.alertId) as Array<{ channel: string; status: string; detail: string }>;
    const waRow = rows.find((r) => r.channel === "whatsapp")!;
    expect(waRow.status).toBe("skipped");
    expect(waRow.detail).toMatch(/quiet/);
  });

  it("critical breaks through quiet hours", async () => {
    const push = new MemoryChannel();
    const wa = new MemoryWhatsApp();
    const { engine } = engineWith([push, wa], {
      quietHours: "10:00-16:00",
    });
    await engine.raiseAlert({ ...BASE_INPUT, severity: "critical" });
    expect(push.sends).toHaveLength(1);
    expect(wa.sends).toHaveLength(1);
  });
});

describe("engine — channel readiness and cleanup", () => {
  it("records skipped when a channel says not-ready", async () => {
    const push = new MemoryChannel();
    push.ready = false;
    const { engine, sqlite } = engineWith([push]);
    const r = await engine.raiseAlert(BASE_INPUT);
    expect(push.sends).toHaveLength(0);
    const row = sqlite
      .prepare("SELECT status, detail FROM deliveries WHERE alert_id = ?")
      .get(r.alertId) as { status: string; detail: string };
    expect(row.status).toBe("skipped");
    expect(row.detail).toMatch(/not ready/);
  });

  it("removes push subscriptions listed in removeSubscriptionIds", async () => {
    const push = new MemoryChannel();
    push.responder = () => ({
      ok: false,
      detail: "410 gone",
      removeSubscriptionIds: [1],
    });
    const { engine, sqlite } = engineWith([push]);
    sqlite
      .prepare(
        "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(1, "https://push.example/xyz", "p", "a", NOW_ANCHOR);
    await engine.raiseAlert(BASE_INPUT);
    const remaining = sqlite
      .prepare("SELECT COUNT(*) as n FROM push_subscriptions")
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});
