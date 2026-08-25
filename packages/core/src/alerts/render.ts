import type { AlertSeverity, AlertType } from "../db/schema.ts";
import type { RenderedAlert } from "./types.ts";

// Alert rendering. Produces:
//   - `textBody` — plain text with *bold* markers for WhatsApp
//   - `htmlBody` — the same content marked up for Telegram
//   - `pushPayload` — JSON blob for the service worker
//
// The two text forms are built from one line list rather than by
// post-processing `textBody`: WhatsApp's `*bold*` and Telegram's `<b>` are
// different enough that converting between them means writing a parser for
// asterisks, which then has to worry about asterisks that appear in an alert
// body for unrelated reasons.
//
// WhatsApp gets WIB times (per brief §6). Push carries UTC + severity so the
// service worker can render whatever the browser locale prefers.

interface RenderOptions {
  utcOffsetHours: number; // e.g. 7 for WIB
  timezoneLabel?: string; // "WIB", "UTC+7", etc.
}

interface StoredAlert {
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
}

const SEVERITY_TAG: Record<AlertSeverity, string> = {
  critical: "🔴 CRITICAL",
  warning: "🟡 WARNING",
  info: "🔵 INFO",
};

function formatLocalTime(unixSeconds: number, utcOffsetHours: number): string {
  const shifted = new Date((unixSeconds + utcOffsetHours * 3600) * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, "0");
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mo} ${hh}:${mm}`;
}

export function renderAlert(
  alert: StoredAlert,
  opts: RenderOptions,
): RenderedAlert {
  const tzLabel = opts.timezoneLabel ?? `UTC${opts.utcOffsetHours >= 0 ? "+" : ""}${opts.utcOffsetHours}`;
  const startedStr = formatLocalTime(alert.startedAt, opts.utcOffsetHours);
  const isResolution = alert.status === "resolved";

  const heading = isResolution
    ? `✅ RECOVERED — ${alert.title}`
    : `${SEVERITY_TAG[alert.severity]} — ${alert.title}`;

  // Each entry is (plain text, is-bold). Rendering to WhatsApp or Telegram is
  // then a matter of wrapping, not of rewriting.
  type Segment = { text: string; bold?: boolean };
  const lines: Segment[][] = [
    [{ text: heading, bold: true }],
    [{ text: "monitor: " }, { text: alert.monitor, bold: true }],
    [],
    [{ text: alert.body }],
    [],
  ];
  if (isResolution && alert.resolvedAt !== null) {
    const resolvedStr = formatLocalTime(alert.resolvedAt, opts.utcOffsetHours);
    const durationSec = Math.max(0, alert.resolvedAt - alert.startedAt);
    lines.push([
      { text: "resolved at " },
      { text: `${resolvedStr} ${tzLabel}`, bold: true },
      { text: ` (was firing for ${formatDuration(durationSec)})` },
    ]);
  } else {
    lines.push([
      { text: "started at " },
      { text: `${startedStr} ${tzLabel}`, bold: true },
    ]);
  }
  if (
    alert.severity === "critical" &&
    !isResolution &&
    typeof alert.meta.suggestedAction === "string"
  ) {
    lines.push([]);
    lines.push([{ text: `> ${alert.meta.suggestedAction}` }]);
  }

  const textBody = lines
    .map((segments) =>
      segments.map((s) => (s.bold ? `*${s.text}*` : s.text)).join(""),
    )
    .join("\n");

  // Telegram's HTML parse mode. Escaping happens on the raw text only, so an
  // alert body containing `<` or `&` cannot break the markup — a real risk
  // here, since detector messages carry things like "z=-4.2 < threshold".
  const htmlBody = lines
    .map((segments) =>
      segments
        .map((s) =>
          s.bold ? `<b>${escapeHtml(s.text)}</b>` : escapeHtml(s.text),
        )
        .join(""),
    )
    .join("\n");

  const pushPayload: Record<string, unknown> = {
    id: alert.id,
    fingerprint: alert.fingerprint,
    monitor: alert.monitor,
    type: alert.type,
    severity: alert.severity,
    status: alert.status,
    title: heading,
    body: alert.body,
    startedAt: alert.startedAt,
    resolvedAt: alert.resolvedAt,
    // The service worker uses this to force interaction on critical alerts.
    requireInteraction: alert.severity === "critical" && !isResolution,
    meta: alert.meta,
  };

  return {
    htmlBody,
    id: alert.id,
    fingerprint: alert.fingerprint,
    monitor: alert.monitor,
    type: alert.type,
    severity: alert.severity,
    status: alert.status,
    title: alert.title,
    body: alert.body,
    meta: alert.meta,
    startedAt: alert.startedAt,
    resolvedAt: alert.resolvedAt,
    textBody,
    pushPayload,
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
