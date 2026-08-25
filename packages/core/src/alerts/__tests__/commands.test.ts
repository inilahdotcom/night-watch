import { Database } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import { applyAllMigrations } from "../../db/schema-sql.ts";
import {
  enqueueCommand,
  buildDefaultHandlers,
  pollAndExecute,
  type CommandHandlers,
} from "../commands.ts";

function newDb(): Database {
  const sqlite = new Database(":memory:");
  applyAllMigrations(sqlite);
  return sqlite;
}

function stubHandlers(overrides?: Partial<CommandHandlers>): CommandHandlers {
  return {
    test_alert: mock(async () => {}),
    wa_relink: mock(async () => {}),
    snooze: mock(async () => {}),
    unsnooze: mock(async () => {}),
    ack: mock(async () => {}),
    unack: mock(async () => {}),
    ...overrides,
  };
}

describe("enqueueCommand", () => {
  it("inserts a pending row and returns its id", () => {
    const sqlite = newDb();
    const id = enqueueCommand(sqlite, "test_alert", { note: "hi" });
    expect(id).toBeGreaterThan(0);
    const row = sqlite
      .prepare("SELECT kind, payload, status FROM commands WHERE id = ?")
      .get(id) as { kind: string; payload: string; status: string };
    expect(row.kind).toBe("test_alert");
    expect(row.status).toBe("pending");
    expect(JSON.parse(row.payload)).toEqual({ note: "hi" });
  });
});

describe("pollAndExecute", () => {
  it("returns 0 with no pending rows", async () => {
    const sqlite = newDb();
    const n = await pollAndExecute({ sqlite, handlers: stubHandlers() });
    expect(n).toBe(0);
  });

  it("processes a pending test_alert once, marks it done", async () => {
    const sqlite = newDb();
    const handlers = stubHandlers();
    const id = enqueueCommand(sqlite, "test_alert");
    const n = await pollAndExecute({ sqlite, handlers });
    expect(n).toBe(1);
    expect(handlers.test_alert).toHaveBeenCalledTimes(1);
    const row = sqlite
      .prepare("SELECT status, processed_at, error FROM commands WHERE id = ?")
      .get(id) as { status: string; processed_at: number; error: string | null };
    expect(row.status).toBe("done");
    expect(row.processed_at).toBeGreaterThan(0);
    expect(row.error).toBeNull();
  });

  it("marks failed with error text when the handler throws", async () => {
    const sqlite = newDb();
    const handlers = stubHandlers({
      test_alert: mock(async () => {
        throw new Error("kaboom");
      }),
    });
    const id = enqueueCommand(sqlite, "test_alert");
    await pollAndExecute({ sqlite, handlers });
    const row = sqlite
      .prepare("SELECT status, error FROM commands WHERE id = ?")
      .get(id) as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toBe("kaboom");
  });

  it("does not reprocess a done or failed row on the next poll", async () => {
    const sqlite = newDb();
    const handlers = stubHandlers();
    enqueueCommand(sqlite, "test_alert");
    await pollAndExecute({ sqlite, handlers });
    await pollAndExecute({ sqlite, handlers });
    expect(handlers.test_alert).toHaveBeenCalledTimes(1);
  });

  it("respects batchSize", async () => {
    const sqlite = newDb();
    const handlers = stubHandlers();
    for (let i = 0; i < 20; i += 1) enqueueCommand(sqlite, "test_alert");
    const n = await pollAndExecute({ sqlite, handlers, batchSize: 5 });
    expect(n).toBe(5);
    expect(handlers.test_alert).toHaveBeenCalledTimes(5);
    // 15 still pending
    const remaining = sqlite
      .prepare("SELECT COUNT(*) AS n FROM commands WHERE status = 'pending'")
      .get() as { n: number };
    expect(remaining.n).toBe(15);
  });

  it("routes wa_relink to the correct handler", async () => {
    const sqlite = newDb();
    const handlers = stubHandlers();
    enqueueCommand(sqlite, "wa_relink");
    await pollAndExecute({ sqlite, handlers });
    expect(handlers.wa_relink).toHaveBeenCalledTimes(1);
    expect(handlers.test_alert).not.toHaveBeenCalled();
  });

  it("routes snooze / unsnooze with parsed payloads", async () => {
    const sqlite = newDb();
    const handlers = stubHandlers();
    enqueueCommand(sqlite, "snooze", { scope: "global", durationMinutes: 15 });
    enqueueCommand(sqlite, "unsnooze", { scope: "global" });
    await pollAndExecute({ sqlite, handlers });
    expect(handlers.snooze).toHaveBeenCalledWith({
      scope: "global",
      durationMinutes: 15,
    });
    expect(handlers.unsnooze).toHaveBeenCalledWith({ scope: "global" });
  });
});

describe("ack / unack handlers", () => {
  function seedFiringAlert(sqlite: Database): number {
    const row = sqlite
      .prepare(
        `INSERT INTO alerts (fingerprint, monitor, type, severity, status, title, body, started_at, notify_count)
         VALUES ('m:traffic:spike', 'm', 'traffic', 'critical', 'firing', 't', 'b', 1000, 1)
         RETURNING id`,
      )
      .get() as { id: number };
    return row.id;
  }

  function handlers(sqlite: Database) {
    return buildDefaultHandlers({
      engine: {
        raiseAlert: async () => ({ alertId: 1, action: "created", channelResults: [] }),
        resolveAlert: async () => ({ alertId: 1, action: "resolved", channelResults: [] }),
      },
      sqlite,
    });
  }

  it("stamps acked_at and acked_by on a firing alert", async () => {
    const sqlite = newDb();
    const id = seedFiringAlert(sqlite);
    await handlers(sqlite).ack({ alertId: id, by: "alvin" });

    const row = sqlite
      .prepare("SELECT acked_at, acked_by FROM alerts WHERE id = ?")
      .get(id) as { acked_at: number | null; acked_by: string | null };
    expect(row.acked_at).toBeGreaterThan(0);
    expect(row.acked_by).toBe("alvin");
  });

  it("defaults the actor when none is supplied", async () => {
    const sqlite = newDb();
    const id = seedFiringAlert(sqlite);
    await handlers(sqlite).ack({ alertId: id });
    const row = sqlite.prepare("SELECT acked_by FROM alerts WHERE id = ?").get(id) as {
      acked_by: string;
    };
    expect(row.acked_by).toBe("dashboard");
  });

  it("unack clears the stamp", async () => {
    const sqlite = newDb();
    const id = seedFiringAlert(sqlite);
    await handlers(sqlite).ack({ alertId: id });
    await handlers(sqlite).unack({ alertId: id });
    const row = sqlite
      .prepare("SELECT acked_at, acked_by FROM alerts WHERE id = ?")
      .get(id) as { acked_at: number | null; acked_by: string | null };
    expect(row.acked_at).toBeNull();
    expect(row.acked_by).toBeNull();
  });

  it("refuses to ack a resolved alert rather than silently succeeding", async () => {
    const sqlite = newDb();
    const id = seedFiringAlert(sqlite);
    sqlite.prepare("UPDATE alerts SET status = 'resolved' WHERE id = ?").run(id);
    await expect(handlers(sqlite).ack({ alertId: id })).rejects.toThrow(
      /no firing alert/,
    );
  });

  it("refuses an unknown alert id", async () => {
    const sqlite = newDb();
    await expect(handlers(sqlite).ack({ alertId: 9999 })).rejects.toThrow(
      /no firing alert/,
    );
  });

  it("rejects a malformed payload", async () => {
    const sqlite = newDb();
    await expect(handlers(sqlite).ack({ alertId: -1 })).rejects.toThrow();
    await expect(handlers(sqlite).ack({})).rejects.toThrow();
  });
});
