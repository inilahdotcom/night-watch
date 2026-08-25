import { createFileRoute, redirect } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  fetchActiveAlerts,
  fetchAlertHistory,
  fetchMonitors,
  fetchRecentAlertCount,
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
import { fetchAuthState } from "../lib/auth-fns";

export const Route = createFileRoute("/")({
  // Cosmetic: the real gate is `authMiddleware` on every server function in
  // lib/server-fns.ts. This just spares an authenticated-looking shell that
  // would only render 401s.
  beforeLoad: async () => {
    const state = await fetchAuthState();
    if (state.enabled && !state.authed) throw redirect({ to: "/login" });
  },
  component: DashboardPage,
});

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
  const recent = useQuery({
    queryKey: ["recent-alert-count"],
    queryFn: () => fetchRecentAlertCount(),
  });

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
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 id="monitors-heading" className="text-2xl">
            Monitors
          </h2>
          {recent.data && (
            <span className="mono text-xs text-muted-foreground">
              {recent.data.count === 0
                ? `no alerts in ${recent.data.hours}h`
                : `${recent.data.count} alert${recent.data.count === 1 ? "" : "s"} in ${recent.data.hours}h`}
            </span>
          )}
        </div>
        {monitors.data && monitors.data.length === 0 ? (
          <div className="rounded-2xl border border-border bg-card px-6 py-8 text-center text-muted-foreground">
            No monitors have reported yet. Check <code className="mono">config/monitors.json</code> and
            that the worker is running.
          </div>
        ) : (
          // One column: each card now carries a chart plus a three-up signal
          // strip, and squeezing that into half of max-w-3xl made both
          // unreadable.
          <div className="grid gap-4">
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
