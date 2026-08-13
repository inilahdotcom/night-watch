// Browser-side push subscription helpers. All the ugly Web Push API bits
// (base64url conversion, permission dance, SW registration) live here so
// the SubscribeButton component stays declarative.

export type PermissionState = "default" | "granted" | "denied" | "unsupported";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

export function currentPermission(): PermissionState {
  if (!pushSupported()) return "unsupported";
  return Notification.permission as PermissionState;
}

async function registerSw(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js");
}

/**
 * VAPID public keys are base64-URL — the PushManager wants raw bytes.
 * (Uint8Array, not ArrayBuffer — Safari care.)
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Allocate a plain ArrayBuffer explicitly — modern TS's Uint8Array is
  // generic over the backing buffer, and PushManager wants ArrayBuffer
  // (not SharedArrayBuffer).
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

function toStored(sub: PushSubscription): StoredSubscription {
  const p256dhBuf = sub.getKey("p256dh");
  const authBuf = sub.getKey("auth");
  if (!p256dhBuf || !authBuf) {
    throw new Error("subscription missing encryption keys");
  }
  return {
    endpoint: sub.endpoint,
    p256dh: bufToBase64Url(p256dhBuf),
    auth: bufToBase64Url(authBuf),
  };
}

function bufToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.byteLength; i += 1) str += String.fromCharCode(bytes[i]!);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Ensure the SW is registered and grab any existing subscription. */
export async function getExistingSubscription(): Promise<StoredSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await registerSw();
  const sub = await reg.pushManager.getSubscription();
  return sub ? toStored(sub) : null;
}

/** Request permission (if needed) and subscribe with the given VAPID key. */
export async function subscribe(vapidPublicKey: string): Promise<StoredSubscription> {
  if (!pushSupported()) throw new Error("push not supported");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    throw new Error(`permission ${perm}`);
  }
  const reg = await registerSw();
  const existing = await reg.pushManager.getSubscription();
  if (existing) return toStored(existing);
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  return toStored(sub);
}

export async function unsubscribeLocal(): Promise<string | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return endpoint;
}
