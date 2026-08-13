import { eq } from "drizzle-orm";
import type { Database } from "bun:sqlite";
import type { DB } from "../db/client.ts";
import { pushSubscriptions } from "../db/schema.ts";
import type { CommandKind } from "../db/schema.ts";

// Write helpers the web app is ALLOWED to call. This module deliberately
// exports nothing else — combined with the fact that queries.ts holds only
// SELECTs, apps/web cannot mutate any table other than push_subscriptions
// and commands (brief §7).
//
// If you catch yourself adding a helper here that writes to `metrics`,
// `alerts`, `deliveries`, `probe_state`, or `system_state` — stop. Those
// are the worker's job. Enqueue a command instead.

export interface SubscribePushInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  label?: string;
}

export function subscribePush(db: DB, input: SubscribePushInput): { id: number } {
  const now = Math.floor(Date.now() / 1000);
  // Idempotent upsert on endpoint (unique index).
  const existing = db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, input.endpoint))
    .get();
  if (existing) {
    db.update(pushSubscriptions)
      .set({
        p256dh: input.p256dh,
        auth: input.auth,
        label: input.label ?? null,
        // Reset failure counters on re-subscribe — the browser handed us a
        // fresh key so previous 4xx history is stale.
        failCount: 0,
      })
      .where(eq(pushSubscriptions.id, existing.id))
      .run();
    return { id: existing.id };
  }
  const inserted = db
    .insert(pushSubscriptions)
    .values({
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      label: input.label ?? null,
      createdAt: now,
      lastOkAt: null,
      failCount: 0,
    })
    .returning({ id: pushSubscriptions.id })
    .get();
  return { id: inserted.id };
}

export function unsubscribePush(db: DB, endpoint: string): { removed: number } {
  // drizzle-orm/bun-sqlite's .run() returns void — check existence first
  // for the "how many did we drop?" answer.
  const existing = db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .get();
  if (!existing) return { removed: 0 };
  db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
  return { removed: 1 };
}

/**
 * Enqueue an outbox command for the worker to consume. We take the raw
 * sqlite handle rather than the drizzle instance because we want to use
 * the same INSERT with RETURNING pattern the commands module already
 * relies on.
 */
export function enqueueCommand(
  sqlite: Database,
  kind: CommandKind,
  payload?: Record<string, unknown>,
): { id: number } {
  const row = sqlite
    .prepare(
      "INSERT INTO commands (kind, payload, status, created_at) VALUES (?, ?, 'pending', ?) RETURNING id",
    )
    .get(
      kind,
      payload ? JSON.stringify(payload) : null,
      Date.now(),
    ) as { id: number };
  return { id: row.id };
}
