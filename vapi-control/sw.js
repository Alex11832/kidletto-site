// Vapi Live Control — service worker.
//
// Shows call alerts delivered by Web Push, including when no console tab is
// open, and brings the console forward when an alert is clicked. It caches
// nothing: the console is useless offline and every request must still pass
// Cloudflare Access.

const VIBRATE = [500, 250, 500, 250, 500, 250, 900];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function consoleWindows() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.filter((c) => c.url.startsWith(self.registration.scope));
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    (async () => {
      const windows = await consoleWindows();
      for (const c of windows) c.postMessage({ type: "push", data });
      // A console the operator is looking at rings by itself: keep the
      // system alert silent then, so it does not sound twice.
      const watching = windows.some((c) => c.focused && c.visibilityState === "visible");
      await self.registration.showNotification(data.title || "Vapi Live Control", {
        body: data.body || "",
        tag: data.tag || "vapi-control",
        renotify: true,
        requireInteraction: data.type === "call",
        icon: "icons/icon-192.png",
        badge: "icons/badge-96.png",
        timestamp: data.ts || Date.now(),
        data: { url: data.url || "./", callId: data.callId || null },
        ...(watching ? { silent: true } : { vibrate: VIBRATE }),
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url, callId } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const [existing] = await consoleWindows();
      if (existing) {
        await existing.focus();
        if (callId) existing.postMessage({ type: "select-call", callId });
        return;
      }
      await self.clients.openWindow(new URL(url || "./", self.registration.scope).href);
    })(),
  );
});

// The browser rotated the subscription: register the new one (best effort;
// the console also re-registers on every visit).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription?.options?.applicationServerKey;
      const sub = event.newSubscription || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
      if (!sub) return;
      await fetch(new URL("api/push/subscribe", self.registration.scope), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ subscription: sub.toJSON(), label: "renewed by the browser" }),
      });
    })().catch(() => {}),
  );
});
