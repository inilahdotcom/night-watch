import { cn } from "@/lib/utils"

// The numbers behind the verdict.
//
// `alerts.meta` has been populated by every detector and carried all the way
// into ActiveAlertView, then dropped on the floor at render time. It holds the
// z-score, the baseline median, the DDoS signal weights, the days left on a
// certificate — exactly the figures someone needs to decide whether an alert
// is worth getting out of bed for.

const LABELS: Record<string, string> = {
  z: "z-score",
  median: "baseline median",
  relativeChange: "change",
  score: "ddos score",
  daysLeft: "days left",
  bodyBytes: "body size",
  lastLatencyMs: "latency",
  totalHits: "matches",
}

export function AlertMeta({ meta }: { meta: Record<string, unknown> }) {
  const entries = Object.entries(meta).filter(
    ([, v]) => v !== null && v !== undefined && typeof v !== "object",
  )
  if (entries.length === 0) return null

  return (
    <dl className="mono mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px]">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-1.5">
          <dt className="text-muted-foreground tracking-widest uppercase">
            {LABELS[key] ?? key}
          </dt>
          <dd className={cn("tabular-nums")}>{format(key, value)}</dd>
        </div>
      ))}
    </dl>
  )
}

function format(key: string, value: unknown): string {
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (typeof value !== "number") return String(value)
  // Ratios read far better as percentages, and these are the only keys that
  // carry one.
  if (key === "relativeChange") return `${(value * 100).toFixed(1)}%`
  if (key === "bodyBytes") return `${(value / 1024).toFixed(1)} KB`
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
