import { useQuery } from "@tanstack/react-query";
import type {
  MonitorSummaryView,
  PulseView,
  ThresholdSignal,
} from "@night-watch/core/web";
import { fetchPulse } from "../lib/server-fns";
import { PulseBand, formatCount } from "./pulse-band";
import { UptimeStrip } from "./uptime-strip";
import { cn } from "@/lib/utils";

// One card per monitor. It has to answer three questions at a glance, on a
// phone, at 2am:
//
//   1. Is the site up?          -> the status pill
//   2. Is traffic normal?       -> the headline number vs its baseline
//   3. Is this data still fresh? -> the last-check fact
//
// Everything the card claims about "normal" comes from getPulse(), which runs
// the same detectors the alert engine runs. The card never decides for itself
// what counts as anomalous.

const WINDOW_HOURS = 6;

interface Props {
  monitor: MonitorSummaryView;
}

export function MonitorCard({ monitor }: Props) {
  // A monitor can exist in probe_state but no longer in monitors.json — the
  // row outlives the config entry. There is no pulse to fetch for it (and no
  // thresholds to judge it against), so don't ask every 20 seconds; say what
  // is actually wrong instead.
  const orphaned = monitor.thresholds === null;

  const {
    data: pulse,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ["pulse", monitor.id, WINDOW_HOURS],
    queryFn: () => fetchPulse({ data: { monitor: monitor.id, hours: WINDOW_HOURS } }),
    enabled: !orphaned,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  const status = deriveStatus(monitor);

  return (
    <article className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      {/* 1 — identity + status */}
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-xl">{monitor.label ?? monitor.id}</h3>
          {/* Only when it adds something. Repeating the slug under the slug is noise. */}
          {monitor.url && (
            <p className="mono mt-1 truncate text-xs text-muted-foreground">
              {monitor.url}
            </p>
          )}
        </div>
        <StatusPill status={status} />
      </header>

      {orphaned ? (
        <p className="mt-5 rounded-xl border border-border bg-secondary/40 px-4 py-3 text-sm text-muted-foreground">
          This monitor still has probe history but is no longer listed in{" "}
          <code className="mono">config/monitors.json</code>, so there is nothing
          to compare it against. Re-add it there, or let its data age out.
        </p>
      ) : isError ? (
        <p className="mt-5 rounded-xl border border-status-warning/40 bg-status-warning/10 px-4 py-3 text-sm">
          Could not load traffic for this monitor. The uptime facts below are
          still current.
        </p>
      ) : (
        <>
          {/* 2 — the headline number, next to what was expected */}
          <TrafficHeadline pulse={pulse} isLoading={isLoading} />

          {/* 3 — the chart */}
          <div className="mt-4">
            {!pulse ? (
              <ChartSkeleton />
            ) : (
              <PulseBand
                buckets={pulse.buckets}
                bucketSeconds={pulse.bucketSeconds}
                windowHours={pulse.windowHours}
              />
            )}
          </div>

          {pulse && <BaselineNote pulse={pulse} />}
        </>
      )}

      {/* 4 — the three threshold signals */}
      {pulse && monitor.thresholds && (
        <dl className="mt-5 grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-border">
          <SignalTile
            label="Latency"
            signal={pulse.latency}
            format={(v) => `${Math.round(v)}ms`}
            // Seconds for the limit: "3000ms" wraps the tile at 390px, "3s" does not.
            formatLimit={(v) => (v >= 1000 ? `${v / 1000}s` : `${Math.round(v)}ms`)}
          />
          <SignalTile
            label="Origin 5xx"
            signal={pulse.errors}
            format={formatPercent}
            formatLimit={formatPercent}
          />
          <SignalTile
            label="Firewall"
            signal={pulse.threats}
            format={formatPercent}
            formatLimit={formatPercent}
          />
        </dl>
      )}

      {/* 5 — uptime over the long windows the chart cannot show */}
      {!orphaned && <UptimeStrip monitor={monitor.id} />}

      {/* 6 — facts, failure reason, and what is actually firing */}
      <dl className="mono mt-5 grid grid-cols-2 gap-x-3 gap-y-3 text-xs sm:grid-cols-4">
        <Fact label="HTTP status" value={monitor.lastStatus?.toString() ?? "—"} />
        <Fact
          label="Last checked"
          value={monitor.lastCheckAt ? formatAgo(monitor.lastCheckAt) : "never"}
          tone={status.kind === "stale" ? "warning" : undefined}
        />
        <Fact
          label="TLS expires"
          value={formatCertDays(monitor.certDaysLeft)}
          // The verdict comes from getMonitors, which runs the same
          // evaluateCert the alert engine runs — the card does not own the
          // definition of "expiring soon".
          tone={monitor.certSeverity ?? undefined}
        />
        <Fact
          label="Alerts firing"
          value={monitor.currentAlerts.length.toString()}
          tone={monitor.currentAlerts.length > 0 ? "warning" : undefined}
        />
      </dl>

      {monitor.isDown && monitor.lastError && (
        <p className="mt-4 rounded-xl border border-status-critical/40 bg-status-critical/10 px-4 py-3 text-sm">
          <span className="mono text-[10px] uppercase tracking-widest text-status-critical">
            Probe failed
          </span>
          <span className="mt-1 block break-words">{monitor.lastError}</span>
        </p>
      )}

      {monitor.currentAlerts.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {monitor.currentAlerts.map((a) => (
            <li
              key={`${a.type}-${a.severity}`}
              className={cn(
                "mono rounded-full border px-2.5 py-1 text-[10px] uppercase tracking-widest",
                a.severity === "critical"
                  ? "border-status-critical/40 bg-status-critical/10 text-status-critical"
                  : "border-status-warning/40 bg-status-warning/10 text-status-warning",
              )}
            >
              {a.type} · {a.severity}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Zone 2 — traffic headline
// ---------------------------------------------------------------------------

function TrafficHeadline({
  pulse,
  isLoading,
}: {
  pulse: PulseView | undefined;
  isLoading: boolean;
}) {
  if (isLoading || !pulse) {
    return (
      <div className="mt-5 h-9 w-40 animate-pulse rounded-lg bg-secondary/40" />
    );
  }
  if (!pulse.latest) {
    return (
      <p className="mt-5 text-sm text-muted-foreground">
        No Cloudflare traffic recorded for this monitor.
      </p>
    );
  }

  const minutes = Math.round(pulse.bucketSeconds / 60);
  const { value, expected } = pulse.latest;

  return (
    <div className="mt-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="mono text-3xl tabular-nums">{formatCount(value)}</span>
      <span className="mono text-xs text-muted-foreground">
        requests / {minutes}m
      </span>
      {expected !== null && (
        <span className="text-sm text-muted-foreground">
          usually around{" "}
          <span className="mono tabular-nums">{formatCount(expected)}</span>
        </span>
      )}
    </div>
  );
}

/**
 * Says out loud why the chart is or is not judging anything. Without this, a
 * band-less chart is indistinguishable from a calm one.
 */
function BaselineNote({ pulse }: { pulse: PulseView }) {
  if (pulse.buckets.length === 0) return null;

  if (pulse.baselineSource === "insufficient") {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        Still collecting a baseline. Nothing here is being judged as normal or
        abnormal yet.
      </p>
    );
  }
  if (pulse.buckets.some((b) => b.state === "below-floor")) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        Traffic sits below the detection floor, so traffic anomalies stay muted
        for this monitor.
      </p>
    );
  }
  if (pulse.baselineSource === "rolling") {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        Compared against the last few hours. Week-over-week baseline needs more
        history.
      </p>
    );
  }
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      Compared against the same time of day over previous weeks.
    </p>
  );
}

// ---------------------------------------------------------------------------
// Zone 4 — threshold signals
// ---------------------------------------------------------------------------

function SignalTile({
  label,
  signal,
  format,
  formatLimit,
}: {
  label: string;
  signal: ThresholdSignal;
  format: (v: number) => string;
  formatLimit: (v: number) => string;
}) {
  const tone =
    signal.breached === "critical"
      ? "text-status-critical"
      : signal.breached === "warn"
        ? "text-status-warning"
        : "text-foreground";

  // Threats carry two thresholds; the one worth naming is the nearest one the
  // reading has not yet crossed.
  const limit =
    signal.critical !== null && signal.breached === "warn"
      ? signal.critical
      : signal.warn;

  return (
    <div className="bg-card px-4 py-3">
      <dt className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd className={cn("mono mt-1.5 text-lg tabular-nums", tone)}>
        {signal.value === null ? "—" : format(signal.value)}
      </dd>
      <p className="mono mt-0.5 text-[10px] text-muted-foreground">
        {signal.suppressed ? "below alert volume" : `limit ${formatLimit(limit)}`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

type StatusKind = "down" | "critical" | "warning" | "stale" | "up" | "unknown";

interface Status {
  kind: StatusKind;
  label: string;
}

/**
 * Stale is its own state on purpose. If the worker dies, `is_down` stays 0 and
 * the card would otherwise sit there showing a confident green forever.
 */
function deriveStatus(m: MonitorSummaryView): Status {
  if (m.isDown) return { kind: "down", label: "Down" };

  const interval = m.thresholds?.probeIntervalSeconds ?? 60;
  const age = m.lastCheckAt ? Date.now() / 1000 - m.lastCheckAt : null;
  if (age === null) return { kind: "unknown", label: "No data" };
  if (age > interval * 3) return { kind: "stale", label: "Stale" };

  const critical = m.currentAlerts.filter((a) => a.severity === "critical").length;
  if (critical > 0) {
    return { kind: "critical", label: `${critical} critical` };
  }
  const warning = m.currentAlerts.filter((a) => a.severity === "warning").length;
  if (warning > 0) {
    return { kind: "warning", label: `${warning} warning` };
  }
  return { kind: "up", label: "Up" };
}

// Text carries the meaning; colour only reinforces it (WCAG 1.4.1).
const PILL_TONE: Record<StatusKind, string> = {
  down: "border-status-critical/40 bg-status-critical/10 text-status-critical",
  critical: "border-status-critical/40 bg-status-critical/10 text-status-critical",
  warning: "border-status-warning/40 bg-status-warning/10 text-status-warning",
  stale: "border-status-warning/40 bg-status-warning/10 text-status-warning",
  up: "border-status-ok/40 bg-status-ok/10 text-status-ok",
  unknown: "border-border bg-secondary text-muted-foreground",
};

function StatusPill({ status }: { status: Status }) {
  return (
    <span
      className={cn(
        "mono shrink-0 rounded-full border px-3 py-1 text-[10px] uppercase tracking-widest",
        PILL_TONE[status.kind],
      )}
    >
      {status.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning" | "critical";
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 tabular-nums",
          tone === "critical"
            ? "text-status-critical"
            : tone === "warning"
              ? "text-status-warning"
              : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** Shaped like the chart it replaces, so the layout does not jump on arrival. */
function ChartSkeleton() {
  return (
    <div>
      <div
        className="flex items-end gap-px overflow-hidden rounded-lg"
        style={{ height: 64 }}
        aria-label="Loading traffic"
      >
        {Array.from({ length: 36 }, (_, i) => (
          <div
            key={i}
            className="flex-1 animate-pulse bg-secondary/40"
            style={{ height: `${28 + ((i * 37) % 55)}%` }}
          />
        ))}
      </div>
      <div className="mt-1.5 h-3" />
    </div>
  );
}

function formatPercent(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function formatAgo(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000 - unixSec);
  if (diff < 60) return `${Math.max(diff, 0)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86_400)}d ago`;
}

/**
 * Days are the useful unit here — "expires in 3 days" is actionable in a way
 * that a date string is not at 2am. Past expiry we say so outright rather
 * than printing a negative number.
 */
function formatCertDays(daysLeft: number | null): string {
  if (daysLeft === null) return "—";
  if (daysLeft < 0) return "expired";
  if (daysLeft === 0) return "today";
  return `${daysLeft}d`;
}
