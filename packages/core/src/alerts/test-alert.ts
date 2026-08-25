import { loadEnv, loadMonitors } from "../config/index.ts";
import { openDb } from "../db/client.ts";
import { createLogger } from "../logger.ts";
import { createAlertEngine } from "./engine.ts";
import { createPushChannel } from "./channels/push.ts";
import { createTelegramChannel } from "./channels/telegram.ts";
import {
  createWhatsAppChannel,
  type WhatsAppAdapter,
} from "./channels/whatsapp.ts";
import { parseQuietHours } from "./quiet-hours.ts";
import type { NotificationChannel, RenderedAlert } from "./types.ts";

// Standalone alert smoke test. Runs the engine inline against whatever
// channels are configured in the environment; falls back to a logging
// channel if none are set up. Useful before Stage 6 wires the worker loop.
//
//   bun run alert:test-inline
//
// Sends a "test alert" through the engine and immediately resolves it. If
// VAPID keys, WA_GROUP_JID, or Telegram credentials are set, real
// notifications go out on each of those channels.

// A trivial channel that logs whatever it gets — the fallback when neither
// real channel is configured. Proves the render+deliver path works end-to-end.
class ConsoleChannel implements NotificationChannel {
  readonly name = "push" as const;
  readonly mutedByQuietHours = false; // masquerade so tests still get counted
  isReady(): boolean {
    return true;
  }
  async send(alert: RenderedAlert): Promise<{ ok: true; detail: string }> {
    console.log("");
    console.log(`── ConsoleChannel (${alert.severity}) ──`);
    console.log(alert.textBody);
    console.log("── /ConsoleChannel ──");
    return { ok: true, detail: "printed to stdout" };
  }
}

async function main(): Promise<void> {
  const log = createLogger("test-alert");
  const env = loadEnv();
  const cfg = loadMonitors();
  const { db, sqlite } = openDb();

  const channels: NotificationChannel[] = [];

  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    channels.push(
      createPushChannel({
        db,
        vapidPublicKey: env.VAPID_PUBLIC_KEY,
        vapidPrivateKey: env.VAPID_PRIVATE_KEY,
        vapidSubject: env.VAPID_SUBJECT,
      }),
    );
    log.info("push channel enabled (VAPID keys present)");
  } else {
    log.info("push channel disabled (VAPID keys missing)");
  }

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    channels.push(
      createTelegramChannel({
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
      }),
    );
    log.info("telegram channel enabled (bot token + chat id present)");
  } else {
    log.info("telegram channel disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing)");
  }

  let waAdapter: WhatsAppAdapter | null = null;
  if (env.WA_GROUP_JID) {
    try {
      const { createBaileysAdapter } = await import(
        "./channels/whatsapp-baileys.ts"
      );
      waAdapter = await createBaileysAdapter({
        authDir: env.WA_AUTH_DIR,
        onQr(qr: string) {
          void printQr(qr);
        },
      });
      channels.push(
        createWhatsAppChannel({
          adapter: waAdapter,
          groupJid: env.WA_GROUP_JID,
          sqlite,
        }),
      );
      log.info({ groupJid: env.WA_GROUP_JID }, "whatsapp channel enabled");
    } catch (err) {
      log.error(
        { err: (err as Error).message },
        "whatsapp channel init failed — continuing without it",
      );
    }
  } else {
    log.info("whatsapp channel disabled (WA_GROUP_JID missing)");
  }

  if (channels.length === 0) {
    channels.push(new ConsoleChannel());
    log.warn("no real channels configured — using ConsoleChannel fallback");
  }

  const engine = createAlertEngine({
    db,
    sqlite,
    channels,
    cooldownMinutes: env.ALERT_COOLDOWN_MINUTES,
    notifyOnResolve: env.ALERT_NOTIFY_ON_RESOLVE,
    quietHours: parseQuietHours(cfg.quietHours),
    utcOffsetHours: 7,
    timezoneLabel: "WIB",
  });

  const fp = `test:${Date.now()}`;
  const raised = await engine.raiseAlert({
    fingerprint: fp,
    monitor: "test",
    type: "traffic",
    severity: "warning",
    title: "Test alert from Night Watch",
    body: "This is a test — everything is fine. If you received this in your browser and/or WhatsApp group, the alert pipeline is working.",
    meta: { manual: true },
  });
  log.info({ raised }, "raiseAlert done");

  // Small delay so async pacing in WhatsApp has a chance to complete.
  await new Promise((r) => setTimeout(r, 1500));

  const resolved = await engine.resolveAlert({
    fingerprint: fp,
    title: "Test alert cleared",
    body: "Verification complete.",
  });
  log.info({ resolved }, "resolveAlert done");

  // Give the WhatsApp queue drain a moment before we tear down.
  await new Promise((r) => setTimeout(r, 1500));

  process.exit(0);
}

async function printQr(qr: string): Promise<void> {
  try {
    const mod = (await import("qrcode-terminal")) as {
      default?: { generate: (text: string, opts?: { small: boolean }) => void };
      generate?: (text: string, opts?: { small: boolean }) => void;
    };
    // Must call through the owning object — `generate` uses `this` for the
    // error-correction level, so a detached reference throws.
    const host = mod.default?.generate ? mod.default : mod.generate ? mod : null;
    if (host) host.generate!(qr, { small: true });
    else console.log("QR:", qr);
  } catch {
    console.log("QR:", qr);
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
