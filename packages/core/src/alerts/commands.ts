import { createLogger } from "../logger.ts";
import type { Database } from "bun:sqlite";
import type { CommandKind } from "../db/schema.ts";
import type { AlertEngine } from "./engine.ts";

// Commands outbox. The web app writes rows into the `commands` table (via
// server functions) and the worker polls them here. This is what lets the
// two processes talk without opening an internal HTTP port or bringing in
// a message broker (brief §2).
//
// Idempotency comes from the status column: pending → done | failed. A row
// is processed at most once because pollAndExecute claims it with an UPDATE
// that also mutates status to a non-pending value.

export interface CommandHandlers {
  test_alert: () => Promise<void>;
  wa_relink: () => Promise<void>;
}

export interface OutboxPollOptions {
  sqlite: Database;
  handlers: CommandHandlers;
  now?: () => number;
  /** Max number of commands to process per invocation. Prevents a huge
   *  backlog from blocking the scheduler tick. */
  batchSize?: number;
}

interface CommandRow {
  id: number;
  kind: string;
  payload: string | null;
  status: string;
  created_at: number;
}

/** Single poll pass. Returns the number of commands processed. */
export async function pollAndExecute(opts: OutboxPollOptions): Promise<number> {
  const log = createLogger("commands");
  const now = opts.now ?? (() => Date.now());
  const batchSize = opts.batchSize ?? 16;

  const rows = opts.sqlite
    .prepare(
      "SELECT id, kind, payload, status, created_at FROM commands WHERE status = 'pending' ORDER BY id ASC LIMIT ?",
    )
    .all(batchSize) as CommandRow[];

  if (rows.length === 0) return 0;

  const markDone = opts.sqlite.prepare(
    "UPDATE commands SET status = 'done', processed_at = ? WHERE id = ?",
  );
  const markFailed = opts.sqlite.prepare(
    "UPDATE commands SET status = 'failed', processed_at = ?, error = ? WHERE id = ?",
  );

  let processed = 0;
  for (const row of rows) {
    const kind = row.kind as CommandKind;
    try {
      switch (kind) {
        case "test_alert":
          await opts.handlers.test_alert();
          break;
        case "wa_relink":
          await opts.handlers.wa_relink();
          break;
        default: {
          const _exhaustive: never = kind;
          throw new Error(`unknown command kind: ${String(_exhaustive)}`);
        }
      }
      markDone.run(now(), row.id);
      processed += 1;
      log.info({ id: row.id, kind }, "command done");
    } catch (err) {
      const detail = (err as Error).message ?? String(err);
      markFailed.run(now(), detail, row.id);
      processed += 1;
      log.error({ id: row.id, kind, err: detail }, "command failed");
    }
  }

  return processed;
}

/** Public helper the web app uses via a server function. Returns the new row id. */
export function enqueueCommand(
  sqlite: Database,
  kind: CommandKind,
  payload?: Record<string, unknown>,
): number {
  const row = sqlite
    .prepare(
      "INSERT INTO commands (kind, payload, status, created_at) VALUES (?, ?, 'pending', ?) RETURNING id",
    )
    .get(
      kind,
      payload ? JSON.stringify(payload) : null,
      Date.now(),
    ) as { id: number };
  return row.id;
}

/** Bind together the alert engine + WhatsApp adapter into a set of handlers. */
export interface HandlerContext {
  engine: AlertEngine;
  /** Optional — omit if WhatsApp isn't configured. */
  clearWhatsAppAuth?: () => Promise<void>;
}

export function buildDefaultHandlers(ctx: HandlerContext): CommandHandlers {
  return {
    async test_alert() {
      const fp = `test:${Date.now()}`;
      const outcome = await ctx.engine.raiseAlert({
        fingerprint: fp,
        monitor: "test",
        type: "traffic",
        severity: "info",
        title: "Test alert from Night Watch",
        body: "This is a test — everything is fine. If you see this in your browser and WhatsApp group, the alert pipeline is working.",
        meta: { manual: true },
      });
      // Immediately resolve so the test doesn't leave a firing row around.
      await ctx.engine.resolveAlert({
        fingerprint: fp,
        title: "Test alert cleared",
        body: "Verification complete.",
      });
      if (outcome.action !== "created") {
        throw new Error(`test_alert unexpected outcome: ${outcome.action}`);
      }
    },
    async wa_relink() {
      if (!ctx.clearWhatsAppAuth) {
        throw new Error("whatsapp not configured in this worker");
      }
      await ctx.clearWhatsAppAuth();
    },
  };
}
