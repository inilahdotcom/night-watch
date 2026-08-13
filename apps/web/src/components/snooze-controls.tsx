import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  AdhocSnooze,
  MonitorSummaryView,
  SnoozeScope,
  SnoozesView,
} from "@night-watch/core/web";
import { doEnqueueCommand } from "../lib/server-fns";

interface Props {
  snoozes: SnoozesView | undefined;
  monitors: MonitorSummaryView[] | undefined;
}

type FormState = {
  scope: "global" | string; // "global" or monitor id
  reason: string;
};

const QUICK_DURATIONS: Array<{ label: string; minutes: number }> = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "4h", minutes: 240 },
];

export function SnoozeControls({ snoozes, monitors }: Props) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>({ scope: "global", reason: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const adhoc = snoozes?.adhoc ?? [];
  const recurring = snoozes?.recurring ?? [];

  async function snooze(minutes: number): Promise<void> {
    setBusy(`snooze:${minutes}`);
    setError(null);
    try {
      const scope: SnoozeScope =
        form.scope === "global" ? "global" : { monitor: form.scope };
      await doEnqueueCommand({
        data: {
          kind: "snooze",
          payload: {
            scope,
            durationMinutes: minutes,
            reason: form.reason.trim() || undefined,
          },
        },
      });
      setForm((f) => ({ ...f, reason: "" }));
      // Command processor polls every ~2s. Refetch shortly after.
      setTimeout(() => void qc.invalidateQueries({ queryKey: ["snoozes"] }), 2500);
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(null);
    }
  }

  async function unsnooze(scope: SnoozeScope): Promise<void> {
    setBusy(`unsnooze:${scopeKey(scope)}`);
    setError(null);
    try {
      await doEnqueueCommand({
        data: { kind: "unsnooze", payload: { scope } },
      });
      setTimeout(() => void qc.invalidateQueries({ queryKey: ["snoozes"] }), 2500);
    } catch (err) {
      setError((err as Error).message ?? String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="snooze-heading" className="mt-6 rounded-2xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            snooze &amp; maintenance
          </div>
          <h2 id="snooze-heading" className="mt-1 text-lg">
            {adhoc.length === 0 && recurring.length === 0
              ? "Nothing muted right now"
              : `${adhoc.length + recurring.length} active suppression${adhoc.length + recurring.length === 1 ? "" : "s"}`}
          </h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Mute all channels for a while (deploys, planned maintenance). Alerts still land in
            the dashboard; resolves always break through.
          </p>
        </div>
      </div>

      {adhoc.length > 0 && (
        <ul className="mt-4 grid gap-2">
          {adhoc.map((s) => (
            <SnoozeRow
              key={scopeKey(s.scope)}
              snooze={s}
              onClear={() => unsnooze(s.scope)}
              busy={busy === `unsnooze:${scopeKey(s.scope)}`}
            />
          ))}
        </ul>
      )}

      {recurring.length > 0 && (
        <div className="mt-4 rounded-lg border border-border/60 bg-background/40 px-4 py-3">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            recurring windows (config)
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            {recurring.map((r) => (
              <li key={r.monitor} className="mono text-xs text-muted-foreground">
                <span className="text-foreground">{r.monitor}</span>{" "}
                {r.windows
                  .map((w) => `${w.start}-${w.end}${w.daysOfWeek?.length ? ` [${w.daysOfWeek.join(",")}]` : ""}`)
                  .join(", ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5 border-t border-border pt-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[180px] flex-1">
            <label className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              scope
            </label>
            <select
              value={form.scope}
              onChange={(e) => setForm((f) => ({ ...f, scope: e.target.value }))}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="global">All monitors</option>
              {(monitors ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[180px] flex-1">
            <label className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
              reason (optional)
            </label>
            <input
              type="text"
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value.slice(0, 120) }))}
              placeholder="deploy, maintenance…"
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground/60"
            />
          </div>
          <div className="flex items-end gap-2">
            {QUICK_DURATIONS.map((d) => (
              <button
                key={d.minutes}
                type="button"
                disabled={busy !== null}
                onClick={() => void snooze(d.minutes)}
                className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-transform hover:scale-[0.98] disabled:opacity-50"
              >
                {busy === `snooze:${d.minutes}` ? "…" : `Snooze ${d.label}`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-status-critical/40 bg-status-critical/10 px-3 py-2 text-sm text-status-critical">
          {error}
        </div>
      )}
    </section>
  );
}

function SnoozeRow({
  snooze,
  onClear,
  busy,
}: {
  snooze: AdhocSnooze;
  onClear: () => void;
  busy: boolean;
}) {
  const remaining = useCountdown(snooze.endsAt);
  const label =
    snooze.scope === "global"
      ? "All monitors"
      : `Monitor · ${snooze.scope.monitor}`;
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        <div className="mono text-xs text-muted-foreground">
          {remaining} left
          {snooze.reason ? ` · ${snooze.reason}` : ""}
        </div>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={onClear}
        className="rounded-full bg-secondary px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-50"
      >
        {busy ? "…" : "Clear"}
      </button>
    </li>
  );
}

function scopeKey(scope: SnoozeScope): string {
  return scope === "global" ? "global" : `monitor:${scope.monitor}`;
}

function useCountdown(endsAt: number): string {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, endsAt - now);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh > 0) return `${hh}h ${String(mm).padStart(2, "0")}m`;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}
