import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, expect, it } from "bun:test";
import * as schema from "../../db/schema.ts";
import {
  enqueueCommand,
  subscribePush,
  unsubscribePush,
} from "../mutations.ts";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "migrations",
);

function newDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, "0000_init.sql"), "utf8"));
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe("subscribePush", () => {
  it("inserts a new subscription and returns its id", () => {
    const { db, sqlite } = newDb();
    const r = subscribePush(db, {
      endpoint: "https://push.example/xyz",
      p256dh: "pk",
      auth: "a",
      label: "phone",
    });
    expect(r.id).toBeGreaterThan(0);
    const row = sqlite
      .prepare("SELECT endpoint, label, fail_count FROM push_subscriptions WHERE id = ?")
      .get(r.id) as { endpoint: string; label: string; fail_count: number };
    expect(row.endpoint).toBe("https://push.example/xyz");
    expect(row.label).toBe("phone");
    expect(row.fail_count).toBe(0);
  });

  it("upserts on endpoint (same endpoint → same id, keys rotated)", () => {
    const { db, sqlite } = newDb();
    const r1 = subscribePush(db, {
      endpoint: "https://push.example/xyz",
      p256dh: "pk1",
      auth: "a1",
    });
    const r2 = subscribePush(db, {
      endpoint: "https://push.example/xyz",
      p256dh: "pk2",
      auth: "a2",
    });
    expect(r2.id).toBe(r1.id);
    const row = sqlite
      .prepare("SELECT p256dh, auth FROM push_subscriptions WHERE id = ?")
      .get(r2.id) as { p256dh: string; auth: string };
    expect(row.p256dh).toBe("pk2");
    expect(row.auth).toBe("a2");
  });

  it("resets failCount on re-subscribe (browser rotated key = fresh state)", () => {
    const { db, sqlite } = newDb();
    const r = subscribePush(db, {
      endpoint: "e1",
      p256dh: "p",
      auth: "a",
    });
    sqlite
      .prepare("UPDATE push_subscriptions SET fail_count = 5 WHERE id = ?")
      .run(r.id);
    subscribePush(db, { endpoint: "e1", p256dh: "p2", auth: "a2" });
    const row = sqlite
      .prepare("SELECT fail_count FROM push_subscriptions WHERE id = ?")
      .get(r.id) as { fail_count: number };
    expect(row.fail_count).toBe(0);
  });
});

describe("unsubscribePush", () => {
  it("removes by endpoint and returns count", () => {
    const { db } = newDb();
    subscribePush(db, { endpoint: "e1", p256dh: "p", auth: "a" });
    const r = unsubscribePush(db, "e1");
    expect(r.removed).toBe(1);
  });

  it("returns removed=0 for unknown endpoint", () => {
    const { db } = newDb();
    const r = unsubscribePush(db, "not-here");
    expect(r.removed).toBe(0);
  });
});

describe("enqueueCommand", () => {
  it("inserts a pending row", () => {
    const { sqlite } = newDb();
    const r = enqueueCommand(sqlite, "test_alert", { note: "hi" });
    expect(r.id).toBeGreaterThan(0);
    const row = sqlite
      .prepare("SELECT kind, payload, status FROM commands WHERE id = ?")
      .get(r.id) as { kind: string; payload: string; status: string };
    expect(row.kind).toBe("test_alert");
    expect(row.status).toBe("pending");
    expect(JSON.parse(row.payload)).toEqual({ note: "hi" });
  });
});

describe("mutations module — API surface", () => {
  it("exports exactly {subscribePush, unsubscribePush, enqueueCommand}", async () => {
    const mod = (await import("../mutations.ts")) as Record<string, unknown>;
    const publicKeys = Object.keys(mod).filter((k) => k !== "default").sort();
    expect(publicKeys).toEqual(
      ["enqueueCommand", "subscribePush", "unsubscribePush"].sort(),
    );
  });
});
