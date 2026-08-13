import { mkdirSync } from "node:fs";
import { createLogger } from "../../logger.ts";
import type {
  WhatsAppAdapter,
  WhatsAppSocketState,
} from "./whatsapp.ts";

// Concrete Baileys implementation of the WhatsAppAdapter interface. Kept
// separate from `whatsapp.ts` so the unit tests can drive the wrapper with
// a stub adapter instead of a real WebSocket to WhatsApp servers.
//
// Reconnection lives here: on non-loggedOut disconnects we wait with
// exponential backoff capped at 60s and reconnect. `DisconnectReason.loggedOut`
// means the account revoked the pairing — no amount of retrying will fix
// that, so we flip into the logged-out state and stop.

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

export interface BaileysAdapterOptions {
  authDir: string;
  /** Called with the raw QR string on each new QR event. */
  onQr?: (qr: string) => void;
}

interface BaileysModule {
  default?: unknown;
  makeWASocket: (opts: unknown) => unknown;
  useMultiFileAuthState: (
    folder: string,
  ) => Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
  fetchLatestBaileysVersion: () => Promise<{
    version: number[];
    isLatest: boolean;
  }>;
  DisconnectReason: Record<string, number>;
}

/**
 * Baileys' entry module exports both a default and named symbols; support
 * both shapes since the packaging occasionally shifts across versions.
 */
async function loadBaileys(): Promise<BaileysModule> {
  const mod = (await import("@whiskeysockets/baileys")) as unknown as
    | BaileysModule
    | { default: BaileysModule };
  if ("default" in mod) {
    const asDefault = (mod as { default: BaileysModule | undefined }).default;
    if (asDefault && typeof asDefault.makeWASocket === "function") {
      return asDefault;
    }
  }
  return mod as BaileysModule;
}

/** Minimum shape we use from the returned socket instance. */
interface BaileysSocket {
  ev: {
    on(event: string, cb: (...args: unknown[]) => void): void;
  };
  sendMessage(
    jid: string,
    content: { text: string },
  ): Promise<unknown>;
  logout(): Promise<void>;
}

export async function createBaileysAdapter(
  opts: BaileysAdapterOptions,
): Promise<WhatsAppAdapter> {
  const log = createLogger("wa-baileys");

  mkdirSync(opts.authDir, { recursive: true });

  const baileys = await loadBaileys();
  const { state, saveCreds } = await baileys.useMultiFileAuthState(opts.authDir);

  const listeners = new Set<(s: WhatsAppSocketState) => void>();
  const fire = (s: WhatsAppSocketState) => {
    for (const cb of listeners) cb(s);
  };

  let socket: BaileysSocket | null = null;
  let connected = false;
  let stopReconnect = false;
  let reconnectDelay = RECONNECT_BASE_MS;

  async function connect(): Promise<void> {
    const { version } = await baileys
      .fetchLatestBaileysVersion()
      .catch(() => ({ version: [2, 3000, 0], isLatest: false }));

    // A silenced logger: pino with level=silent so Baileys doesn't drown out
    // the app's own logs. Baileys expects a pino-compatible instance.
    const noisyLogger = {
      level: "silent",
      trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
      child() { return noisyLogger; },
    };

    socket = baileys.makeWASocket({
      version,
      auth: state,
      logger: noisyLogger,
      printQRInTerminal: false, // we handle QR ourselves via opts.onQr
      browser: ["Night Watch", "Chrome", "0.1"],
    }) as BaileysSocket;

    socket.ev.on("creds.update", saveCreds as (...args: unknown[]) => void);

    socket.ev.on("connection.update", (raw: unknown) => {
      const update = raw as {
        connection?: "open" | "connecting" | "close";
        lastDisconnect?: { error?: { output?: { statusCode?: number } } };
        qr?: string;
      };
      if (update.qr && opts.onQr) opts.onQr(update.qr);

      if (update.connection === "open") {
        connected = true;
        reconnectDelay = RECONNECT_BASE_MS;
        log.info("baileys connected");
        fire({ kind: "connected" });
      } else if (update.connection === "close") {
        connected = false;
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === baileys.DisconnectReason.loggedOut;
        log.warn({ statusCode, loggedOut }, "baileys disconnected");
        if (loggedOut) {
          fire({ kind: "logged-out", reason: `status ${statusCode}` });
          return;
        }
        fire({ kind: "disconnected", reason: `status ${statusCode ?? "unknown"}` });
        if (stopReconnect) return;
        scheduleReconnect();
      } else if (update.connection === "connecting") {
        fire({ kind: "connecting" });
      }
    });
  }

  function scheduleReconnect(): void {
    const wait = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    log.info({ wait }, "reconnecting");
    setTimeout(() => {
      if (stopReconnect) return;
      connect().catch((err: unknown) => {
        log.error({ err: (err as Error).message }, "reconnect failed");
        scheduleReconnect();
      });
    }, wait);
  }

  await connect();

  return {
    isConnected(): boolean {
      return connected;
    },
    async sendText(jid: string, text: string): Promise<void> {
      if (!socket || !connected) {
        throw new Error("whatsapp socket not connected");
      }
      await socket.sendMessage(jid, { text });
    },
    onStateChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
