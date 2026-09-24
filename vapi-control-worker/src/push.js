// Web Push: call alerts that reach the operator's phone or desktop even when
// no console tab is open. Implemented with WebCrypto only:
//   RFC 8030  Web Push protocol (POST to the browser's push-service endpoint)
//   RFC 8292  VAPID — identifies this server to the push service (ES256 JWT)
//   RFC 8291  payload encryption (aes128gcm, RFC 8188), readable only by the
//             subscribed browser
//
// Keys: VAPID_PUBLIC_KEY (variable, base64url uncompressed P-256 point) and
// VAPID_PRIVATE_KEY (secret, base64url 32-byte scalar). VAPID_SUBJECT is the
// contact the push services see ("https:" or "mailto:" URI).

import { HttpError } from "./http.js";

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;
const MAX_PAYLOAD_BYTES = 3000;
const SEND_TIMEOUT_MS = 8000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Push services of Chrome/Edge-on-Android/Opera/Samsung (FCM), Firefox,
// Edge on Windows (WNS) and Safari/iOS (Apple). Anything else is refused, so
// a subscription can never make the Worker POST to an arbitrary host.
const PUSH_HOST_SUFFIXES = ["googleapis.com", "mozilla.com", "mozaws.net", "notify.windows.com", "push.apple.com"];

export function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(value) {
  const s = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// Encrypts one message for one subscription (RFC 8291, single record).
// `localKeys` and `salt` are injectable for the RFC test vector; normally a
// fresh key pair and salt are generated for every message.
export async function encryptPayload(plaintext, { p256dh, auth }, { localKeys, salt } = {}) {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error("invalid subscription keys");
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error("push payload too large");
  const keys = localKeys || (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, keys.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const s = salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(s, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(s, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02 marks the last (and only) record; no padding.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(s, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

export function pushConfigured(env) {
  return Boolean(String(env.VAPID_PUBLIC_KEY || "").trim() && String(env.VAPID_PRIVATE_KEY || "").trim());
}

let signingKey = null; // { pub, d, key } — cached per isolate

async function vapidSigningKey(env) {
  const pub = String(env.VAPID_PUBLIC_KEY || "").trim();
  const d = String(env.VAPID_PRIVATE_KEY || "").trim();
  if (signingKey?.pub === pub && signingKey.d === d) return signingKey.key;
  const raw = b64urlDecode(pub);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("VAPID_PUBLIC_KEY is not an uncompressed P-256 public key");
  const jwk = { kty: "EC", crv: "P-256", x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33)), d, ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  signingKey = { pub, d, key };
  return key;
}

export async function vapidAuthorization(endpoint, env, nowS = Math.floor(Date.now() / 1000)) {
  const key = await vapidSigningKey(env);
  const header = b64urlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(
    encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowS + 12 * 3600, sub: String(env.VAPID_SUBJECT || "https://kidletto.com") })),
  );
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64urlEncode(signature)}, k=${String(env.VAPID_PUBLIC_KEY).trim()}`;
}

// Local endpoints are accepted only in the automated tests, recognised the
// same way as the local Vapi mock (VAPI_API_BASE_URL on localhost).
function localTestMode(env) {
  try {
    return LOCAL_HOSTS.has(new URL(String(env.VAPI_API_BASE_URL || "")).hostname);
  } catch {
    return false;
  }
}

export function validateSubscription(input, env) {
  const endpoint = typeof input?.endpoint === "string" ? input.endpoint.trim() : "";
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, "invalid_subscription", "Push subscription has no valid endpoint.");
  }
  const host = url.hostname.toLowerCase();
  const knownService = url.protocol === "https:" && PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
  const localMock = localTestMode(env) && LOCAL_HOSTS.has(host);
  if (!knownService && !localMock) throw new HttpError(400, "invalid_subscription", "Unknown push service.");
  if (endpoint.length > 1000) throw new HttpError(400, "invalid_subscription", "Push endpoint is too long.");
  const p256dh = String(input?.keys?.p256dh || "");
  const auth = String(input?.keys?.auth || "");
  let ok = false;
  try {
    const pub = b64urlDecode(p256dh);
    ok = pub.length === 65 && pub[0] === 4 && b64urlDecode(auth).length === 16;
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(400, "invalid_subscription", "Push subscription keys are invalid.");
  return { endpoint, keys: { p256dh, auth } };
}

export async function subscriptionId(endpoint) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(endpoint)));
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Sends one message. Never throws: the result says whether the subscription
// is gone for good (404/410 — the browser unsubscribed or the app was removed).
export async function sendPush(subscription, message, env, { ttl = 120, urgency = "high", topic } = {}) {
  let host = "";
  try {
    host = new URL(subscription.endpoint).hostname;
    const body = await encryptPayload(encoder.encode(JSON.stringify(message)), subscription.keys);
    const headers = {
      Authorization: await vapidAuthorization(subscription.endpoint, env),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: urgency,
    };
    // A newer message with the same topic replaces an undelivered older one.
    if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
    const res = await fetch(subscription.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => null);
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410, host };
  } catch (error) {
    return { ok: false, status: 0, gone: false, host, error: error?.name || "error" };
  }
}
