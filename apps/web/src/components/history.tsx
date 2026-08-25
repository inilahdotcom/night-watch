import type { HistoryEntryView } from "@night-watch/core/web";

interface Props {
  entries: HistoryEntryView[] | undefined;
}

export function History({ entries }: Props) {
  return (
    <section aria-labelledby="history-heading" className="mt-10">
      <h2 id="history-heading" className="text-2xl mb-3">
        Recent history
      </h2>
      {entries && entries.length === 0 && (
        <p className="text-muted-foreground text-sm">Nothing yet.</p>
      )}
      {entries && entries.length > 0 && (
        <ol className="grid gap-1 rounded-2xl border border-border bg-card p-1">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl px-4 py-3 transition-colors hover:bg-secondary"
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${dotColor(entry)}`}
                aria-hidden
              />
              <div className="min-w-0">
                <div className="truncate text-sm">{entry.title}</div>
                <div className="mono truncate text-xs text-muted-foreground">
                  {entry.monitor} · {entry.type} · {entry.severity}
                  {entry.status === "resolved" && entry.resolvedAt !== null && (
                    <> · lasted {formatDuration(entry.resolvedAt - entry.startedAt)}</>
                  )}
                  {/* Only failures. This list is meant to stay scannable at 25
                      rows, so a successful delivery — the normal case — earns
                      no ink; a notification that never arrived does. */}
                  {failedChannels(entry).length > 0 && (
                    <span className="text-status-critical">
                      {" "}
                      · delivery failed: {failedChannels(entry).join(", ")}
                    </span>
                  )}
                </div>
              </div>
              <span className="mono text-xs text-muted-foreground">
                {entry.status === "resolved" ? "resolved" : "firing"} · {formatShort(entry.startedAt)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function failedChannels(e: HistoryEntryView): string[] {
  return e.deliveries.filter((d) => d.status === "failed").map((d) => d.channel);
}

function dotColor(e: HistoryEntryView): string {
  if (e.status === "firing") {
    if (e.severity === "critical") return "bg-status-critical";
    if (e.severity === "warning") return "bg-status-warning";
    return "bg-accent";
  }
  return "bg-muted-foreground/50";
}

function formatShort(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const wibHour = (d.getUTCHours() + 7) % 24;
  const hh = String(wibHour).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mo}/${day} ${hh}:${mm}`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
