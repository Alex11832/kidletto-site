// kidletto-vapi-control-webhook — public ingress for Vapi Server URL events.
//
// Vapi delivers live call events (status-update, conversation-update,
// transcript, speech-update, end-of-call-report) only to a Server URL. This
// small Worker is that URL. It:
//   1. authenticates Vapi with a shared secret sent by a Vapi "Bearer Token"
//      custom credential (Authorization: Bearer <secret>), compared in
//      constant time;
//   2. hands a sanitized copy of the event to the CallHub Durable Object that
//      belongs to the control-panel Worker (live transcript for browsers);
//   3. optionally forwards the untouched request to the previous Server URL
//      (WEBHOOK_FORWARD_URL) and returns that server's response to Vapi, so
//      existing integrations (e.g. Telegram call reports, tool calls) keep
//      working exactly as before.
//
// It holds no Vapi API key and cannot control calls.

import { sanitizeServerMessage } from "./events.js";
import { log } from "./log.js";

const PATH = "/vapi/events";
// Must match INGEST_PATH in hub.js (not imported: hub.js depends on the
// Durable Object runtime module, which this Worker does not need).
const HUB_INGEST_PATH = "/__hub/ingest";
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const FORWARD_TIMEOUT_MS = 15_000;

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const [a, b] = await Promise.all([digest(provided), digest(expected)]);
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Vapi "Bearer Token" custom credential: Authorization: Bearer <secret>.
// (A custom header would risk being stored by platform request logging.)
// Accepts "Bearer <secret>" and, for a Vapi credential saved with "Include
// Bearer Prefix" switched off, the bare secret. Either way the whole value
// must equal the secret exactly.
function providedSecret(request) {
  const auth = (request.headers.get("Authorization") || "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1].trim() : auth;
}

// Why a request was refused, without revealing anything about the secret
// beyond whether a value arrived at all and its length (for spotting a
// truncated or mistyped paste).
function rejectionDetail(request) {
  const auth = (request.headers.get("Authorization") || "").trim();
  if (!auth) return { reason: "no_authorization_header" };
  const bearer = /^Bearer\s+/i.test(auth);
  const value = providedSecret(request);
  return { reason: "secret_mismatch", bearerPrefix: bearer, providedLength: value.length };
}

function plain(status, text) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

async function publishToHub(env, body) {
  const event = sanitizeServerMessage(body);
  if (!event || !env.HUB) return;
  // One retry covers a Durable Object that is restarting (e.g. during a deploy).
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const hub = env.HUB.get(env.HUB.idFromName("hub"));
      const res = await hub.fetch(`https://hub.internal${HUB_INGEST_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!res.ok) throw new Error(`hub answered HTTP ${res.status}`);
      await res.arrayBuffer();
      if (event.kind === "status") log("webhook_status_event", { callId: event.callId, status: event.status, endedReason: event.endedReason });
      return;
    } catch (error) {
      if (attempt === 2) {
        log("hub_publish_failed", {
          callId: event.callId,
          kind: event.kind,
          reason: error?.name || "unknown",
          message: String(error?.message || "").slice(0, 200),
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function forward(env, request, raw) {
  const headers = new Headers({ "Content-Type": request.headers.get("Content-Type") || "application/json" });
  // Preserve Vapi's own metadata/signature headers. Our Authorization header
  // (the credential for this Worker) is deliberately not forwarded.
  for (const [name, value] of request.headers) {
    if (name.toLowerCase().startsWith("x-vapi-")) headers.set(name, value);
  }
  const res = await fetch(env.WEBHOOK_FORWARD_URL, {
    method: "POST",
    headers,
    body: raw,
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
  const payload = await res.arrayBuffer();
  return new Response(payload, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") || "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== PATH) return plain(404, "Not found");
    if (request.method !== "POST") return plain(405, "Method not allowed");
    if (!env.VAPI_WEBHOOK_SECRET) return plain(503, "Webhook secret not configured");

    if (!(await secretsMatch(providedSecret(request), env.VAPI_WEBHOOK_SECRET))) {
      log("webhook_rejected", { ...rejectionDetail(request), expectedLength: String(env.VAPI_WEBHOOK_SECRET).length });
      return plain(401, "Unauthorized");
    }

    const declared = Number(request.headers.get("Content-Length") || 0);
    if (declared > MAX_BODY_BYTES) return plain(413, "Payload too large");
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return plain(413, "Payload too large");

    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    // The hub publish is awaited (it never throws) instead of left to
    // waitUntil, so an event is delivered before Vapi gets its answer.
    const hubTask = body ? publishToHub(env, body) : Promise.resolve();

    if (env.WEBHOOK_FORWARD_URL) {
      const forwarded = forward(env, request, raw).catch((error) => {
        log("webhook_forward_failed", { type: body?.message?.type || null, reason: error?.name || "unknown" });
        return plain(502, "Forwarding failed");
      });
      const [response] = await Promise.all([forwarded, hubTask]);
      return response;
    }
    await hubTask;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  },
};
