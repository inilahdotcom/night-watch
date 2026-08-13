import type {
  AlertSeverity,
  AlertType,
  Channel,
} from "../db/schema.ts";

// Public types the alert engine and channels share.

export interface AlertInput {
  fingerprint: string;
  monitor: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  body: string;
  meta?: Record<string, unknown>;
}

export interface ResolveInput {
  fingerprint: string;
  title?: string; // recovery-line override; defaults from stored alert
  body?: string;
}

/** What the engine hands to a channel — fully rendered, ready to send. */
export interface RenderedAlert {
  id: number;
  fingerprint: string;
  monitor: string;
  type: AlertType;
  severity: AlertSeverity;
  status: "firing" | "resolved";
  title: string;
  body: string;
  meta: Record<string, unknown>;
  startedAt: number;
  resolvedAt: number | null;
  /** Plain-text formatted for WhatsApp/etc. */
  textBody: string;
  /** JSON-serialisable payload for push. */
  pushPayload: Record<string, unknown>;
}

export interface DeliveryResult {
  ok: boolean;
  detail: string;
  /** Per-recipient subscriptions the channel wants the caller to drop
   *  (e.g. push endpoints that returned 410 Gone). */
  removeSubscriptionIds?: number[];
}

export interface NotificationChannel {
  readonly name: Channel;
  isReady(): boolean;
  send(alert: RenderedAlert): Promise<DeliveryResult>;
}
