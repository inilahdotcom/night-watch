import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import type { ActiveAlertView } from "@night-watch/core/web"
import { doEnqueueCommand } from "../lib/server-fns"
import { Button } from "./ui/button"

// Acknowledge / un-acknowledge one firing alert.
//
// Goes through the `commands` outbox like every other write from the web app,
// so `mutations.ts` stays exactly as narrow as it was — the worker remains the
// only process that writes to `alerts`.
//
// The command is queued, not applied, so the alert does not change the instant
// the button is pressed. The worker drains the outbox every 2s; the button
// says "queued…" until a refetch shows the change rather than optimistically
// lying about state it does not own.

export function AckButton({ alert }: { alert: ActiveAlertView }) {
  const qc = useQueryClient()
  const [queued, setQueued] = useState(false)
  const acked = alert.ackedAt !== null

  const mutation = useMutation({
    mutationFn: (kind: "ack" | "unack") =>
      doEnqueueCommand({ data: { kind, payload: { alertId: alert.id } } }),
    onSuccess: async () => {
      setQueued(true)
      // The worker polls every 2s. Give it a beat, then refetch — and clear
      // the "queued" state either way so the button never sticks.
      setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ["active"] })
        void qc.invalidateQueries({ queryKey: ["history"] })
        setQueued(false)
      }, 2500)
    },
  })

  if (acked) {
    return (
      <div className="mt-3 flex items-center gap-2">
        <span className="mono text-status-ok text-[10px] tracking-widest uppercase">
          ✓ acknowledged{alert.ackedBy ? ` by ${alert.ackedBy}` : ""}
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={mutation.isPending || queued}
          onClick={() => mutation.mutate("unack")}
        >
          {queued ? "queued…" : "undo"}
        </Button>
      </div>
    )
  }

  return (
    <Button
      size="xs"
      variant="outline"
      className="mt-3"
      disabled={mutation.isPending || queued}
      onClick={() => mutation.mutate("ack")}
    >
      {queued ? "queued…" : "Acknowledge"}
    </Button>
  )
}
