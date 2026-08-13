/*
 * Night Watch service worker.
 *
 * Handles incoming web-push events and renders a native notification. Nothing
 * else — no offline caching, no background sync. Keep it small; the browser
 * will fetch the freshest bundle every page load anyway.
 */

self.addEventListener("push", (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: "Night Watch", body: event.data.text() };
    }
  }

  const title = payload.title || "Night Watch";
  const body = payload.body || "";
  const severity = payload.severity || "info";
  const requireInteraction = Boolean(payload.requireInteraction);

  const options = {
    body,
    icon: "/favicon.ico",
    badge: "/favicon.ico",
    tag: payload.fingerprint || "night-watch",
    // Reuse tag on renotify so we replace the previous notification (per-alert)
    // rather than piling up duplicates during a long incident.
    renotify: true,
    requireInteraction,
    data: payload,
    silent: severity !== "critical",
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        if (clients.length > 0) {
          const c = clients[0];
          if ("focus" in c) return c.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow("/");
      }),
  );
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
