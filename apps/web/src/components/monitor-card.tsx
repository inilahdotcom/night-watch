import { useQuery } from "@tanstack/react-query";
import type { MonitorSummaryView } from "@night-watch/core/web";
import { fetchSeries } from "../lib/server-fns";
import { PulseBand } from "./pulse-band";

interface Props {
  monitor: MonitorSummaryView;
}

export function MonitorCard({ monitor }: Props) {
  const { data: series, isLoading } = useQuery({
    queryKey: ["series", monitor.id, "cf_requests", 6],
    queryFn: () =>
      fetchSeries({
        data: {
          monitor: monitor.id,
          source: "cloudflare",
          metric: "cf_requests",
          hours: 6,
        },
      }),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  const state = deriveState(monitor);

  return (
    <article className="rounded-2xl border border-border bg-card p-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-xl">{monitor.id}</h3>
          <div className="mono mt-1 text-xs text-muted-foreground">
            {state.label}
            {monitor.lastLatencyMs !== null && (
              <> · {monitor.lastLatencyMs}ms</>
            )}
            {monitor.lastStatus !== null && (
              <> · status {monitor.lastStatus}</>
            )}
          </div>
        </div>
        <span
          className={`inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ${state.dotClass}`}
          aria-hidden
        />
      </header>
      <div className="mt-4">
        {isLoading ? (
          <div
            className="rounded-md bg-secondary/30"
            style={{ height: 48 }}
            aria-label="loading pulse"
          />
        ) : (
          <PulseBand
            series={series ?? []}
            anomalyColor={state.anomalyColor}
          />
        )}
      </div>
      <footer className="mt-2 flex items-center justify-between text-[10px] uppercase tracking-widest text-muted-foreground">
        <span>requests · last 6h · 5m buckets</span>
        <span className="mono">
          {monitor.currentAlerts.length > 0
            ? `${monitor.currentAlerts.length} alert${monitor.currentAlerts.length > 1 ? "s" : ""}`
            : "no alerts"}
        </span>
      </footer>
    </article>
  );
}

interface DerivedState {
  label: string;
  dotClass: string;
  anomalyColor: string;
}

function deriveState(m: MonitorSummaryView): DerivedState {
  if (m.isDown) {
    return {
      label: "DOWN",
      dotClass: "bg-status-critical shadow-[0_0_16px_-2px_var(--status-critical)]",
      anomalyColor: "var(--status-critical)",
    };
  }
  const worst = worstSeverity(m.currentAlerts);
  if (worst === "critical") {
    return {
      label: "critical alerts firing",
      dotClass: "bg-status-critical",
      anomalyColor: "var(--status-critical)",
    };
  }
  if (worst === "warning") {
    return {
      label: "warning alerts firing",
      dotClass: "bg-status-warning",
      anomalyColor: "var(--status-warning)",
    };
  }
  return {
    label: "up",
    dotClass: "bg-status-ok",
    anomalyColor: "var(--status-warning)",
  };
}

function worstSeverity(alerts: MonitorSummaryView["currentAlerts"]): string | null {
  if (alerts.some((a) => a.severity === "critical")) return "critical";
  if (alerts.some((a) => a.severity === "warning")) return "warning";
  return null;
}
