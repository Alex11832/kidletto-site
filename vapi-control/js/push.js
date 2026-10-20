// Call alerts that work with the console closed, and "install as an app".
//
//   service worker  sw.js — receives Web Push messages from the Worker and
//                   shows a system notification (sound/vibration are the
//                   device's own notification settings).
//   subscription    one per browser/device, stored by the Worker; renewed on
//                   every visit so the server list stays current.
//
// iPhone/iPad: Safari only delivers web push to a console added to the Home
// Screen (Share -> Add to Home Screen) and opened from there.

function b64urlToBytes(value) {
  const s = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64url(buffer) {
  if (!buffer) return "";
  let s = "";
  for (const b of new Uint8Array(buffer)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isIos() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return Boolean(window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone);
}

export function pushSupported() {
  return Boolean(window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window);
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : isIos() ? "iPhone/iPad" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${os} · ${browser}${isStandalone() ? " (app)" : ""}`;
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
  try {
    await navigator.serviceWorker.register("sw.js", { scope: "./" });
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export async function currentSubscription(registration) {
  try {
    return (await registration?.pushManager?.getSubscription()) || null;
  } catch {
    return null;
  }
}

// Subscribes this browser (or reuses its subscription) with the Worker's
// VAPID key and registers it with the Worker. A subscription made for an
// older key is replaced. Needs notification permission.
export async function enablePush(api, registration, publicKey) {
  let sub = await currentSubscription(registration);
  if (sub && bytesToB64url(sub.options?.applicationServerKey) !== publicKey) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  if (!sub) sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  await api.pushSubscribe(sub.toJSON(), deviceLabel());
  return sub;
}

export async function disablePush(api, registration) {
  const sub = await currentSubscription(registration);
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
