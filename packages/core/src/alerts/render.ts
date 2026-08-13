import type { AlertSeverity, AlertType } from "../db/schema.ts";
import type { RenderedAlert } from "./types.ts";

// Alert rendering. Produces both:
//   - `textBody` — plain text with *bold* markers for WhatsApp
//   - `pushPayload` — JSON blob for the service worker
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

  const lines: string[] = [`*${heading}*`, `monitor: *${alert.monitor}*`, ""];
  lines.push(alert.body);
  lines.push("");
  if (isResolution && alert.resolvedAt !== null) {
    const resolvedStr = formatLocalTime(alert.resolvedAt, opts.utcOffsetHours);
    const durationSec = Math.max(0, alert.resolvedAt - alert.startedAt);
    lines.push(
      `resolved at *${resolvedStr} ${tzLabel}* (was firing for ${formatDuration(durationSec)})`,
    );
  } else {
    lines.push(`started at *${startedStr} ${tzLabel}*`);
  }
  if (
    alert.severity === "critical" &&
    !isResolution &&
    typeof alert.meta.suggestedAction === "string"
  ) {
    lines.push("");
    lines.push(`> ${alert.meta.suggestedAction}`);
  }

  const textBody = lines.join("\n");

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
