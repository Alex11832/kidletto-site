// kidletto-vapi-control — private operator console for live Vapi calls.
//
// Everything lives under /vapi-control/ so the same Worker can serve
//   https://<worker>.workers.dev/vapi-control/          (works today)
//   https://kidletto.com/vapi-control/                  (route, once the zone is on Cloudflare)
//
//   /vapi-control/                      static console (../vapi-control)
//   /vapi-control/api/session           GET   who am I + server clock
//   /vapi-control/api/calls             GET   active calls (sanitized)
//   /vapi-control/api/calls/:id         GET   one call + capabilities
//   /vapi-control/api/calls/:id/say     POST  exact say, optionally translated first (and end call after spoken)
//   /vapi-control/api/calls/:id/instruction  POST  add-message for this call only
//   /vapi-control/api/calls/:id/mode    POST  operator mode on/off (assistant muted while the human drives)
//   /vapi-control/api/calls/:id/dtmf    POST  DTMF via the assistant's dtmf tool (if present)
//   /vapi-control/api/calls/:id/end     POST  end-call
//   /vapi-control/api/calls/:id/listen  WS    live audio (proxied listenUrl)
//   /vapi-control/api/events            WS    live transcript/status events (CallHub)
//   /vapi-control/api/transcribe        POST  operator dictation (audio) -> text
//   /vapi-control/api/push/...          POST  Web Push alerts: subscribe / unsubscribe / test
//
// Every request, including static files, requires a valid Cloudflare Access
// identity (see auth.js). State-changing requests and WebSocket upgrades also
// require an allowed Origin.

import { authenticate, AuthError, configWarnings } from "./auth.js";
import {
  HttpError,
  apiError,
  applyCors,
  assertOrigin,
  isWebSocketUpgrade,
  json,
  preflightResponse,
  readBytesBody,
  readJsonBody,
  withSecurityHeaders,
} from "./http.js";
import { aiAvailable, needsTranslation, transcribe, translateLine } from "./ai.js";
import { pushConfigured, validateSubscription } from "./push.js";
import {
  CONTROLLABLE_STATUS,
  LOOKBACK_MS,
  assertCallId,
  assertDtmfKeys,
  assistantHasDtmfTool,
  dtmfInstruction,
  isActive,
  matchesAssistantFilter,
  sortCalls,
  summarizeCall,
} from "./calls.js";
import { createVapiClient } from "./vapi.js";
import { log } from "./log.js";

export { CallHub } from "./hub.js";

const PREFIX = "/vapi-control";
const MAX_SAY_CHARS = 1000;
const MAX_INSTRUCTION_CHARS = 4000;
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const AUDIO_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/aac", "audio/x-m4a"]);

// Best-effort, per-isolate memory used only to avoid repeating log lines.
const seenActiveCalls = new Set();

function requireText(value, max, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HttpError(400, "empty_text", `${field} is empty.`);
  if (text.length > max) throw new HttpError(400, "text_too_long", `${field} is longer than ${max} characters.`);
  return text;
}

async function loadCall(client, env, callId, { require } = {}) {
  let call;
  try {
    call = await client.getCall(callId);
  } catch (error) {
    if (error.code === "not_found") throw new HttpError(404, "call_not_found", "Call not found.");
    throw error;
  }
  // Calls of other assistants are treated as nonexistent.
  if (!call || call.id?.toLowerCase() !== callId || !matchesAssistantFilter(call, env)) {
    throw new HttpError(404, "call_not_found", "Call not found.");
  }
  if (require === "controllable" && call.status !== CONTROLLABLE_STATUS) {
    throw callStateError(call);
  }
  if (require === "active" && !isActive(call)) throw callStateError(call);
  return call;
}

function callStateError(call) {
  if (call.status === "ended") {
    return new HttpError(409, "call_ended", `The call has already ended${call.endedReason ? ` (${call.endedReason})` : ""}.`, {
      status: call.status,
      endedReason: call.endedReason || null,
    });
  }
  return new HttpError(409, "call_not_in_progress", `The call is ${call.status || "not active"}; commands need an in-progress call.`, {
    status: call.status || null,
  });
}

// When Vapi rejects a command, check whether the call ended meanwhile so the
// operator gets "call ended" instead of a generic error.
async function explainControlFailure(client, env, callId, error) {
  if (error?.code !== "control_rejected" && error?.code !== "vapi_unreachable" && error?.code !== "vapi_timeout") return error;
  // Vapi's control server answers 400 "Call ... Not Active" once a call has
  // ended, sometimes before GET /call reports it: that is "call ended".
  if (error.code === "control_rejected" && /not active/i.test(error.message)) {
    return new HttpError(409, "call_ended", "The call has already ended.", { status: "ended", endedReason: null });
  }
  try {
    const call = await client.getCall(callId);
    if (call && call.status !== CONTROLLABLE_STATUS) return callStateError(call);
  } catch {
    // Keep the original error.
  }
  return error;
}

async function runControl(client, env, call, payload, event, fields) {
  log(event, { callId: call.id, ...fields });
  try {
    await client.control(call, payload);
  } catch (error) {
    const explained = await explainControlFailure(client, env, call.id, error);
    log("control_command_failed", { callId: call.id, type: payload.type, code: explained.code, vapiStatus: explained.details?.vapiStatus });
    throw explained;
  }
}

async function sendControl(client, env, call, payload, event, fields) {
  await runControl(client, env, call, payload, event, fields);
  return json({ ok: true, callId: call.id });
}

async function hubCall(env, path, body) {
  const hub = env.HUB.get(env.HUB.idFromName("hub"));
  const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await hub.fetch(`https://hub.internal${path}`, init);
  return res.json();
}

// How long an operator line may take to be heard: the hub re-mutes the
// assistant after this at the latest (normally sooner, when Vapi reports
// that the assistant stopped speaking).
function lineEstimateMs(chars, { translated = false, viaModel = false } = {}) {
  const ms = (chars / 13) * 1000 + 3000 + (translated ? 1500 : 0) + (viaModel ? 6000 : 0);
  return Math.round(Math.min(30000, Math.max(4000, ms)));
}

// Operator mode keeps the assistant muted; the hub (shared by every browser
// and device) says whether this call is in it. Returns whether the assistant
// must be unmuted for this line.
async function beginOperatorLine(env, callId, estimateMs) {
  if (!env.HUB) return false;
  try {
    return (await hubCall(env, "/__hub/line", { callId, estimateMs }))?.mute === true;
  } catch (error) {
    log("operator_line_check_failed", { callId, reason: error?.name || "error" });
    return false;
  }
}

// Unmutes the assistant for one operator line and sends it. If sending fails,
// the assistant is muted again straight away.
async function speakOperatorLine(client, env, call, unmute, payload, event, fields) {
  if (unmute) await runControl(client, env, call, { type: "control", control: "unmute-assistant" }, "assistant_unmuted_for_line", {});
  try {
    await runControl(client, env, call, payload, event, { ...fields, operator: unmute });
  } catch (error) {
    if (unmute) client.control(call, { type: "control", control: "mute-assistant" }).catch(() => {});
    throw error;
  }
}

async function handleApi(request, env, identity, subpath) {
  const method = request.method;

  if (subpath === "/session" && method === "GET") {
    return json({
      ok: true,
      now: Date.now(),
      user: { email: identity.email, dev: Boolean(identity.dev) },
      assistantFilter: Boolean(String(env.VAPI_ASSISTANT_ID || "").trim()),
      vapiConfigured: Boolean(env.VAPI_API_KEY),
      eventsAvailable: Boolean(env.HUB),
      dictation: aiAvailable(env),
      translation: aiAvailable(env),
      push: { publicKey: pushConfigured(env) && env.HUB ? String(env.VAPID_PUBLIC_KEY).trim() : null },
      warnings: configWarnings(env),
    });
  }

  // Operator dictation: the operator's own recorded voice, never call audio.
  if (subpath === "/transcribe" && method === "POST") {
    assertOrigin(request, env);
    const type = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!AUDIO_TYPES.has(type)) throw new HttpError(415, "unsupported_media_type", "Expected an audio recording.");
    const bytes = await readBytesBody(request, MAX_AUDIO_BYTES, "Recording");
    if (bytes.length < 800) throw new HttpError(400, "audio_too_short", "The recording is empty.");
    const started = Date.now();
    const { text, model } = await transcribe(env, bytes, type, new URL(request.url).searchParams.get("lang"));
    // The dictated words themselves are never logged.
    log("dictation_transcribed", { bytes: bytes.length, chars: text.length, model, ms: Date.now() - started, by: identity.email });
    return json({ ok: true, text });
  }

  if (subpath.startsWith("/push/")) {
    if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
    assertOrigin(request, env);
    if (!env.HUB) throw new HttpError(503, "events_unavailable", "Storage is not configured.");
    const body = await readJsonBody(request);
    if (subpath === "/push/subscribe") {
      if (!pushConfigured(env)) throw new HttpError(503, "push_not_configured", "Push alerts are not configured on the Worker (VAPID keys).");
      const subscription = validateSubscription(body.subscription, env);
      const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
      const res = await hubCall(env, "/__hub/push/put", { subscription, label, by: identity.email });
      log("push_subscribed", { host: new URL(subscription.endpoint).hostname, label, devices: res.count, by: identity.email });
      return json({ ok: true, devices: res.count });
    }
    if (subpath === "/push/unsubscribe") {
      const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
      if (!endpoint) throw new HttpError(400, "invalid_subscription", "endpoint is required.");
      await hubCall(env, "/__hub/push/delete", { endpoint });
      log("push_unsubscribed", { by: identity.email });
      return json({ ok: true });
    }
    if (subpath === "/push/test") {
      if (!pushConfigured(env)) throw new HttpError(503, "push_not_configured", "Push alerts are not configured on the Worker (VAPID keys).");
      const endpoint = typeof body.endpoint === "string" && body.endpoint ? body.endpoint : undefined;
      const res = await hubCall(env, "/__hub/push/test", { endpoint });
      log("push_test", { sent: res.sent, failed: res.failed, configured: res.configured, results: res.results, by: identity.email });
      return json({ ok: true, sent: res.sent, failed: res.failed, removed: res.removed, configured: res.configured, results: res.results || [] });
    }
    throw new HttpError(404, "not_found", "Unknown API endpoint.");
  }

  if (subpath === "/events" && method === "GET") {
    if (!isWebSocketUpgrade(request)) throw new HttpError(426, "upgrade_required", "Expected a WebSocket upgrade.");
    assertOrigin(request, env);
    if (!env.HUB) throw new HttpError(503, "events_unavailable", "Live events are not configured.");
    const stub = env.HUB.get(env.HUB.idFromName("hub"));
    return stub.fetch(request);
  }

  if (subpath === "/phrases") {
    if (!env.HUB) throw new HttpError(503, "events_unavailable", "Storage is not configured.");
    const hub = env.HUB.get(env.HUB.idFromName("hub"));
    if (method === "GET") {
      const res = await hub.fetch("https://hub.internal/__hub/phrases");
      return json({ ok: true, ...(await res.json()) });
    }
    if (method === "PUT") {
      assertOrigin(request, env);
      const phrases = validatePhrases((await readJsonBody(request)).phrases);
      await hub.fetch("https://hub.internal/__hub/phrases", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrases }),
      });
      log("quick_phrases_saved", { count: phrases.length, by: identity.email });
      return json({ ok: true, phrases });
    }
    throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  }

  const client = createVapiClient(env);

  if (subpath === "/calls" && method === "GET") {
    const createdAtGt = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const assistantId = String(env.VAPI_ASSISTANT_ID || "").trim() || undefined;
    const calls = await client.listCalls({ createdAtGt, limit: 100, assistantId });
    const active = sortCalls(calls.filter((c) => c?.id && isActive(c) && matchesAssistantFilter(c, env)).map(summarizeCall));
    for (const c of active) {
      if (!seenActiveCalls.has(c.id)) {
        seenActiveCalls.add(c.id);
        log("active_call_detected", { callId: c.id, status: c.status, direction: c.direction, source: "poll" });
      }
    }
    if (seenActiveCalls.size > 500) seenActiveCalls.clear();
    return json({ ok: true, now: Date.now(), calls: active });
  }

  const match = /^\/calls\/([^/]+)(?:\/(say|instruction|mode|control|dtmf|end|listen))?$/.exec(subpath);
  if (!match) throw new HttpError(404, "not_found", "Unknown API endpoint.");
  const callId = assertCallId(match[1]);
  const action = match[2] || null;

  if (!action && method === "GET") {
    const call = await loadCall(client, env, callId);
    const url = new URL(request.url);
    const controllable = call.status === CONTROLLABLE_STATUS && Boolean(call.monitor?.controlUrl);
    let dtmfTool = false;
    let dtmfError = null;
    if (controllable) {
      try {
        dtmfTool = await assistantHasDtmfTool(call, client);
      } catch (error) {
        dtmfError = error.code || "dtmf_check_failed";
      }
    }
    if (url.searchParams.get("select") === "1") log("call_selected", { callId, status: call.status, by: identity.email });
    return json({
      ok: true,
      now: Date.now(),
      call: summarizeCall(call),
      capabilities: {
        control: controllable,
        listen: isActive(call) && Boolean(call.monitor?.listenUrl),
        dtmf: { directSupported: false, viaAssistantTool: dtmfTool, checkError: dtmfError },
      },
    });
  }

  if (action === "listen" && method === "GET") {
    if (!isWebSocketUpgrade(request)) throw new HttpError(426, "upgrade_required", "Expected a WebSocket upgrade.");
    assertOrigin(request, env);
    const call = await loadCall(client, env, callId, { require: "active" });
    const { url, headers } = client.listenRequest(call);
    let upstream;
    try {
      upstream = await fetch(url, { headers });
    } catch (error) {
      log("listen_connect_failed", { callId, reason: error?.name || "network" });
      throw new HttpError(502, "listen_failed", "Could not connect to the Vapi listen stream.");
    }
    if (upstream.status !== 101 || !upstream.webSocket) {
      log("listen_connect_failed", { callId, upstreamStatus: upstream.status });
      throw new HttpError(502, "listen_failed", `Vapi refused the listen stream (HTTP ${upstream.status}).`);
    }
    log("listen_connection_established", { callId, by: identity.email });
    // Returning the upstream WebSocket lets the runtime splice both sockets
    // together natively: no per-frame JavaScript, minimal latency and CPU.
    return upstream;
  }

  if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  assertOrigin(request, env);
  const body = await readJsonBody(request);

  if (action === "say") {
    const text = requireText(body.text, MAX_SAY_CHARS, "Say text");
    const endCallAfterSpoken = body.endCallAfterSpoken === true;
    // Russian (non-Latin) text is translated here first, then spoken
    // verbatim: the caller hears exactly the line shown to the operator, and
    // nothing depends on the call's model agreeing to repeat it.
    const translate = body.translate === true && needsTranslation(text);
    const [call, spoken, unmute] = await Promise.all([
      loadCall(client, env, callId, { require: "controllable" }),
      translate ? translateLine(env, text, body.language) : text,
      beginOperatorLine(env, callId, lineEstimateMs(text.length, { translated: translate })),
    ]);
    const payload = { type: "say", content: spoken, endCallAfterSpoken };
    // In operator mode the line replaces anything the assistant had queued.
    if (body.interruptAssistant === true || unmute) payload.interruptAssistantEnabled = true;
    // A goodbye must not be cut short by the other party talking over it,
    // otherwise the call might never reach the "after spoken" hang-up.
    if (endCallAfterSpoken) payload.interruptionsEnabled = false;
    await speakOperatorLine(client, env, call, unmute, payload, endCallAfterSpoken ? "say_and_hangup_requested" : "say_requested", {
      chars: spoken.length,
      translated: translate,
      interruptAssistant: payload.interruptAssistantEnabled === true,
      by: identity.email,
    });
    return json({ ok: true, callId: call.id, spoken, translated: translate });
  }

  if (action === "instruction") {
    const text = requireText(body.text, MAX_INSTRUCTION_CHARS, "Instruction");
    // triggerResponse false inserts the message silently: used to switch the
    // assistant into or out of operator-controlled mode without making it
    // speak. Anything else should make the model answer straight away.
    const triggerResponseEnabled = body.triggerResponse !== false;
    // line: the model is to speak an operator line (translation fallback), so
    // in operator mode the assistant is unmuted for it like for SAY.
    const line = body.line === true && triggerResponseEnabled;
    const [call, unmute] = await Promise.all([
      loadCall(client, env, callId, { require: "controllable" }),
      line ? beginOperatorLine(env, callId, lineEstimateMs(Math.min(text.length, 200), { viaModel: true })) : false,
    ]);
    const payload = { type: "add-message", message: { role: "system", content: text }, triggerResponseEnabled };
    await speakOperatorLine(client, env, call, unmute, payload, "ai_instruction_requested", {
      chars: text.length,
      trigger: triggerResponseEnabled,
      by: identity.email,
    });
    return json({ ok: true, callId: call.id });
  }

  if (action === "mode") {
    // Operator mode. Vapi has no "hand over to a human" switch, so the model
    // gets a silent system note for this call and (by default) is muted; the
    // hub remembers the mode so every browser and device sees it.
    if (!env.HUB) throw new HttpError(503, "events_unavailable", "Operator mode needs the live event hub.");
    const operator = body.operator === true;
    const mute = body.mute !== false;
    const note = typeof body.text === "string" ? body.text.trim() : "";
    if (note.length > MAX_INSTRUCTION_CHARS) throw new HttpError(400, "text_too_long", "Operator mode text is too long.");
    const call = await loadCall(client, env, callId, { require: "controllable" });
    if (note) {
      const silent = { type: "add-message", message: { role: "system", content: note }, triggerResponseEnabled: false };
      await runControl(client, env, call, silent, "ai_instruction_requested", { chars: note.length, trigger: false, by: identity.email });
    }
    if (mute) await runControl(client, env, call, { type: "control", control: operator ? "mute-assistant" : "unmute-assistant" }, "assistant_control_requested", { control: operator ? "mute-assistant" : "unmute-assistant", by: identity.email });
    await hubCall(env, "/__hub/mode", { callId, operator, mute });
    log("operator_mode_changed", { callId, operator, mute, by: identity.email });
    return json({ ok: true, callId, operator });
  }

  if (action === "control") {
    // Documented Live Call Control actions used by operator mode.
    const allowed = new Set(["mute-assistant", "unmute-assistant"]);
    const control = String(body.action || "");
    if (!allowed.has(control)) throw new HttpError(400, "invalid_control", "Unknown control action.");
    const call = await loadCall(client, env, callId, { require: "controllable" });
    return sendControl(client, env, call, { type: "control", control }, "assistant_control_requested", { control, by: identity.email });
  }

  if (action === "dtmf") {
    const keys = assertDtmfKeys(body.keys);
    const call = await loadCall(client, env, callId, { require: "controllable" });
    if (!(await assistantHasDtmfTool(call, client))) {
      throw new HttpError(
        409,
        "dtmf_unsupported",
        "Vapi's live-control API cannot send operator DTMF, and this call's assistant has no dtmf tool to do it.",
      );
    }
    const payload = { type: "add-message", message: { role: "system", content: dtmfInstruction(keys) }, triggerResponseEnabled: true };
    // Digits can be PINs: only their count is logged.
    return sendControl(client, env, call, payload, "dtmf_requested", { keyCount: keys.replace(/[wW]/g, "").length, by: identity.email });
  }

  if (action === "end") {
    const call = await loadCall(client, env, callId, { require: "active" });
    return sendControl(client, env, call, { type: "end-call" }, "end_call_requested", { status: call.status, by: identity.email });
  }

  throw new HttpError(404, "not_found", "Unknown API endpoint.");
}

const PHRASE_ACTIONS = new Set(["say", "say-and-hang-up"]);

// Quick phrases edited in the console: a short list of labelled lines.
function validatePhrases(input) {
  if (!Array.isArray(input)) throw new HttpError(400, "invalid_phrases", "phrases must be a list.");
  if (input.length > 40) throw new HttpError(400, "invalid_phrases", "At most 40 quick phrases.");
  return input.map((p, i) => {
    const text = typeof p?.text === "string" ? p.text.trim() : "";
    const label = typeof p?.label === "string" ? p.label.trim() : "";
    const action = PHRASE_ACTIONS.has(p?.action) ? p.action : "say";
    if (!text) throw new HttpError(400, "invalid_phrases", `Phrase ${i + 1} has no text.`);
    if (text.length > MAX_SAY_CHARS || label.length > 60) throw new HttpError(400, "invalid_phrases", `Phrase ${i + 1} is too long.`);
    return { label: label || text.slice(0, 40), text, action, confirm: action === "say-and-hang-up" };
  });
}

function errorPage(status, title, message) {
  const safe = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe(
    title,
  )}</title></head><body style="background:#0b0e12;color:#d7dde5;font:15px system-ui,sans-serif;padding:40px"><h1 style="font-size:18px">${safe(
    title,
  )}</h1><p>${safe(message)}</p></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function serveAsset(request, env, path) {
  if (!env.ASSETS) return new Response("Not found", { status: 404 });
  const assetPath = path.slice(PREFIX.length) || "/";
  const url = new URL(request.url);
  url.pathname = assetPath;
  url.search = "";
  const res = await env.ASSETS.fetch(new Request(url.toString(), { method: "GET", headers: request.headers }));
  // Keep asset redirects (e.g. trailing slash) inside the /vapi-control/ prefix.
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("Location");
    if (location) {
      const target = new URL(location, url);
      const headers = new Headers(res.headers);
      headers.set("Location", PREFIX + target.pathname);
      return new Response(null, { status: res.status, headers });
    }
  }
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const isApi = path.startsWith(`${PREFIX}/api/`);

    if (path !== "/" && path !== PREFIX && !path.startsWith(`${PREFIX}/`)) {
      return withSecurityHeaders(new Response("Not found", { status: 404 }));
    }

    if (request.method === "OPTIONS") return preflightResponse(request, env);

    let identity;
    try {
      identity = await authenticate(request, env);
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 500;
      const code = error instanceof AuthError ? error.code : "auth_error";
      const message = error instanceof AuthError ? error.message : "Authentication failed.";
      if (!(error instanceof AuthError)) log("auth_error", { reason: error?.name || "unknown" });
      const response = isApi
        ? apiError(status, code, message)
        : errorPage(status, status === 503 ? "Control panel not configured" : "Not authorized", message);
      return withSecurityHeaders(applyCors(response, request, env));
    }

    if (path === "/" || path === PREFIX) {
      return withSecurityHeaders(new Response(null, { status: 302, headers: { Location: `${PREFIX}/` } }));
    }

    if (isApi) {
      let response;
      try {
        response = await handleApi(request, env, identity, path.slice(`${PREFIX}/api`.length));
      } catch (error) {
        if (error instanceof HttpError) {
          if (error.code?.startsWith("vapi_")) log("vapi_api_error", { code: error.code, vapiStatus: error.details?.vapiStatus, path: url.pathname });
          response = apiError(error.status, error.code, error.message, error.details);
        } else {
          log("internal_error", { path: url.pathname, reason: error?.name || "unknown", message: String(error?.message || "").slice(0, 200) });
          response = apiError(500, "internal_error", "Unexpected server error.");
        }
      }
      return withSecurityHeaders(applyCors(response, request, env));
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return withSecurityHeaders(new Response("Method not allowed", { status: 405 }));
    }
    return withSecurityHeaders(await serveAsset(request, env, path));
  },
};
