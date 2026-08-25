import { createLogger } from "../../logger.ts";
import type { Database } from "bun:sqlite";
import type {
  DeliveryResult,
  NotificationChannel,
  RenderedAlert,
} from "../types.ts";

// WhatsApp channel — reachable only via Baileys (brief §1: Cloud API can't
// send to groups). The reconnect/backoff/QR flow lives in the Baileys
// adapter; this wrapper handles the parts that can be unit-tested:
//
//   - queueing sends when the socket is down (bounded at 50 to prevent
//     unbounded growth during long outages),
//   - draining the queue on reconnect with 1.2s pacing so the group
//     doesn't get rate-limited,
//   - persisting logged-out state to system_state so the dashboard can
//     surface the "please rescan the QR" call to action.

export interface WhatsAppSocketState {
  kind: "connecting" | "connected" | "disconnected" | "logged-out";
  reason?: string;
}

/**
 * Interface the wrapper depends on. Tests supply a StubAdapter; production
 * gets the Baileys implementation in ./whatsapp-baileys.ts.
 */
export interface WhatsAppAdapter {
  isConnected(): boolean;
  sendText(jid: string, text: string): Promise<void>;
  onStateChange(cb: (state: WhatsAppSocketState) => void): () => void;
}

export interface WhatsAppChannelOptions {
  adapter: WhatsAppAdapter;
  groupJid: string;
  sqlite?: Database;
  maxQueue?: number;
  paceMs?: number;
  /** Injectable clock/sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface QueuedMessage {
  text: string;
  enqueuedAt: number;
  alertId: number;
}

/**
 * Persist the "please rescan" flag so the web dashboard (Stage 7) knows to
 * prompt the user. Best-effort — no throw if the DB write fails.
 */
function markRelinkNeeded(sqlite: Database | undefined, reason: string): void {
  if (!sqlite) return;
  try {
    sqlite
      .prepare(
        `INSERT INTO system_state (key, value, updated_at)
           VALUES ('wa:needs-relink', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify({ reason }), Date.now());
  } catch {
    // deliberate no-op — the log already captured it
  }
}

function clearRelinkFlag(sqlite: Database | undefined): void {
  if (!sqlite) return;
  try {
    sqlite.prepare("DELETE FROM system_state WHERE key = 'wa:needs-relink'").run();
  } catch {
    // ignore
  }
}

export function createWhatsAppChannel(
  opts: WhatsAppChannelOptions,
): NotificationChannel & {
  /** Test hook: number of messages currently waiting for reconnect. */
  queueSize(): number;
} {
  const log = createLogger("wa");
  const maxQueue = opts.maxQueue ?? 50;
  const paceMs = opts.paceMs ?? 1200;
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const queue: QueuedMessage[] = [];
  let loggedOut = false;
  let lastSentAt = 0;
  let draining = false;

  async function sendPaced(text: string): Promise<void> {
    const elapsed = now() - lastSentAt;
    if (elapsed < paceMs) {
      await sleep(paceMs - elapsed);
    }
    await opts.adapter.sendText(opts.groupJid, text);
    lastSentAt = now();
  }

  async function drain(): Promise<void> {
    if (draining) return;
    if (loggedOut) return;
    draining = true;
    try {
      while (queue.length > 0 && opts.adapter.isConnected() && !loggedOut) {
        const msg = queue.shift()!;
        try {
          await sendPaced(msg.text);
          log.info(
            { alertId: msg.alertId, waited: now() - msg.enqueuedAt },
            "flushed queued whatsapp message",
          );
        } catch (err) {
          // Push back and stop — reconnect will re-drain.
          queue.unshift(msg);
          log.warn(
            { err: (err as Error).message },
            "sendText failed during drain, will retry on next reconnect",
          );
          break;
        }
      }
    } finally {
      draining = false;
    }
  }

  opts.adapter.onStateChange((state) => {
    if (state.kind === "logged-out") {
      loggedOut = true;
      log.error({ reason: state.reason }, "whatsapp logged out — needs QR relink");
      markRelinkNeeded(opts.sqlite, state.reason ?? "unknown");
      return;
    }
    if (state.kind === "connected") {
      loggedOut = false;
      clearRelinkFlag(opts.sqlite);
      log.info("whatsapp connected — draining queue");
      void drain();
    }
  });

  return {
    name: "whatsapp",
    // A group message buzzes every phone in it.
    mutedByQuietHours: true,
    isReady(): boolean {
      // Connected OR queueing — both count as "we'll get this out eventually",
      // unless we're logged out (which requires human intervention).
      return !loggedOut;
    },
    async send(alert: RenderedAlert): Promise<DeliveryResult> {
      if (loggedOut) {
        return {
          ok: false,
          detail: "whatsapp session logged out — awaiting QR relink",
        };
      }

      if (opts.adapter.isConnected()) {
        try {
          await sendPaced(alert.textBody);
          return { ok: true, detail: "sent" };
        } catch (err) {
          const detail = (err as Error).message ?? String(err);
          // Fall through to queue — the send failed but the socket
          // might still recover.
          queue.push({
            text: alert.textBody,
            enqueuedAt: now(),
            alertId: alert.id,
          });
          return { ok: false, detail: `sendText failed, queued: ${detail}` };
        }
      }

      // Socket down — queue.
      if (queue.length >= maxQueue) {
        // Drop OLDEST to keep the newest signal. Silent drop with a warning
        // is better than blocking the caller during a long outage.
        const dropped = queue.shift();
        log.warn(
          { droppedAlertId: dropped?.alertId, waited: now() - (dropped?.enqueuedAt ?? 0) },
          "wa queue full, dropped oldest",
        );
      }
      queue.push({
        text: alert.textBody,
        enqueuedAt: now(),
        alertId: alert.id,
      });
      return {
        ok: false,
        detail: `queued (queue size ${queue.length}, awaiting reconnect)`,
      };
    },
    queueSize(): number {
      return queue.length;
    },
  };
}
