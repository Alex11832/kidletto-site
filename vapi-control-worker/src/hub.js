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

import { DurableObject } from "cloudflare:workers";
import { log } from "./log.js";

const RETAIN_ENDED_MS = 60 * 60 * 1000;
const RETAIN_STALE_MS = 6 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const KEY_PREFIX = "call:";
export const INGEST_PATH = "/__hub/ingest";

function emptyState(callId, at) {
  return {
    callId,
    status: null,
    endedReason: null,
    messages: [],
    conversationAt: 0,
    live: [],
    speech: {},
    updatedAt: at,
    endedAt: null,
  };
}

export class CallHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.calls = new Map();
    this.loaded = false;
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async load() {
    if (this.loaded) return;
    const stored = await this.ctx.storage.list({ prefix: KEY_PREFIX });
    for (const [key, value] of stored) {
      if (!this.calls.has(key.slice(KEY_PREFIX.length))) this.calls.set(key.slice(KEY_PREFIX.length), { ...value, live: [], speech: {} });
    }
    this.loaded = true;
  }

  snapshot() {
    return [...this.calls.values()];
  }

  async fetch(request) {
    // Internal ingest call from the webhook Worker (via its DO binding; not
    // reachable from browsers: the control Worker only forwards GET upgrades
    // of /vapi-control/api/events here).
    if (request.method === "POST" && new URL(request.url).pathname === INGEST_PATH) {
      let event = null;
      try {
        event = await request.json();
      } catch {
        event = null;
      }
      return Response.json(await this.ingest(event));
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
    const state = this.calls.get(event.callId) || emptyState(event.callId, at);
    this.calls.set(event.callId, state);
    state.updatedAt = Math.max(state.updatedAt || 0, at);

    switch (event.kind) {
      case "status": {
        const wasEnded = state.status === "ended";
        state.status = event.status;
        if (event.endedReason) state.endedReason = event.endedReason;
        if (event.status === "ended") {
          state.endedAt = state.endedAt || at;
          state.live = [];
          state.speech = {};
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

  async alarm() {
    await this.load();
    const now = Date.now();
    for (const [callId, state] of this.calls) {
      const expired =
        (state.status === "ended" && now - (state.endedAt || state.updatedAt) > RETAIN_ENDED_MS) ||
        now - (state.updatedAt || 0) > RETAIN_STALE_MS;
      if (expired) {
        this.calls.delete(callId);
        await this.ctx.storage.delete(KEY_PREFIX + callId);
        this.broadcast({ type: "removed", callId });
      }
    }
    if (this.calls.size > 0) await this.ctx.storage.setAlarm(now + CLEANUP_INTERVAL_MS);
  }
}
