import { createFileRoute } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchActiveAlerts,
  fetchAlertHistory,
  fetchMonitors,
  fetchSnoozes,
  fetchStatus,
  fetchSystemHealth,
} from "../lib/server-fns";
import { Verdict } from "../components/verdict";
import { ActiveAlerts } from "../components/alerts-list";
import { History } from "../components/history";
import { MonitorCard } from "../components/monitor-card";
import { SubscribeButton } from "../components/subscribe-button";
import { SnoozeControls } from "../components/snooze-controls";
import { Loader } from "../components/ui/loader";

export const Route = createFileRoute("/")({ component: DashboardPage });

// Dashboard: single-page layout ordered per brief §7.
//   1) Verdict — one big statement + pulsing indicator
//   2) Notifications — subscribe/unsubscribe (handles the 3 permission states)
//   3) Currently firing
//   4) Monitors (with pulse-band per monitor)
//   5) Recent history
//   6) WhatsApp QR prompt (only when the worker is asking for a re-scan)

function DashboardPage() {
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
  );

  return (
    <QueryClientProvider client={qc}>
      <DashboardBody />
    </QueryClientProvider>
  );
}

function DashboardBody() {
  const status = useQuery({ queryKey: ["status"], queryFn: () => fetchStatus() });
  const active = useQuery({ queryKey: ["active"], queryFn: () => fetchActiveAlerts() });
  const history = useQuery({
    queryKey: ["history"],
    queryFn: () => fetchAlertHistory({ data: { limit: 25 } }),
  });
  const monitors = useQuery({ queryKey: ["monitors"], queryFn: () => fetchMonitors() });
  const system = useQuery({ queryKey: ["system"], queryFn: () => fetchSystemHealth() });
  const snoozes = useQuery({ queryKey: ["snoozes"], queryFn: () => fetchSnoozes() });

  // Show the full-page loader only on the very first fetch of the primary
  // data. Once we have snapshots, subsequent refetches are silent so the
  // "just now / refreshing…" chip in <Verdict> is the source of truth.
  const bootstrapping =
    status.isPending || monitors.isPending || active.isPending || system.isPending;

  if (bootstrapping) {
    return (
      <main className="mx-auto flex min-h-svh max-w-3xl items-center justify-center px-5 sm:px-8">
        <Loader label="Night Watch" hint="Gathering the latest signal…" />
      </main>
    );
  }

  return (
    <main className="mx-auto min-h-svh max-w-3xl px-5 pb-24 sm:px-8">
      <Verdict status={status.data} isFetching={status.isFetching} />

      {system.data?.waNeedsRelink && (
        <div className="mt-6 rounded-2xl border border-status-warning/40 bg-status-warning/10 p-5">
          <div className="mono text-[10px] uppercase tracking-widest text-status-warning">
            WhatsApp needs relink
          </div>
          <div className="mt-2 text-sm">
            {system.data.waRelinkReason ?? "The Baileys session was invalidated."} Restart the worker
            to scan a new QR from the terminal (or clear <code className="mono">apps/worker/auth_wa/</code>).
          </div>
        </div>
      )}

      <SubscribeButton system={system.data} />

      <SnoozeControls snoozes={snoozes.data} monitors={monitors.data} />

      <ActiveAlerts alerts={active.data} />

      <section aria-labelledby="monitors-heading" className="mt-10">
        <h2 id="monitors-heading" className="text-2xl mb-3">
          Monitors
        </h2>
        {monitors.data && monitors.data.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card px-6 py-8 text-center text-muted-foreground">
            No monitors have reported yet. Check <code className="mono">config/monitors.json</code> and
            that the worker is running.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {monitors.data?.map((m) => (
              <MonitorCard key={m.id} monitor={m} />
            ))}
          </div>
        )}
      </section>

      <History entries={history.data} />

      <footer className="mt-16 text-center text-xs text-muted-foreground">
        <div className="mono">
          Night Watch · monitor 24/7 · self-hosted · open source
        </div>
      </footer>
    </main>
  );
}
