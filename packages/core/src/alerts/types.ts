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
  /** Plain text with `*bold*` markers — WhatsApp. */
  textBody: string;
  /** The same content in Telegram's HTML parse mode, fully escaped. */
  htmlBody: string;
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
  /**
   * Whether quiet hours may mute this channel for non-critical alerts.
   *
   * Replaces the engine's former hard-coded `name === "whatsapp"` check. The
   * distinction is about how intrusive a channel is, not which one it is:
   * push is silent by default so it never needs muting, while anything that
   * buzzes a phone in a group chat does. A new channel declares its own
   * answer instead of requiring an edit to the engine.
   */
  readonly mutedByQuietHours: boolean;
  isReady(): boolean;
  send(alert: RenderedAlert): Promise<DeliveryResult>;
}
