// CallHub: a single Durable Object that relays live call events (transcript,
// speech and status) from the Vapi webhook ingress Worker to every connected
// control-panel browser over WebSockets.
//
// - Browsers connect through the main Worker, which authenticates them with
//   Cloudflare Access before forwarding the WebSocket upgrade here.
// - The ingress Worker calls ingest() (RPC) with already-sanitized events.
// - Committed conversation/status state is persisted so a hibernated or
//   restarted object can still send a complete snapshot. Partial transcripts
//   are kept in memory only.
// - Transcripts are deleted one hour after a call ends (alarm-driven).
// - Operator mode ("the human is driving, the assistant is muted") is kept
//   per call here, so every browser and device sees the same mode. While it
//   is on, each operator line unmutes the assistant and the hub mutes it
//   again as soon as Vapi reports that the assistant stopped speaking.
// - The first event of a new call sends a Web Push alert to every subscribed
//   device, so the operator hears about the call with no console tab open.
//
// Internal paths (reached only through the control Worker, which has already
// authenticated the operator; the webhook Worker only uses /__hub/ingest):
//   POST /__hub/ingest     webhook event
//   GET|PUT /__hub/phrases quick phrases
//   POST /__hub/mode       { callId, operator }
//   POST /__hub/line       { callId, estimateMs } -> { operator, mute }
//   POST /__hub/push/put | /push/delete | /push/test, GET /__hub/push

import { DurableObject } from "cloudflare:workers";
import { log } from "./log.js";
import { pushConfigured, sendPush, subscriptionId } from "./push.js";
import { createVapiClient } from "./vapi.js";

const RETAIN_ENDED_MS = 60 * 60 * 1000;
const RETAIN_STALE_MS = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const KEY_PREFIX = "call:";
const PUSH_PREFIX = "push:";
const MAX_PUSH_SUBSCRIPTIONS = 20;
export const INGEST_PATH = "/__hub/ingest";

// Re-mute after an operator line: when the assistant's speech stops, or at
// the latest after the estimate (longer once speech has visibly started).
const REMUTE_AFTER_STOP_MS = 300;
const REMUTE_MAX_MS = 60_000;

function emptyState(callId, at) {
  return {
    callId,
    status: null,
    endedReason: null,
    operator: false,
    operatorMute: false,
    messages: [],
    conversationAt: 0,
    live: [],
    speech: {},
    updatedAt: at,
    endedAt: null,
  };
}

function callAlert(state, event) {
  const direction = event.direction || state.direction;
  const title = direction === "outbound" ? "📞 Outbound call started" : direction === "web" ? "📞 Web call started" : "📞 Incoming call";
  const who = event.customerNumber || state.customerNumber || "Unknown caller";
  return {
    type: "call",
    callId: state.callId,
    title,
    body: `${who} — tap to open the console`,
    tag: state.callId,
    url: `./?call=${state.callId}`,
    ts: Date.now(),
  };
}

export class CallHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.calls = new Map();
    this.remutes = new Map(); // callId -> { timer, started, armedAt, estimateMs }
    this.loaded = false;
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async load() {
    if (this.loaded) return;
    const stored = await this.ctx.storage.list({ prefix: KEY_PREFIX });
    for (const [key, value] of stored) {
      if (!this.calls.has(key.slice(KEY_PREFIX.length))) this.calls.set(key.slice(KEY_PREFIX.length), { operator: false, ...value, live: [], speech: {} });
    }
    this.loaded = true;
  }

  snapshot() {
    return [...this.calls.values()];
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = async () => {
      try {
        return await request.json();
      } catch {
        return null;
      }
    };
    switch (path) {
      case INGEST_PATH:
        if (request.method === "POST") return Response.json(await this.ingest(await body()));
        break;
      case "/__hub/phrases":
        if (request.method === "PUT") {
          const { phrases } = (await body()) || {};
          await this.ctx.storage.put("settings:phrases", phrases);
          return Response.json({ ok: true });
        }
        return Response.json({ phrases: (await this.ctx.storage.get("settings:phrases")) ?? null });
      case "/__hub/mode":
        return Response.json(await this.setMode(await body()));
      case "/__hub/line":
        return Response.json(await this.prepareLine(await body()));
      case "/__hub/push":
        return Response.json({ count: (await this.pushSubscriptions()).length, configured: pushConfigured(this.env) });
      case "/__hub/push/put":
        return Response.json(await this.putSubscription(await body()));
      case "/__hub/push/delete":
        return Response.json(await this.deleteSubscription((await body())?.endpoint));
      case "/__hub/push/test":
        return Response.json(await this.pushAll({ type: "test", title: "Vapi Live Control", body: "Test alert — call alerts work on this device.", tag: "test", ts: Date.now() }, { only: (await body())?.endpoint, ttl: 60 }));
      default:
        break;
    }
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    await this.load();
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "snapshot", now: Date.now(), calls: this.snapshot() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (message === "snapshot") {
      await this.load();
      ws.send(JSON.stringify({ type: "snapshot", now: Date.now(), calls: this.snapshot() }));
    }
  }

  async webSocketClose() {}

  async webSocketError() {}

  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // Socket already gone; the runtime cleans it up.
      }
    }
  }

  async persist(state) {
    const { live, speech, ...durable } = state;
    await this.ctx.storage.put(KEY_PREFIX + state.callId, durable);
  }

  // Applies one sanitized event (see events.js) and broadcasts it.
  async ingest(event) {
    if (!event || typeof event.callId !== "string" || typeof event.kind !== "string") return { ok: false };
    await this.load();
    const at = typeof event.at === "number" ? event.at : Date.now();
    const isNew = !this.calls.has(event.callId);
    const state = this.calls.get(event.callId) || emptyState(event.callId, at);
    this.calls.set(event.callId, state);
    state.updatedAt = Math.max(state.updatedAt || 0, at);
    if (event.customerNumber) state.customerNumber = event.customerNumber;
    if (event.direction) state.direction = event.direction;

    // First sign of a call that is not already over: alert every device.
    // Persisted right away, so an object restarted mid-call does not treat
    // the call as new again and alert twice.
    if (isNew && !(event.kind === "status" && event.status === "ended")) {
      await this.persist(state);
      this.pushAll(callAlert(state, event), { topic: event.callId.replace(/-/g, "") }).catch(() => {});
    }

    switch (event.kind) {
      case "status": {
        const wasEnded = state.status === "ended";
        state.status = event.status;
        if (event.endedReason) state.endedReason = event.endedReason;
        if (event.status === "ended") {
          state.endedAt = state.endedAt || at;
          state.live = [];
          state.speech = {};
          this.clearRemute(event.callId);
          if (!wasEnded) log("call_ended", { callId: event.callId, endedReason: state.endedReason, source: "webhook" });
        } else if (event.status === "in-progress" && !wasEnded) {
          log("active_call_detected", { callId: event.callId, source: "webhook" });
        }
        await this.persist(state);
        this.broadcast({ type: "state", call: state });
        break;
      }
      case "conversation": {
        // Ignore out-of-order older snapshots of the conversation.
        if (at < state.conversationAt) return { ok: true, ignored: true };
        state.messages = Array.isArray(event.messages) ? event.messages : [];
        state.conversationAt = at;
        // Transcript lines older than this commit are now part of `messages`.
        state.live = state.live.filter((l) => l.at > at);
        await this.persist(state);
        this.broadcast({ type: "state", call: state });
        break;
      }
      case "transcript": {
        if (state.status === "ended") return { ok: true, ignored: true };
        const line = { role: event.role, transcriptType: event.transcriptType, text: event.text, at };
        // Keep only the newest partial per role plus uncommitted finals.
        state.live = state.live.filter((l) => !(l.role === line.role && l.transcriptType === "partial"));
        state.live.push(line);
        state.live = state.live.slice(-20);
        this.broadcast({ type: "live", callId: event.callId, ...line });
        break;
      }
      case "speech": {
        if (state.status === "ended") return { ok: true, ignored: true };
        state.speech[event.role] = { status: event.status, at };
        if (event.role === "assistant") this.onAssistantSpeech(event.callId, event.status, at);
        this.broadcast({ type: "speech", callId: event.callId, role: event.role, status: event.status, at });
        break;
      }
      default:
        return { ok: false };
    }

    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    return { ok: true };
  }

  // ---------------------------------------------------------- operator mode --

  async setMode(input) {
    const callId = typeof input?.callId === "string" ? input.callId : "";
    if (!callId) return { ok: false };
    await this.load();
    const state = this.calls.get(callId) || emptyState(callId, Date.now());
    this.calls.set(callId, state);
    state.operator = input.operator === true;
    // Whether operator mode mutes the assistant (config: operatorMode.useMute).
    state.operatorMute = state.operator && input.mute !== false;
    if (!state.operator) this.clearRemute(callId);
    await this.persist(state);
    this.broadcast({ type: "state", call: state });
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    return { ok: true, operator: state.operator };
  }

  // Called just before an operator line is sent. In operator mode the caller
  // (the control Worker) unmutes the assistant for the line, and the hub
  // re-mutes it once the line has been spoken.
  async prepareLine(input) {
    const callId = typeof input?.callId === "string" ? input.callId : "";
    await this.load();
    const state = this.calls.get(callId);
    if (!state?.operator || state.status === "ended") return { operator: false, mute: false };
    if (!state.operatorMute) return { operator: true, mute: false };
    const estimateMs = Math.min(REMUTE_MAX_MS, Math.max(2500, Number(input.estimateMs) || 6000));
    this.clearRemute(callId);
    const entry = { armedAt: Date.now(), started: false, estimateMs, timer: null };
    entry.timer = setTimeout(() => this.remute(callId, "estimate"), estimateMs);
    this.remutes.set(callId, entry);
    return { operator: true, mute: true };
  }

  onAssistantSpeech(callId, status, at) {
    const entry = this.remutes.get(callId);
    // Events from before the line was sent belong to earlier speech.
    if (!entry || at < entry.armedAt) return;
    if (status === "started") {
      entry.started = true;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.remute(callId, "estimate"), Math.min(REMUTE_MAX_MS, entry.estimateMs + 8000));
    } else if (status === "stopped" && entry.started) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.remute(callId, "speech_stopped"), REMUTE_AFTER_STOP_MS);
    }
  }

  clearRemute(callId) {
    const entry = this.remutes.get(callId);
    if (entry) clearTimeout(entry.timer);
    this.remutes.delete(callId);
  }

  async remute(callId, reason) {
    if (!this.remutes.has(callId)) return;
    this.clearRemute(callId);
    const state = this.calls.get(callId);
    if (!state?.operatorMute || state.status === "ended") return;
    try {
      const client = createVapiClient(this.env);
      const call = await client.getCall(callId);
      if (call?.status !== "in-progress") return;
      await client.control(call, { type: "control", control: "mute-assistant" });
      log("assistant_remuted", { callId, reason });
    } catch (error) {
      log("assistant_remute_failed", { callId, reason, code: error?.code || error?.name || "error" });
    }
  }

  // -------------------------------------------------------------- web push --

  async pushSubscriptions() {
    return [...(await this.ctx.storage.list({ prefix: PUSH_PREFIX })).entries()];
  }

  async putSubscription(input) {
    const sub = input?.subscription;
    if (!sub?.endpoint) return { ok: false };
    const key = PUSH_PREFIX + (await subscriptionId(sub.endpoint));
    const existing = await this.pushSubscriptions();
    if (!existing.some(([k]) => k === key) && existing.length >= MAX_PUSH_SUBSCRIPTIONS) {
      // Drop the device that has not re-registered for the longest time.
      existing.sort((a, b) => (a[1].seenAt || 0) - (b[1].seenAt || 0));
      await this.ctx.storage.delete(existing[0][0]);
    }
    const prev = existing.find(([k]) => k === key)?.[1];
    await this.ctx.storage.put(key, {
      subscription: sub,
      label: typeof input.label === "string" ? input.label.slice(0, 80) : "",
      by: typeof input.by === "string" ? input.by.slice(0, 120) : "",
      createdAt: prev?.createdAt || Date.now(),
      seenAt: Date.now(),
    });
    return { ok: true, count: (await this.pushSubscriptions()).length };
  }

  async deleteSubscription(endpoint) {
    if (typeof endpoint !== "string" || !endpoint) return { ok: false };
    await this.ctx.storage.delete(PUSH_PREFIX + (await subscriptionId(endpoint)));
    return { ok: true };
  }

  async pushAll(message, { only, topic, ttl = 120 } = {}) {
    if (!pushConfigured(this.env)) {
      log("push_not_configured", { kind: message.type });
      return { sent: 0, failed: 0, removed: 0, configured: false, results: [] };
    }
    let subs = await this.pushSubscriptions();
    if (only) {
      const key = PUSH_PREFIX + (await subscriptionId(only));
      subs = subs.filter(([k]) => k === key);
    }
    const results = await Promise.all(subs.map(([key, rec]) => sendPush(rec.subscription, message, this.env, { ttl, topic }).then((r) => ({ key, ...r }))));
    let removed = 0;
    for (const r of results) {
      if (r.gone) {
        removed++;
        await this.ctx.storage.delete(r.key);
      }
    }
    const summary = {
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      removed,
      configured: true,
      // What each push service answered (host + HTTP status), for the console's test button.
      results: results.map((r) => ({ host: r.host, status: r.status, error: r.error || null })),
    };
    log("push_sent", {
      kind: message.type,
      callId: message.callId || null,
      ...summary,
      // Push endpoints are capability URLs: only the service host is logged.
      errors: results.filter((r) => !r.ok).map((r) => `${r.host}:${r.status || r.error}`).slice(0, 5),
    });
    return summary;
  }

  async alarm() {
    await this.load();
    const now = Date.now();
    for (const [callId, state] of this.calls) {
      const expired =
        (state.status === "ended" && now - (state.endedAt || state.updatedAt) > RETAIN_ENDED_MS) ||
        now - (state.updatedAt || 0) > RETAIN_STALE_MS;
      if (expired) {
        this.calls.delete(callId);
        this.clearRemute(callId);
        await this.ctx.storage.delete(KEY_PREFIX + callId);
        this.broadcast({ type: "removed", callId });
      }
    }
    if (this.calls.size > 0) await this.ctx.storage.setAlarm(now + CLEANUP_INTERVAL_MS);
  }
}
