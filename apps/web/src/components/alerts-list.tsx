import type { ActiveAlertView } from "@night-watch/core/web";

interface Props {
  alerts: ActiveAlertView[] | undefined;
}

const SEV_CHIP: Record<ActiveAlertView["severity"], { bg: string; text: string; label: string }> = {
  critical: { bg: "bg-status-critical/10", text: "text-status-critical", label: "CRITICAL" },
  warning: { bg: "bg-status-warning/10", text: "text-status-warning", label: "WARNING" },
  info: { bg: "bg-accent/10", text: "text-accent", label: "INFO" },
};

export function ActiveAlerts({ alerts }: Props) {
  return (
    <section aria-labelledby="active-heading" className="mt-10">
      <h2 id="active-heading" className="text-2xl mb-3">
        Currently firing
      </h2>
      {alerts && alerts.length === 0 && (
        <div className="rounded-2xl border border-border bg-card px-6 py-8 text-center text-muted-foreground">
          No alerts are firing right now.
        </div>
      )}
      {alerts && alerts.length > 0 && (
        <ul className="grid gap-2">
          {alerts.map((a) => {
            const chip = SEV_CHIP[a.severity];
            return (
              <li
                key={a.id}
                className="rounded-2xl border border-border bg-card p-5 transition-colors hover:border-foreground/20"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs uppercase tracking-widest">
                      <span className={`mono rounded-full px-2 py-0.5 ${chip.bg} ${chip.text}`}>
                        {chip.label}
                      </span>
                      <span className="mono text-muted-foreground">{a.monitor}</span>
                      <span aria-hidden className="text-muted-foreground">·</span>
                      <span className="mono text-muted-foreground">{a.type}</span>
                    </div>
                    <h3 className="mt-2 text-lg leading-tight">{a.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{a.body}</p>
                  </div>
                  <div className="mono text-right text-xs text-muted-foreground">
                    <div>started</div>
                    <div>{formatShort(a.startedAt)}</div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function formatShort(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const hh = String(d.getUTCHours() + 7).padStart(2, "0"); // WIB
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${(Number(hh) % 24).toString().padStart(2, "0")}:${mm}`;
}
