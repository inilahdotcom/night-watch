import { useQuery } from "@tanstack/react-query"
import type { UptimeWindowView } from "@night-watch/core/web"
import { fetchUptime } from "../lib/server-fns"
import { cn } from "@/lib/utils"

// Uptime over 24h / 7d / 30d, from the stored `up` metric.
//
// Two decisions worth keeping:
//
// 1. Precision follows sample count. A ratio computed from 12 buckets is not
//    a "99.98%" kind of number, and printing it that way would be a lie with
//    four significant figures. Below a day's worth of samples we drop to whole
//    percent and say how thin the window is.
// 2. A perfect window prints "100%", not "100.000%". Trailing zeroes imply a
//    measurement precision this data does not have — the probe writes once per
//    minute into a five-minute bucket, so the real resolution is one bucket.

const LABELS: Record<number, string> = {
  24: "24h",
  168: "7d",
  720: "30d",
}

export function UptimeStrip({ monitor }: { monitor: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["uptime", monitor],
    queryFn: () => fetchUptime({ data: { monitor } }),
    // Slower than the 20s dashboard cadence: a 30-day ratio does not move
    // between two refreshes, and the 30-day scan is the most expensive read
    // on the page.
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  })

  if (isLoading || !data) {
    return <div className="bg-secondary/40 mt-5 h-16 animate-pulse rounded-xl" />
  }

  return (
    <dl className="bg-border mt-5 grid grid-cols-3 gap-px overflow-hidden rounded-xl">
      {data.windows.map((w) => (
        <UptimeTile key={w.hours} window={w} />
      ))}
    </dl>
  )
}

function UptimeTile({ window: w }: { window: UptimeWindowView }) {
  const label = LABELS[w.hours] ?? `${w.hours}h`

  if (w.ratio === null) {
    return (
      <div className="bg-card px-3 py-3">
        <dt className="text-muted-foreground mono text-[10px] tracking-widest uppercase">
          Uptime {label}
        </dt>
        <dd className="text-muted-foreground mono mt-1 text-lg">—</dd>
        <dd className="text-muted-foreground mt-0.5 text-[10px]">no samples yet</dd>
      </div>
    )
  }

  // One bucket every 5 minutes → 288/day. Under a day of samples, the third
  // decimal is noise.
  const thin = w.samples < 288
  const pct = w.ratio * 100
  const text =
    pct === 100 ? "100%" : thin ? `${pct.toFixed(0)}%` : `${pct.toFixed(2)}%`

  return (
    <div className="bg-card px-3 py-3">
      <dt className="text-muted-foreground mono text-[10px] tracking-widest uppercase">
        Uptime {label}
      </dt>
      <dd
        className={cn(
          "mono mt-1 text-lg tabular-nums",
          pct >= 99.9
            ? "text-foreground"
            : pct >= 99
              ? "text-status-warning"
              : "text-status-critical",
        )}
      >
        {text}
      </dd>
      <dd className="text-muted-foreground mt-0.5 text-[10px]">
        {thin ? `only ${w.samples} samples` : `${w.samples} samples`}
      </dd>
    </div>
  )
}
