import type { StatusView } from "@night-watch/core/web";

// The single-glance verdict. Big statement + pulsing indicator whose cadence
// changes with severity. Placed above the fold so the "is there a problem"
// question is answered inside one second, on a phone, at 2am.

interface Props {
  status: StatusView | undefined;
  isFetching: boolean;
}

const SEVERITY_LABEL: Record<StatusView["verdict"], string> = {
  ok: "All quiet",
  warning: "Something to look at",
  critical: "Attention needed now",
  unknown: "Waiting for data",
};

export function Verdict({ status, isFetching }: Props) {
  const severity = status?.verdict ?? "unknown";
  const label = SEVERITY_LABEL[severity];

  return (
    <section aria-labelledby="verdict-heading" className="pt-8 pb-6">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="mono uppercase tracking-widest">Night Watch</span>
        <span aria-hidden>·</span>
        <span className="mono">
          {isFetching ? "refreshing…" : status ? formatUpdated(status.updatedAt) : "…"}
        </span>
      </div>
      <div className="mt-4 flex items-start gap-4">
        <span
          aria-hidden
          className="pulse-dot mt-3 flex-shrink-0"
          data-severity={severity}
        />
        <h1 id="verdict-heading" className="text-5xl leading-[0.95] sm:text-6xl">
          {label}
        </h1>
      </div>
      <p className="mt-3 text-lg text-muted-foreground max-w-2xl">
        {status?.message ?? "First data still landing — the worker takes a minute to complete a cycle."}
      </p>
      {status && (
        <div className="mt-6 flex gap-6 text-sm text-muted-foreground">
          <Stat label="monitors" value={status.monitorCount} />
          <Stat label="firing" value={status.firingCount} tone={status.firingCount > 0 ? "warning" : undefined} />
          <Stat label="critical" value={status.criticalCount} tone={status.criticalCount > 0 ? "critical" : undefined} />
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warning" | "critical" }) {
  const color =
    tone === "critical" ? "text-status-critical" : tone === "warning" ? "text-status-warning" : "text-foreground";
  return (
    <span className="mono">
      <span className={`text-lg ${color}`}>{value}</span>
      <span className="ml-1.5 uppercase tracking-widest text-[10px]">{label}</span>
    </span>
  );
}

function formatUpdated(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000 - unixSec);
  if (diff < 30) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}
