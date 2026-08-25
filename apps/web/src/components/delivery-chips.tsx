import type { DeliveryView } from "@night-watch/core/web"
import { cn } from "@/lib/utils"

// Per-channel delivery outcome for one alert.
//
// The `deliveries` table has been written since day one and read by nobody,
// which meant "did the WhatsApp actually go out?" could only be answered by
// opening SQLite. At 2am that is the wrong time to learn that the Baileys
// session had been logged out for a week.
//
// `skipped` is deliberately styled as neutral rather than as a failure: a
// channel skipped by quiet hours or a maintenance window did exactly what it
// was configured to do, and colouring that red would train people to ignore
// the colour.

const STATUS_STYLE: Record<DeliveryView["status"], string> = {
  sent: "border-status-ok/40 bg-status-ok/10 text-status-ok",
  failed: "border-status-critical/40 bg-status-critical/10 text-status-critical",
  skipped: "border-border bg-secondary/40 text-muted-foreground",
}

const STATUS_MARK: Record<DeliveryView["status"], string> = {
  sent: "✓",
  failed: "✗",
  skipped: "–",
}

export function DeliveryChips({ deliveries }: { deliveries: DeliveryView[] }) {
  if (deliveries.length === 0) return null

  return (
    <ul className="mt-3 flex flex-wrap gap-1.5">
      {deliveries.map((d) => (
        <li
          key={d.channel}
          // The reason is the whole point for skipped/failed — "quiet hours"
          // and "channel not ready" are completely different problems.
          title={d.detail ?? undefined}
          className={cn(
            "mono rounded-full border px-2 py-0.5 text-[10px] tracking-widest uppercase",
            STATUS_STYLE[d.status],
          )}
        >
          {STATUS_MARK[d.status]} {d.channel}
          {d.status !== "sent" && d.detail ? ` · ${shorten(d.detail)}` : ""}
        </li>
      ))}
    </ul>
  )
}

function shorten(detail: string): string {
  const cleaned = detail.replace(/^skipped:\s*/, "")
  return cleaned.length <= 28 ? cleaned : `${cleaned.slice(0, 27)}…`
}
