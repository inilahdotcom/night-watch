import { mkdirSync } from "node:fs";
import { loadEnv } from "../config/index.ts";
import { createLogger } from "../logger.ts";

// Pairing + group-JID discovery helper.
//
//   bun run wa:groups
//
// Solves the chicken-and-egg in the WhatsApp setup: the worker only boots
// Baileys when WA_GROUP_JID is already set, but you cannot know the JID
// until you have paired. This script pairs against the same WA_AUTH_DIR the
// worker uses, lists every group the account participates in, and exits.
// Once you copy a JID into .env, the worker reuses the credentials written
// here — no second QR scan.

interface GroupMeta {
  id: string;
  subject: string;
  participants?: unknown[];
}

async function printQr(qr: string): Promise<void> {
  try {
    const mod = (await import("qrcode-terminal")) as {
      generate?: (text: string, opts: { small: boolean }) => void;
      default?: { generate: (text: string, opts: { small: boolean }) => void };
    };
    // Call through the owning object — `generate` reads `this` for the
    // error-correction level, so a detached reference throws.
    const host = mod.default?.generate ? mod.default : mod.generate ? mod : null;
    if (host) host.generate!(qr, { small: true });
    else console.log("QR:", qr);
  } catch {
    console.log("QR:", qr);
  }
}

async function main(): Promise<void> {
  const log = createLogger("wa-groups");
  const env = loadEnv();

  mkdirSync(env.WA_AUTH_DIR, { recursive: true });
  log.info({ authDir: env.WA_AUTH_DIR }, "using auth dir");

  const baileys = (await import("@whiskeysockets/baileys")) as any;
  const api = baileys.makeWASocket ? baileys : baileys.default;

  const { state, saveCreds } = await api.useMultiFileAuthState(env.WA_AUTH_DIR);
  const { version } = await api
    .fetchLatestBaileysVersion()
    .catch(() => ({ version: [2, 3000, 0] }));

  const silent: any = {
    level: "silent",
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return silent; },
  };

  const socket = api.makeWASocket({
    version,
    auth: state,
    logger: silent,
    printQRInTerminal: false,
    // Match the worker's browser signature so both share one linked device.
    browser: ["Night Watch", "Chrome", "0.1"],
  });

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", (update: any) => {
    if (update.qr) {
      console.log("\nScan this from WhatsApp → Linked Devices → Link a Device:\n");
      void printQr(update.qr);
    }

    if (update.connection === "close") {
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      log.error({ statusCode }, "connection closed before listing groups");
      process.exit(1);
    }

    if (update.connection !== "open") return;

    void (async () => {
      try {
        const groups = (await socket.groupFetchAllParticipating()) as Record<
          string,
          GroupMeta
        >;
        const rows = Object.values(groups);

        if (rows.length === 0) {
          console.log(
            "\nNo groups found. Send a message in the target group, then rerun.\n",
          );
        } else {
          console.log(`\n${rows.length} group(s) — copy the JID you want into WA_GROUP_JID:\n`);
          for (const g of rows) {
            const count = g.participants?.length ?? 0;
            console.log(`  ${g.id}\n    ${g.subject}  (${count} participants)\n`);
          }
        }
      } catch (err) {
        log.error({ err: (err as Error).message }, "groupFetchAllParticipating failed");
        process.exitCode = 1;
      } finally {
        // Close the socket without logging out — the credentials on disk
        // must stay valid for the worker.
        socket.end(undefined);
        process.exit(process.exitCode ?? 0);
      }
    })();
  });
}

void main();
