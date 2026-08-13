import { useEffect, useState } from "react";
import type { SystemHealthView } from "@night-watch/core/web";
import {
  currentPermission,
  getExistingSubscription,
  pushSupported,
  subscribe,
  unsubscribeLocal,
  type PermissionState,
} from "../lib/push-client";
import { doSubscribePush, doUnsubscribePush } from "../lib/server-fns";

interface Props {
  system: SystemHealthView | undefined;
}

type UiState =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "no-server-key" }
  | { kind: "denied" }
  | { kind: "default" }
  | { kind: "subscribed"; endpoint: string }
  | { kind: "working"; label: string }
  | { kind: "error"; message: string };

export function SubscribeButton({ system }: Props) {
  const [state, setState] = useState<UiState>({ kind: "loading" });

  useEffect(() => {
    void refreshUi(system, setState);
  }, [system?.vapidPublicKey]);

  async function handleSubscribe() {
    if (!system?.vapidPublicKey) return;
    setState({ kind: "working", label: "asking browser…" });
    try {
      const local = await subscribe(system.vapidPublicKey);
      await doSubscribePush({ data: { ...local, label: describeDevice() } });
      setState({ kind: "subscribed", endpoint: local.endpoint });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (message.includes("denied")) setState({ kind: "denied" });
      else setState({ kind: "error", message });
    }
  }

  async function handleUnsubscribe() {
    setState({ kind: "working", label: "unsubscribing…" });
    try {
      const endpoint = await unsubscribeLocal();
      if (endpoint) await doUnsubscribePush({ data: { endpoint } });
      setState({ kind: "default" });
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message ?? String(err) });
    }
  }

  return (
    <div className="mt-6 rounded-2xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mono text-[10px] uppercase tracking-widest text-muted-foreground">
            browser notifications
          </div>
          <div className="mt-1 text-lg">{headline(state)}</div>
          <p className="mt-1 text-sm text-muted-foreground max-w-md">{blurb(state)}</p>
        </div>
        <PermissionCta
          state={state}
          onSubscribe={handleSubscribe}
          onUnsubscribe={handleUnsubscribe}
        />
      </div>
    </div>
  );
}

function PermissionCta({
  state,
  onSubscribe,
  onUnsubscribe,
}: {
  state: UiState;
  onSubscribe: () => void;
  onUnsubscribe: () => void;
}) {
  switch (state.kind) {
    case "default":
      return (
        <button
          type="button"
          onClick={onSubscribe}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-transform hover:scale-[0.98]"
        >
          Turn on
        </button>
      );
    case "subscribed":
      return (
        <button
          type="button"
          onClick={onUnsubscribe}
          className="rounded-full bg-secondary px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary/70"
        >
          Turn off
        </button>
      );
    case "working":
      return (
        <button
          type="button"
          disabled
          className="rounded-full bg-secondary px-5 py-2.5 text-sm text-muted-foreground"
        >
          {state.label}
        </button>
      );
    case "denied":
    case "no-server-key":
    case "unsupported":
    case "loading":
    case "error":
    default:
      return null;
  }
}

function headline(state: UiState): string {
  switch (state.kind) {
    case "loading":
      return "Checking…";
    case "unsupported":
      return "Not supported on this browser";
    case "no-server-key":
      return "Server missing VAPID keys";
    case "denied":
      return "Blocked by the browser";
    case "default":
      return "Get push notifications";
    case "subscribed":
      return "You're subscribed";
    case "working":
      return "Working…";
    case "error":
      return "Something went wrong";
  }
}

function blurb(state: UiState): string {
  switch (state.kind) {
    case "loading":
      return "Reading current permission…";
    case "unsupported":
      return "This browser doesn't support push notifications. Try Chrome, Firefox, or Safari 16+.";
    case "no-server-key":
      return "Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in the worker's environment to enable web push.";
    case "denied":
      return 'Open the site settings (padlock icon in the address bar) and set "Notifications" to Allow, then reload.';
    case "default":
      return "Critical alerts arrive with sound; warnings are silent. You can turn it off any time.";
    case "subscribed":
      return "This device will get an alert the moment something starts firing.";
    case "working":
      return "Talking to the browser…";
    case "error":
      return state.message;
  }
}

async function refreshUi(
  system: SystemHealthView | undefined,
  set: (state: UiState) => void,
): Promise<void> {
  if (!pushSupported()) {
    set({ kind: "unsupported" });
    return;
  }
  if (!system) {
    set({ kind: "loading" });
    return;
  }
  if (!system.vapidPublicKey) {
    set({ kind: "no-server-key" });
    return;
  }
  const perm: PermissionState = currentPermission();
  if (perm === "denied") {
    set({ kind: "denied" });
    return;
  }
  const existing = await getExistingSubscription();
  if (existing) {
    set({ kind: "subscribed", endpoint: existing.endpoint });
    return;
  }
  set({ kind: "default" });
}

function describeDevice(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "browser";
}
