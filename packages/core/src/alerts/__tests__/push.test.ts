import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, expect, it } from "bun:test";
import * as schema from "../../db/schema.ts";
import { createPushChannel, type PushSender } from "../channels/push.ts";
import type { RenderedAlert } from "../types.ts";
import { applyAllMigrations } from "../../db/schema-sql.ts";

function newDb() {
  const sqlite = new Database(":memory:");
  applyAllMigrations(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function seedSubs(sqlite: Database, ...ids: number[]): void {
  const stmt = sqlite.prepare(
    "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const id of ids) {
    stmt.run(id, `https://push.example/${id}`, "p", "a", 0);
  }
}

const alert: RenderedAlert = {
  id: 1,
  fingerprint: "fp",
  monitor: "example",
  type: "traffic",
  severity: "critical",
  status: "firing",
  title: "Traffic spike",
  body: "up 4x",
  meta: {},
  startedAt: 0,
  resolvedAt: null,
  htmlBody: "<b>rendered</b>",
  textBody: "text",
  pushPayload: { severity: "critical" },
};

function makeSender(map: Record<string, { statusCode: number }>): PushSender {
  return {
    async send(sub) {
      const r = map[sub.endpoint];
      if (!r) throw new Error(`no mock for ${sub.endpoint}`);
      return r;
    },
  };
}

describe("push channel — readiness", () => {
  it("is not ready without VAPID keys", () => {
    const { db } = newDb();
    const ch = createPushChannel({
      db,
      vapidPublicKey: "",
      vapidPrivateKey: "",
      vapidSubject: "mailto:x@x",
    });
    expect(ch.isReady()).toBe(false);
  });

  it("is ready when both VAPID keys are set", () => {
    const { db } = newDb();
    const ch = createPushChannel({
      db,
      vapidPublicKey: "pk",
      vapidPrivateKey: "sk",
      vapidSubject: "mailto:x@x",
    });
    expect(ch.isReady()).toBe(true);
  });
});

describe("push channel — send", () => {
  it("returns ok=false with no subscriptions", async () => {
    const { db } = newDb();
    const ch = createPushChannel({
      db,
      vapidPublicKey: "pk",
      vapidPrivateKey: "sk",
      vapidSubject: "mailto:x@x",
      sender: makeSender({}),
    });
    const r = await ch.send(alert);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/no subscriptions/);
  });

  it("returns ok=true when at least one send succeeded", async () => {
    const { sqlite, db } = newDb();
    seedSubs(sqlite, 1, 2);
    const ch = createPushChannel({
      db,
      vapidPublicKey: "pk",
      vapidPrivateKey: "sk",
      vapidSubject: "mailto:x@x",
      sender: makeSender({
        "https://push.example/1": { statusCode: 201 },
        "https://push.example/2": { statusCode: 500 },
      }),
    });
    const r = await ch.send(alert);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/sent 1\/2/);
    expect(r.removeSubscriptionIds).toBeUndefined();
  });

  it("collects 404/410 subscriptions for the engine to drop", async () => {
    const { sqlite, db } = newDb();
    seedSubs(sqlite, 1, 2, 3);
    const ch = createPushChannel({
      db,
      vapidPublicKey: "pk",
      vapidPrivateKey: "sk",
      vapidSubject: "mailto:x@x",
      sender: makeSender({
        "https://push.example/1": { statusCode: 201 },
        "https://push.example/2": { statusCode: 410 }, // Gone
        "https://push.example/3": { statusCode: 404 }, // Not Found
      }),
    });
    const r = await ch.send(alert);
    expect(r.ok).toBe(true);
    expect(r.removeSubscriptionIds).toEqual([2, 3]);
    expect(r.detail).toMatch(/dropped 2/);
  });

  it("treats thrown WebPushError with 410 as remove", async () => {
    const { sqlite, db } = newDb();
    seedSubs(sqlite, 1);
    const ch = createPushChannel({
      db,
      vapidPublicKey: "pk",
      vapidPrivateKey: "sk",
      vapidSubject: "mailto:x@x",
      sender: {
        async send() {
          const err = new Error("gone") as Error & { statusCode: number };
          err.statusCode = 410;
          throw err;
        },
      },
    });
    const r = await ch.send(alert);
    expect(r.ok).toBe(false);
    expect(r.removeSubscriptionIds).toEqual([1]);
  });

  it("returns ok=false when every push failed and nothing was dropped", async () => {
    const { sqlite, db } = newDb();
    seedSubs(sqlite, 1, 2);
    const ch = createPushChannel({
      db,
      vapidPublicKey: "pk",
      vapidPrivateKey: "sk",
      vapidSubject: "mailto:x@x",
      sender: makeSender({
        "https://push.example/1": { statusCode: 500 },
        "https://push.example/2": { statusCode: 502 },
      }),
    });
    const r = await ch.send(alert);
    expect(r.ok).toBe(false);
    expect(r.removeSubscriptionIds).toBeUndefined();
  });
});
