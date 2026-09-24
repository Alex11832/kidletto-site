import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeServerMessage, sanitizeConversation } from "../../src/events.js";
import {
  assertCallId,
  assertDtmfKeys,
  assistantHasDtmfTool,
  isActive,
  matchesAssistantFilter,
  summarizeCall,
} from "../../src/calls.js";
import { assertMonitorUrl, createVapiClient, mapVapiStatus } from "../../src/vapi.js";
import { assertOrigin, corsHeadersFor, preflightResponse } from "../../src/http.js";
import { redact, scrubString } from "../../src/log.js";

const CALL_ID = "7420f27a-30fd-4f49-a995-5549ae7cc00d";
const SECRET_KEY = "sk-live-THIS-MUST-NEVER-LEAK-1234567890";
const call = {
  id: CALL_ID,
  type: "inboundPhoneCall",
  status: "in-progress",
  startedAt: "2026-09-23T10:00:00.000Z",
  createdAt: "2026-09-23T09:59:58.000Z",
  assistantId: "5b0a4a08-133c-4146-9315-0984f8c6be80",
  customer: { number: "+15551234567" },
  monitor: {
    listenUrl: `wss://aws-us-west-2-production1-phone-call-websocket.vapi.ai/${CALL_ID}/transport`,
    controlUrl: `https://aws-us-west-2-production1-phone-call-websocket.vapi.ai/${CALL_ID}/control`,
  },
  assistant: { model: { messages: [{ role: "system", content: "secret prompt" }] } },
  costs: [{ cost: 1 }],
};

// ---------------------------------------------------------------- events ---

test("webhook events are sanitized: no monitor URLs, prompts or customer data", () => {
  const body = {
    message: {
      type: "conversation-update",
      timestamp: 1000,
      call,
      messages: [
        { role: "system", message: "You are a secret system prompt", time: 1 },
        { role: "bot", message: "Hello, how can I help?", time: 2, secondsFromStart: 0.5 },
        { role: "user", message: "How many TVs?", time: 3 },
        { role: "tool_calls", toolCalls: [{ function: { name: "dtmf", arguments: '{"keys":"1"}' } }], time: 4 },
        { role: "tool_call_result", result: "ok", time: 5 },
        { role: "system", message: "Operator: ask about the total", time: 6 },
      ],
    },
  };
  const event = sanitizeServerMessage(body);
  const text = JSON.stringify(event);
  assert.equal(event.kind, "conversation");
  assert.equal(event.callId, CALL_ID);
  assert.ok(!text.includes("vapi.ai"));
  assert.ok(!text.includes("secret system prompt"));
  assert.ok(!text.includes("+15551234567"));
  assert.deepEqual(
    event.messages.map((m) => m.role),
    ["assistant", "user", "tool", "system"],
  );
  assert.equal(event.messages[2].text, 'dtmf({"keys":"1"})');
});

test("status, transcript and speech events", () => {
  assert.deepEqual(sanitizeServerMessage({ message: { type: "status-update", status: "ended", endedReason: "customer-ended-call", call, timestamp: 5 } }), {
    callId: CALL_ID,
    at: 5,
    kind: "status",
    status: "ended",
    endedReason: "customer-ended-call",
  });
  const partial = sanitizeServerMessage({ message: { type: "transcript", role: "user", transcriptType: "partial", transcript: "How ma", call, timestamp: 6 } });
  assert.equal(partial.transcriptType, "partial");
  const final = sanitizeServerMessage({ message: { type: 'transcript[transcriptType="final"]', role: "assistant", transcript: "One.", call, timestamp: 7 } });
  assert.equal(final.transcriptType, "final");
  assert.equal(final.role, "assistant");
  assert.equal(sanitizeServerMessage({ message: { type: "speech-update", role: "assistant", status: "started", call } }).kind, "speech");
  assert.equal(sanitizeServerMessage({ message: { type: "end-of-call-report", endedReason: "assistant-ended-call", call } }).status, "ended");
});

test("unknown or malformed events are dropped", () => {
  assert.equal(sanitizeServerMessage({ message: { type: "tool-calls", call } }), null);
  assert.equal(sanitizeServerMessage({ message: { type: "status-update", status: "ended", call: { id: "not-a-uuid" } } }), null);
  assert.equal(sanitizeServerMessage(null), null);
  assert.deepEqual(sanitizeConversation("nope"), []);
});

// ----------------------------------------------------------------- calls ---

test("call summary never contains monitor URLs, prompts or costs", () => {
  const summary = summarizeCall(call);
  const text = JSON.stringify(summary);
  assert.ok(!text.includes("vapi.ai"));
  assert.ok(!text.includes("secret prompt"));
  assert.ok(!("costs" in summary));
  assert.equal(summary.direction, "inbound");
  assert.equal(summary.customerNumber, "+15551234567");
  assert.equal(summary.listenAvailable, true);
  assert.equal(summary.controlAvailable, true);
});

test("active statuses and assistant filter", () => {
  for (const status of ["queued", "ringing", "in-progress", "forwarding"]) assert.equal(isActive({ status }), true);
  for (const status of ["ended", "scheduled", "not-found", undefined]) assert.equal(isActive({ status }), false);
  assert.equal(matchesAssistantFilter(call, {}), true);
  assert.equal(matchesAssistantFilter(call, { VAPI_ASSISTANT_ID: call.assistantId }), true);
  assert.equal(matchesAssistantFilter(call, { VAPI_ASSISTANT_ID: "00000000-0000-0000-0000-000000000000" }), false);
});

test("call IDs and DTMF keys are validated", () => {
  assert.equal(assertCallId(CALL_ID.toUpperCase()), CALL_ID);
  assert.throws(() => assertCallId("../../assistant"), { code: "invalid_call_id" });
  assert.equal(assertDtmfKeys("1234#"), "1234#");
  assert.equal(assertDtmfKeys("1w2W*#"), "1w2W*#");
  for (const bad of ["", "abc", "1;2", "w", "1".repeat(41)]) assert.throws(() => assertDtmfKeys(bad), { code: "invalid_dtmf" });
});

test("DTMF capability is detected only when the assistant has the dtmf tool", async () => {
  const clientWith = (tools) => ({
    getAssistant: async () => ({ model: { toolIds: Object.keys(tools) } }),
    getTool: async (id) => tools[id],
  });
  assert.equal(await assistantHasDtmfTool({ ...call, assistantId: "a1" }, clientWith({ t1: { type: "endCall" } })), false);
  assert.equal(await assistantHasDtmfTool({ ...call, assistantId: "a2" }, clientWith({ t1: { type: "endCall" }, t2: { type: "dtmf" } })), true);
  assert.equal(await assistantHasDtmfTool({ ...call, assistantId: null, assistant: { model: { tools: [{ type: "dtmf" }] } } }, clientWith({})), true);
});

// ------------------------------------------------------------------ vapi ---

test("monitor URLs must be on vapi.ai", () => {
  assert.ok(assertMonitorUrl(call.monitor.controlUrl, {}, "control"));
  assert.throws(() => assertMonitorUrl("https://evil.example.com/control", {}, "control"), { code: "unexpected_monitor_url" });
  assert.throws(() => assertMonitorUrl("http://phone.vapi.ai/control", {}, "control"), { code: "unexpected_monitor_url" });
  assert.throws(() => assertMonitorUrl("https://vapi.ai.evil.com/x", {}, "control"), { code: "unexpected_monitor_url" });
  assert.throws(() => assertMonitorUrl(undefined, {}, "listen"), { code: "listen_unavailable" });
  // localhost only when the API base itself is a local mock
  assert.throws(() => assertMonitorUrl("http://127.0.0.1:9/control", {}, "control"), { code: "unexpected_monitor_url" });
  assert.ok(assertMonitorUrl("http://127.0.0.1:9/control", { VAPI_API_BASE_URL: "http://127.0.0.1:9" }, "control"));
});

test("Vapi errors map to clear codes without echoing credentials", () => {
  const e401 = mapVapiStatus(401, JSON.stringify({ message: "Invalid Key. Hot tip, you may be using the private key instead of the public key." }));
  assert.equal(e401.code, "vapi_auth_failed");
  assert.equal(mapVapiStatus(404, "").code, "not_found");
  assert.equal(mapVapiStatus(429, "").code, "vapi_rate_limited");
  assert.equal(mapVapiStatus(503, "").code, "vapi_unavailable");
});

test("private key goes only to the Vapi API host; control URL gets no private key", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), auth: new Headers(init.headers).get("Authorization") });
    return new Response(JSON.stringify(String(url).includes("/call/") ? call : []), { status: 200 });
  };
  const client = createVapiClient({ VAPI_API_KEY: SECRET_KEY }, { fetchImpl });
  await client.getCall(CALL_ID);
  await client.control(call, { type: "say", content: "hi" });
  assert.equal(seen[0].url, `https://api.vapi.ai/call/${CALL_ID}`);
  assert.equal(seen[0].auth, `Bearer ${SECRET_KEY}`);
  assert.equal(seen[1].url, call.monitor.controlUrl);
  assert.equal(seen[1].auth, null);
  const listen = client.listenRequest(call);
  assert.ok(listen.url.startsWith("https://aws-us-west-2-production1-phone-call-websocket.vapi.ai/"));
  assert.equal(listen.headers.Authorization, undefined);
});

test("VAPI_PUBLIC_KEY (monitor authentication) is used for monitor URLs only", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push(new Headers(init.headers).get("Authorization"));
    return new Response("{}", { status: 200 });
  };
  const client = createVapiClient({ VAPI_API_KEY: SECRET_KEY, VAPI_PUBLIC_KEY: "pub-key" }, { fetchImpl });
  await client.control(call, { type: "end-call" });
  assert.equal(seen[0], "Bearer pub-key");
  assert.equal(client.listenRequest(call).headers.Authorization, "Bearer pub-key");
});

test("missing VAPI_API_KEY fails with a configuration error", () => {
  assert.throws(() => createVapiClient({}), { code: "vapi_not_configured", status: 503 });
});

// ------------------------------------------------------------------ http ---

test("origin checks and CORS: only same-origin and ALLOWED_ORIGINS, never wildcard", () => {
  const env = { ALLOWED_ORIGINS: "https://kidletto.com" };
  const mk = (origin) => new Request("https://kidletto-vapi-control.x.workers.dev/vapi-control/api/calls", { method: "POST", headers: origin ? { Origin: origin } : {} });
  assert.doesNotThrow(() => assertOrigin(mk("https://kidletto-vapi-control.x.workers.dev"), env));
  assert.doesNotThrow(() => assertOrigin(mk("https://kidletto.com"), env));
  assert.throws(() => assertOrigin(mk("https://evil.example"), env), { code: "bad_origin" });
  assert.throws(() => assertOrigin(mk(null), env), { code: "bad_origin" });
  assert.equal(corsHeadersFor(mk("https://evil.example"), env), null);
  assert.equal(corsHeadersFor(mk("https://kidletto.com"), env)["Access-Control-Allow-Origin"], "https://kidletto.com");
  assert.equal(preflightResponse(mk("https://evil.example"), env).status, 403);
  const ok = preflightResponse(mk("https://kidletto.com"), env);
  assert.equal(ok.status, 204);
  assert.notEqual(ok.headers.get("Access-Control-Allow-Origin"), "*");
});

// ------------------------------------------------------------------- log ---

test("log redaction removes keys, bearer tokens, JWTs and monitor URLs", () => {
  const out = JSON.stringify(
    redact({
      VAPI_API_KEY: SECRET_KEY,
      headers: { Authorization: `Bearer ${SECRET_KEY}` },
      note: `sent Bearer ${SECRET_KEY} to ${call.monitor.controlUrl}`,
      jwt: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl",
      callId: CALL_ID,
    }),
  );
  assert.ok(!out.includes(SECRET_KEY));
  assert.ok(!out.includes("vapi.ai"));
  assert.ok(!out.includes("eyJhbGciOiJSUzI1NiJ9"));
  assert.ok(out.includes(CALL_ID));
  assert.ok(!scrubString("x eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl").includes("eyJ"));
});
