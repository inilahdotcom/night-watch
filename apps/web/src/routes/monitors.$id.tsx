import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query"
import { useState } from "react"
import { fetchBotSeries, fetchMonitors } from "../lib/server-fns"
import { LineChart, type LineSeries } from "../components/line-chart"
import { Loader } from "../components/ui/loader"
import { fetchAuthState } from "../lib/auth-fns"

// ponytail: one chart, one fixed 24h window. Add a picker when someone
// actually wants 7d.
const WINDOW_HOURS = 24
const BUCKET_SECONDS = 300

export const Route = createFileRoute("/monitors/$id")({
  // Cosmetic, same as the dashboard: the real gate is `authMiddleware` on
  // every server function.
  beforeLoad: async () => {
    const state = await fetchAuthState()
    if (state.enabled && !state.authed) throw redirect({ to: "/login" })
  },
  component: MonitorDetailPage,
})

function MonitorDetailPage() {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: true,
            refetchInterval: 20_000,
            staleTime: 15_000,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={qc}>
      <MonitorDetailBody />
    </QueryClientProvider>
  )
}

function MonitorDetailBody() {
  const { id } = Route.useParams()

  // Reuses the dashboard's query — React Query dedupes it against the same
  // ["monitors"] key on a preloaded navigation, so this costs nothing extra.
  const monitors = useQuery({
    queryKey: ["monitors"],
    queryFn: () => fetchMonitors(),
  })
  const bots = useQuery({
    queryKey: ["bot-series", id, WINDOW_HOURS],
    queryFn: () => fetchBotSeries({ data: { monitor: id, hours: WINDOW_HOURS } }),
  })

  if (monitors.isPending) {
    return <Loader label="Night Watch" hint="Loading this monitor…" />
  }

  const monitor = monitors.data?.find((m) => m.id === id)

  return (
    <main className="mx-auto min-h-svh max-w-3xl px-5 pb-24 sm:px-8">
      <nav className="pt-8">
        <Link
          to="/"
          className="text-muted-foreground hover:text-foreground mono text-xs"
        >
          ← All monitors
        </Link>
      </nav>

      {!monitor ? (
        <p className="border-border bg-secondary/40 text-muted-foreground mt-8 rounded-xl border px-4 py-3 text-sm">
          No monitor called <code className="mono">{id}</code> has reported yet.
          A monitor appears here once it has been probed at least once.
        </p>
      ) : (
        <>
          <header className="mt-6">
            <h1 className="truncate text-2xl">{monitor.label ?? monitor.id}</h1>
            {monitor.url && (
              <p className="mono text-muted-foreground mt-1 truncate text-xs">
                {monitor.url}
              </p>
            )}
          </header>

          <section
            aria-labelledby="bot-heading"
            className="border-border bg-card mt-8 rounded-2xl border p-5 sm:p-6"
          >
            <h2 id="bot-heading" className="text-lg">
              Bot traffic
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Requests split by Cloudflare bot score over the last{" "}
              {WINDOW_HOURS} hours. Verified bots — Googlebot and friends — are
              counted separately and never trigger the bot-share alert.
            </p>

            <div className="mt-5">
              {bots.isPending ? (
                <div className="bg-secondary/30 rounded-lg" style={{ height: 120 }} />
              ) : bots.isError ? (
                <p className="border-status-warning/40 bg-status-warning/10 rounded-xl border px-4 py-3 text-sm">
                  Could not load bot traffic for this monitor.
                </p>
              ) : !bots.data.hasData ? (
                <p className="border-border bg-secondary/40 text-muted-foreground rounded-xl border px-4 py-3 text-sm">
                  No bot data for this monitor. Bot scoring needs Bot Analytics
                  on the Cloudflare zone, and{" "}
                  <code className="mono">botAnalytics</code> set to true in{" "}
                  <code className="mono">config/monitors.json</code>.
                </p>
              ) : (
                <LineChart
                  bucketCount={toGrid(bots.data.points).length}
                  series={seriesFrom(bots.data.points)}
                  windowHours={WINDOW_HOURS}
                  unit="bot traffic"
                />
              )}
            </div>
          </section>
        </>
      )}
    </main>
  )
}

interface Point {
  bucketTs: number
  bot: number
  human: number
  verified: number
}

/**
 * Expand the returned buckets onto a continuous bucketSeconds grid, inserting
 * nulls where a bucket is missing. Without this the x-axis silently compresses
 * across a collector outage and the chart draws a straight line through it.
 */
function toGrid(points: readonly Point[]): Array<Point | null> {
  if (points.length === 0) return []
  const first = points[0]!.bucketTs
  const last = points[points.length - 1]!.bucketTs
  const byTs = new Map(points.map((p) => [p.bucketTs, p] as const))
  const grid: Array<Point | null> = []
  for (let ts = first; ts <= last; ts += BUCKET_SECONDS) {
    grid.push(byTs.get(ts) ?? null)
  }
  return grid
}

function seriesFrom(points: readonly Point[]): LineSeries[] {
  const grid = toGrid(points)
  return [
    {
      label: "Bots",
      color: "var(--status-warning)",
      values: grid.map((p) => (p ? p.bot : null)),
    },
    {
      label: "Humans",
      color: "var(--muted-foreground)",
      values: grid.map((p) => (p ? p.human : null)),
    },
    {
      label: "Verified bots",
      color: "var(--accent)",
      dashed: true,
      values: grid.map((p) => (p ? p.verified : null)),
    },
  ]
}
