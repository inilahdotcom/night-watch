import { Cron } from "croner";
import {
  buildDefaultHandlers,
  createAlertEngine,
  createPushChannel,
  createWhatsAppChannel,
  parseQuietHours,
  pollAndExecute,
  type NotificationChannel,
  type WhatsAppAdapter,
} from "@night-watch/core/alerts";
import {
  collectOne as runCollectorFor,
} from "@night-watch/core/collectors";
import {
  runAnalysisCycle,
  sweepRetention,
} from "@night-watch/core/analysis";
import {
  createLogger,
  loadEnv,
  loadMonitors,
  openDb,
  closeDb,
} from "@night-watch/core";
import { rm } from "node:fs/promises";

// Night Watch worker.
//
// Long-lived Node/Bun process that owns every WRITE against the SQLite DB.
// The web app is a reader; anything that mutates state flows through here.
//
// Scheduled jobs (croner):
//   - `every-minute` — for each monitor: run probe + CF/GA4 collectors,
//     then the analysis cycle to raise/resolve alerts.
//   - `commands`    — every 2s, drain the outbox (test_alert, wa_relink).
//   - `retention`   — daily at 04:00 WIB, delete stale metrics / alerts.
//
// Graceful shutdown on SIGINT/SIGTERM: stop every Cron, close the DB, exit 0.

const log = createLogger("worker");

async function main(): Promise<void> {
  const env = loadEnv();
  const config = loadMonitors();
  const { db, sqlite } = openDb();

  log.info(
    { monitors: config.monitors.length, quietHours: config.quietHours },
    "worker booting",
  );

  // ------------------------------------------------------------------
  // Channels
  // ------------------------------------------------------------------
  const channels: NotificationChannel[] = [];
  let waAdapter: WhatsAppAdapter | null = null;

  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    channels.push(
      createPushChannel({
        db,
        vapidPublicKey: env.VAPID_PUBLIC_KEY,
        vapidPrivateKey: env.VAPID_PRIVATE_KEY,
        vapidSubject: env.VAPID_SUBJECT,
      }),
    );
    log.info("push channel enabled");
  } else {
    log.warn("push channel disabled — set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY");
  }

  if (env.WA_GROUP_JID) {
    try {
      const { createBaileysAdapter } = await import(
        "@night-watch/core/alerts/channels/whatsapp-baileys.ts"
      );
      waAdapter = await createBaileysAdapter({
        authDir: env.WA_AUTH_DIR,
        onQr(qr) {
          void showQr(qr);
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
    log.warn("whatsapp channel disabled — set WA_GROUP_JID");
  }

  if (channels.length === 0) {
    log.warn("no channels configured — alerts will still be recorded in the DB");
  }

  const engine = createAlertEngine({
    db,
    sqlite,
    channels,
    cooldownMinutes: env.ALERT_COOLDOWN_MINUTES,
    notifyOnResolve: env.ALERT_NOTIFY_ON_RESOLVE,
    quietHours: parseQuietHours(config.quietHours),
    utcOffsetHours: 7,
    timezoneLabel: "WIB",
  });

  const handlers = buildDefaultHandlers({
    engine,
    async clearWhatsAppAuth() {
      log.warn("wa_relink: removing auth folder — next boot will show QR");
      await rm(env.WA_AUTH_DIR, { recursive: true, force: true });
    },
  });

  // ------------------------------------------------------------------
  // Job runners
  // ------------------------------------------------------------------

  // Prevent overlap: if a cycle takes longer than the tick, skip the next one.
  let mainTickRunning = false;
  async function runMainTick(): Promise<void> {
    if (mainTickRunning) {
      log.warn("main tick still running — skipping this beat");
      return;
    }
    mainTickRunning = true;
    try {
      for (const monitor of config.monitors) {
        try {
          const collectReport = await runCollectorFor(monitor, config.controlUrl);
          const analysisReport = await runAnalysisCycle({
            monitor,
            engine,
            sqlite,
          });
          if (analysisReport.actions.length > 0 || collectReport.fatal) {
            log.info(
              {
                monitor: monitor.id,
                probe: collectReport.probe?.transition,
                cfRows: collectReport.cloudflare?.rowCount ?? 0,
                cfErrors: collectReport.cloudflare?.errors ?? 0,
                ga4Rows: collectReport.ga4?.rowCount ?? 0,
                actions: analysisReport.actions,
                skipReason: analysisReport.skipReason,
              },
              "monitor tick",
            );
          }
        } catch (err) {
          log.error(
            { monitor: monitor.id, err: (err as Error).message },
            "monitor tick failed",
          );
        }
      }
    } finally {
      mainTickRunning = false;
    }
  }

  let commandsTickRunning = false;
  async function runCommandsTick(): Promise<void> {
    if (commandsTickRunning) return;
    commandsTickRunning = true;
    try {
      const n = await pollAndExecute({ sqlite, handlers });
      if (n > 0) log.info({ processed: n }, "commands drained");
    } catch (err) {
      log.error({ err: (err as Error).message }, "commands poll failed");
    } finally {
      commandsTickRunning = false;
    }
  }

  function runRetentionTick(): void {
    try {
      sweepRetention({ sqlite });
    } catch (err) {
      log.error({ err: (err as Error).message }, "retention sweep failed");
    }
  }

  // ------------------------------------------------------------------
  // Schedulers (croner)
  // ------------------------------------------------------------------
  //
  // Cron patterns:
  //   "0 * * * * *"     — top of every minute (6-field: sec min hr dom mon dow)
  //   "*/2 * * * * *"   — every 2 seconds (allowed: seconds field is 0-59)
  //   "0 0 4 * * *"     — 04:00 daily; we set timezone to Asia/Jakarta.
  //
  // Brief §9 warns against `*/60 * * * * *` — the seconds field can't hold 60.
  // Intervals ≥ 60s go in the minute field instead, exactly like above.

  const jobs = [
    new Cron("0 * * * * *", { name: "monitor-tick" }, () => {
      void runMainTick();
    }),
    new Cron("*/2 * * * * *", { name: "commands-tick" }, () => {
      void runCommandsTick();
    }),
    new Cron(
      "0 0 4 * * *",
      { name: "retention", timezone: "Asia/Jakarta" },
      () => runRetentionTick(),
    ),
  ];

  // Do an initial tick ~1s after boot so the first minute doesn't feel dead.
  setTimeout(() => void runMainTick(), 1000);
  setTimeout(() => void runCommandsTick(), 500);

  log.info(
    { jobs: jobs.map((j) => j.name) },
    "scheduler running — waiting for ticks",
  );

  // ------------------------------------------------------------------
  // Graceful shutdown
  // ------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    for (const job of jobs) job.stop();
    // Give in-flight ticks a beat to finish.
    await new Promise((r) => setTimeout(r, 250));
    try {
      closeDb();
    } catch (err) {
      log.warn({ err: (err as Error).message }, "closeDb failed");
    }
    log.info("shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function showQr(qr: string): Promise<void> {
  try {
    const mod = (await import("qrcode-terminal")) as {
      default?: { generate: (text: string, opts?: { small: boolean }) => void };
      generate?: (text: string, opts?: { small: boolean }) => void;
    };
    const generate = mod.default?.generate ?? mod.generate;
    if (generate) generate(qr, { small: true });
    else console.log("QR:", qr);
  } catch {
    console.log("QR:", qr);
  }
}

main().catch((err: unknown) => {
  console.error("worker crashed:", err);
  process.exit(1);
});
