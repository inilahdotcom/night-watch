import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, mock } from "bun:test";
import {
  enqueueCommand,
  pollAndExecute,
  type CommandHandlers,
} from "../commands.ts";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "migrations",
);

function newDb(): Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, "0000_init.sql"), "utf8"));
  return sqlite;
}

function stubHandlers(overrides?: Partial<CommandHandlers>): CommandHandlers {
  return {
    test_alert: mock(async () => {}),
    wa_relink: mock(async () => {}),
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
});
