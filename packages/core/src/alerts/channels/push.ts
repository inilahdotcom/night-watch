import { createLogger } from "../../logger.ts";
import type { DB } from "../../db/client.ts";
import { pushSubscriptions } from "../../db/schema.ts";
import type {
  DeliveryResult,
  NotificationChannel,
  RenderedAlert,
} from "../types.ts";

// Push channel using `web-push` for VAPID signing. Each firing alert fans out
// to every stored subscription; per-subscription 404/410 responses are
// collected into `removeSubscriptionIds` so the engine can drop them.
//
// The SDK is loaded lazily so contexts that never send push (tests, seed CLI,
// migrate) don't pay the cost of pulling it in.

export interface PushChannelOptions {
  db: DB;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  /** Optional injected sender for tests. */
  sender?: PushSender;
}

/** The minimum surface we need from web-push (mockable for tests). */
export interface PushSender {
  send(
    subscription: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    },
    payload: string,
    opts: { TTL: number; urgency: "high" | "normal" | "low" },
  ): Promise<{ statusCode: number; body?: string }>;
}

async function makeDefaultSender(
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string,
): Promise<PushSender> {
  const webpush = await import("web-push");
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  return {
    async send(subscription, payload, opts) {
      const r = await webpush.sendNotification(subscription, payload, {
        TTL: opts.TTL,
        urgency: opts.urgency,
      });
      return { statusCode: r.statusCode, body: r.body };
    },
  };
}

interface StoredSubscription {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function createPushChannel(opts: PushChannelOptions): NotificationChannel {
  const log = createLogger("push");
  const hasKeys = Boolean(opts.vapidPublicKey && opts.vapidPrivateKey);
  let senderPromise: Promise<PushSender> | null = null;

  function getSender(): Promise<PushSender> {
    if (opts.sender) return Promise.resolve(opts.sender);
    if (!senderPromise) {
      senderPromise = makeDefaultSender(
        opts.vapidPublicKey,
        opts.vapidPrivateKey,
        opts.vapidSubject,
      );
    }
    return senderPromise;
  }

  return {
    name: "push",
    // Push notifications are silent by default, so there is nothing for quiet
    // hours to protect anyone from.
    mutedByQuietHours: false,
    isReady(): boolean {
      return hasKeys;
    },
    async send(alert: RenderedAlert): Promise<DeliveryResult> {
      const subs = opts.db
        .select()
        .from(pushSubscriptions)
        .all() as StoredSubscription[];
      if (subs.length === 0) {
        return { ok: false, detail: "no subscriptions registered" };
      }

      const sender = await getSender();
      const payload = JSON.stringify(alert.pushPayload);
      const urgency = alert.severity === "critical" ? "high" : "normal";
      // Critical alerts: TTL of 1 hour so they still fire if the browser
      // was offline briefly. Warnings drop after 5 minutes to avoid stale
      // notifications piling up during outages.
      const ttl = alert.severity === "critical" ? 3600 : 300;

      const removeSubscriptionIds: number[] = [];
      let successes = 0;
      let failures = 0;

      // Fan out sequentially — a small subscriber list (typically 1-5) and
      // this keeps per-request errors readable in the log.
      for (const sub of subs) {
        try {
          const r = await sender.send(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            payload,
            { TTL: ttl, urgency },
          );
          if (r.statusCode >= 200 && r.statusCode < 300) {
            successes += 1;
          } else if (r.statusCode === 404 || r.statusCode === 410) {
            // Endpoint was permanently unregistered — the browser dropped it.
            removeSubscriptionIds.push(sub.id);
            failures += 1;
            log.info(
              { subId: sub.id, statusCode: r.statusCode },
              "dropping expired push subscription",
            );
          } else {
            failures += 1;
            log.warn(
              { subId: sub.id, statusCode: r.statusCode, body: r.body },
              "push send failed",
            );
          }
        } catch (err) {
          // web-push throws WebPushError with .statusCode on push-service failures.
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            removeSubscriptionIds.push(sub.id);
            failures += 1;
          } else {
            failures += 1;
            log.warn(
              { subId: sub.id, err: (err as Error).message },
              "push send threw",
            );
          }
        }
      }

      const ok = successes > 0;
      const detail = `sent ${successes}/${subs.length}, dropped ${removeSubscriptionIds.length}, failed ${failures - removeSubscriptionIds.length}`;
      return {
        ok,
        detail,
        removeSubscriptionIds: removeSubscriptionIds.length > 0 ? removeSubscriptionIds : undefined,
      };
    },
  };
}
