// End-to-end tests of both Workers running locally in workerd (wrangler dev)
// against a mock Vapi server and a test Cloudflare Access identity provider.
// Every privileged request goes through real Access-JWT validation.
//
//   node test/integration/run.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { createTestIdp } from "../helpers/jwt.mjs";
import { startWorkers, stopWorker, WORKER_DIR } from "../helpers/devserver.mjs";
import { startMockVapi } from "./mock-vapi.mjs";
import { fakeSubscription, verifyVapid, vapidKeys } from "../helpers/webpush.mjs";

const FAKE_VAPI_KEY = "test-vapi-private-key-0d3f9c1e-NEVER-LEAK";
const FAKE_WEBHOOK_SECRET = "test-webhook-secret-7b2a41-NEVER-LEAK";
const AUD = "c".repeat(64);
const OPERATOR = "operator@example.com";
const ASSISTANT_A = "11111111-1111-4111-8111-111111111111";
const ASSISTANT_B = "22222222-2222-4222-8222-222222222222";
const CALL_1 = "aaaaaaaa-0000-4000-8000-000000000001";
const CALL_2 = "aaaaaaaa-0000-4000-8000-000000000002";
const CALL_OTHER = "bbbbbbbb-0000-4000-8000-000000000003";
const CALL_DTMF = "aaaaaaaa-0000-4000-8000-000000000004";
const PORT = 8797;
const VAPID = vapidKeys();

const results = [];
const bodies = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.stack || error) });
    console.log(`  FAIL  ${name}\n        ${String(error?.message || error).split("\n").join("\n        ")}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 5000, interval = 50, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const idp = await createTestIdp();
const mock = await startMockVapi({ apiKey: FAKE_VAPI_KEY, jwks: idp.jwks });
const TEAM = mock.base;
// Both Workers run in one local process behind a test router (same port).
const MAIN = `http://127.0.0.1:${PORT}`;
const HOOK = MAIN;
const tokenFor = (opts = {}) => idp.sign(idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: OPERATOR, ...opts }));
const TOKEN = await tokenFor();

mock.state.assistants.set(ASSISTANT_A, { id: ASSISTANT_A, model: { toolIds: ["tool-end"] } });
mock.state.assistants.set(ASSISTANT_B, { id: ASSISTANT_B, model: { toolIds: ["tool-end"] } });
mock.state.tools.set("tool-end", { id: "tool-end", type: "endCall" });
mock.state.tools.set("tool-dtmf", { id: "tool-dtmf", type: "dtmf" });

async function api(pathname, { method = "GET", body, token = TOKEN, origin = MAIN, headers = {} } = {}) {
  const res = await fetch(`${MAIN}/vapi-control/api/${pathname}`, {
    method,
    redirect: "manual",
    headers: {
      ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  bodies.push(text, JSON.stringify([...res.headers]));
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { res, status: res.status, json, text };
}

function openWs(url, { token = TOKEN, origin = MAIN } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}), ...(origin ? { Origin: origin } : {}) } });
    const messages = [];
    let binaryFrames = 0;
    let binaryBytes = 0;
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        binaryFrames++;
        binaryBytes += data.length;
      } else messages.push(data.toString());
    });
    const handle = { ws, messages, get binaryFrames() { return binaryFrames; }, get binaryBytes() { return binaryBytes; }, closed: null };
    ws.on("close", (code) => (handle.closed = code));
    ws.on("open", () => resolve({ ...handle, opened: true, handle }));
    ws.on("unexpected-response", (_req, res) => resolve({ opened: false, status: res.statusCode, handle }));
    ws.on("error", () => resolve({ opened: false, status: 0, handle }));
  });
}

async function webhook(message, { secret = FAKE_WEBHOOK_SECRET, headerName = "Authorization" } = {}) {
  const res = await fetch(`${HOOK}/vapi/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { [headerName]: headerName === "Authorization" ? `Bearer ${secret}` : secret } : {}), "X-Vapi-Signature": "sig-123" },
    body: JSON.stringify({ message }),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, text };
}

let main;
let hook;
console.log("Starting local Workers (wrangler dev)…");
try {
  main = await startWorkers({
    port: PORT,
    inspectorPort: 9341,
    stateDir: path.join(WORKER_DIR, ".wrangler", "test-integration"),
    secrets: { VAPI_API_KEY: FAKE_VAPI_KEY, VAPI_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET, VAPID_PRIVATE_KEY: VAPID.privateKey },
    mainVars: {
      VAPI_API_BASE_URL: mock.base,
      AI_TEST_BASE_URL: mock.base,
      VAPID_PUBLIC_KEY: VAPID.publicKey,
      VAPI_ASSISTANT_ID: ASSISTANT_A,
      TEAM_DOMAIN: TEAM,
      POLICY_AUD: AUD,
      ALLOWED_EMAILS: OPERATOR,
      ALLOWED_ORIGINS: "https://kidletto.com",
    },
    webhookVars: { WEBHOOK_FORWARD_URL: `${mock.base}/forward-target` },
  });
  hook = main; // same process, shared log
} catch (error) {
  console.error(String(error));
  await mock.close();
  process.exit(1);
}

console.log("Running checks…");

// ----------------------------------------------------------- 1-4 startup ---
await check("1. frontend is served at /vapi-control/ (and / redirects there)", async () => {
  const res = await fetch(`${MAIN}/vapi-control/`, { headers: { "Cf-Access-Jwt-Assertion": TOKEN } });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(html, /VAPI LIVE CONTROL/);
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  // The microphone is allowed for the console itself only (dictation).
  assert.match(res.headers.get("permissions-policy"), /(^|, )microphone=\(self\)/);
  assert.match(res.headers.get("permissions-policy"), /camera=\(\)/);
  assert.match(html, /rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials"/);
  for (const p of ["/", "/vapi-control"]) {
    const r = await fetch(`${MAIN}${p}`, { redirect: "manual", headers: { "Cf-Access-Jwt-Assertion": TOKEN } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/vapi-control/");
  }
  // Installable app: manifest, service worker and icons are served (behind Access like everything else).
  const manifest = await fetch(`${MAIN}/vapi-control/manifest.webmanifest`, { headers: { "Cf-Access-Jwt-Assertion": TOKEN } });
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get("content-type"), /manifest\+json|application\/json/);
  const m = await manifest.json();
  assert.equal(m.display, "standalone");
  assert.ok(m.icons.some((i) => i.sizes === "192x192") && m.icons.some((i) => i.sizes === "512x512") && m.icons.some((i) => i.purpose === "maskable"));
  const sw = await fetch(`${MAIN}/vapi-control/sw.js`, { headers: { "Cf-Access-Jwt-Assertion": TOKEN } });
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get("content-type"), /javascript/);
  await sw.text();
  for (const icon of [...m.icons.map((i) => i.src), "icons/apple-touch-icon.png", "icons/badge-96.png"]) {
    const r = await fetch(`${MAIN}/vapi-control/${icon}`, { headers: { "Cf-Access-Jwt-Assertion": TOKEN } });
    assert.equal(r.status, 200, icon);
    await r.arrayBuffer();
  }
  assert.equal((await fetch(`${MAIN}/vapi-control/sw.js`)).status, 401, "service worker is not public");
  for (const asset of ["config.js", "css/app.css", "js/app.js", "js/audio.js", "js/api.js", "js/transcript.js", "js/events.js", "js/format.js", "js/dictation.js", "js/push.js", "sw.js"]) {
    const r = await fetch(`${MAIN}/vapi-control/${asset}`, { headers: { "Cf-Access-Jwt-Assertion": TOKEN } });
    assert.equal(r.status, 200, asset);
    bodies.push(await r.text());
  }
});

await check("2. frontend (served and on disk) contains no Vapi key or secret", async () => {
  const served = bodies.join("\n");
  assert.ok(!served.includes(FAKE_VAPI_KEY));
  const dir = path.resolve(WORKER_DIR, "../vapi-control");
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const file of walk(dir)) {
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!/VAPI_API_KEY|VAPI_WEBHOOK_SECRET|Bearer\s+[A-Za-z0-9]/.test(text), `${file} mentions a secret`);
    assert.ok(!/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text), `${file} contains a hardcoded UUID`);
  }
});

await check("3. both Workers start in the local Workers runtime", async () => {
  assert.ok(main.logs.some((l) => /Ready on/.test(l)));
  // console Worker answers (Access-protected) and the webhook Worker answers (method check)
  assert.equal((await fetch(`${MAIN}/vapi-control/api/session`)).status, 401);
  assert.equal((await fetch(`${HOOK}/vapi/events`)).status, 405);
});

await check("4. Worker reads its environment (Access vars, Vapi key, assistant filter, origins)", async () => {
  const { status, json } = await api("session");
  assert.equal(status, 200);
  assert.equal(json.user.email, OPERATOR);
  assert.equal(json.vapiConfigured, true);
  assert.equal(json.assistantFilter, true);
  assert.equal(json.eventsAvailable, true);
  assert.equal(json.dictation, true);
  assert.equal(json.translation, true);
  assert.equal(json.push.publicKey, VAPID.publicKey);
  await api("calls");
  assert.equal(mock.state.listRequests.at(-1).assistantId, ASSISTANT_A);
});

// ------------------------------------------------------------ 5-7 auth ---
await check("5. unauthorized requests are rejected and never reach Vapi", async () => {
  mock.reset();
  mock.makeCall({ id: CALL_1, assistantId: ASSISTANT_A });
  const cases = [
    ["no token", null, 401],
    ["garbage token", "not.a.jwt", 401],
    ["wrong audience", await tokenFor({ aud: "d".repeat(64) }), 403],
    ["expired", await tokenFor({ ttlS: -3600 }), 401],
    ["not allowlisted email", await tokenFor({ email: "intruder@example.com" }), 403],
    ["wrong issuer", await idp.sign(idp.claimsFor({ teamDomain: "https://evil.cloudflareaccess.com", aud: AUD, email: OPERATOR })), 401],
  ];
  for (const [label, token, expected] of cases) {
    for (const [p, method, body] of [
      ["calls", "GET"],
      [`calls/${CALL_1}/say`, "POST", { text: "hacked" }],
      [`calls/${CALL_1}/end`, "POST", {}],
      [`calls/${CALL_1}/dtmf`, "POST", { keys: "1" }],
      [`calls/${CALL_1}/instruction`, "POST", { text: "x" }],
      [`calls/${CALL_1}/mode`, "POST", { operator: true, text: "x" }],
      ["push/subscribe", "POST", { subscription: {} }],
      ["push/test", "POST", {}],
    ]) {
      const r = await api(p, { method, body, token });
      assert.equal(r.status, expected, `${label} ${method} ${p}`);
      assert.equal(r.json?.ok, false);
    }
    const audio = await fetch(`${MAIN}/vapi-control/api/transcribe`, {
      method: "POST",
      headers: { ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}), Origin: MAIN, "Content-Type": "audio/webm" },
      body: Buffer.alloc(2000, 1),
    });
    assert.equal(audio.status, expected, `${label} transcribe`);
    await audio.text();
    const page = await fetch(`${MAIN}/vapi-control/`, { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });
    assert.equal(page.status, expected, `${label} page`);
    const ws = await openWs(`${MAIN.replace("http", "ws")}/vapi-control/api/calls/${CALL_1}/listen`, { token });
    assert.equal(ws.opened, false, `${label} listen ws`);
  }
  assert.equal(mock.state.controls.length, 0, "no control command may reach Vapi");
  assert.equal(mock.state.listenConnections.length, 0, "no listen connection may reach Vapi");
  assert.equal(mock.state.aiRequests.length, 0, "no AI request without a valid identity");
});

await check("6. authorized requests are accepted", async () => {
  const r = await api("calls");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

await check("7. CORS allows only https://kidletto.com (no wildcard); foreign origins cannot send commands", async () => {
  const pre = async (origin) =>
    fetch(`${MAIN}/vapi-control/api/calls`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
  const bad = await pre("https://evil.example");
  assert.equal(bad.status, 403);
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const good = await pre("https://kidletto.com");
  assert.equal(good.status, 204);
  assert.equal(good.headers.get("access-control-allow-origin"), "https://kidletto.com");
  const get = await api("calls", { origin: "https://evil.example" });
  assert.equal(get.res.headers.get("access-control-allow-origin"), null);
  const post = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "csrf" }, origin: "https://evil.example" });
  assert.equal(post.status, 403);
  assert.equal(post.json.error.code, "bad_origin");
  const noOrigin = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "csrf" }, origin: null });
  assert.equal(noOrigin.status, 403);
  const ws = await openWs(`${MAIN.replace("http", "ws")}/vapi-control/api/calls/${CALL_1}/listen`, { origin: "https://evil.example" });
  assert.equal(ws.opened, false);
  assert.equal(mock.state.controls.length, 0);
});

// ----------------------------------------------------- 8-12 call list ---
await check("8. no active call -> empty list", async () => {
  mock.reset();
  mock.makeCall({ id: CALL_1, assistantId: ASSISTANT_A, status: "ended" });
  const r = await api("calls");
  assert.deepEqual(r.json.calls, []);
});

await check("9. one active call is detected, sanitized, with real startedAt", async () => {
  mock.reset();
  const c = mock.makeCall({ id: CALL_1, assistantId: ASSISTANT_A, startedAgoMs: 125_000 });
  const r = await api("calls");
  assert.equal(r.json.calls.length, 1);
  const s = r.json.calls[0];
  assert.equal(s.id, CALL_1);
  assert.equal(s.direction, "inbound");
  assert.equal(s.customerNumber, "+15550001111");
  assert.equal(s.startedAt, c.startedAt);
  assert.ok(!r.text.includes("/control/") && !r.text.includes("/listen/"), "monitor URLs must not reach the browser");
  assert.ok(!r.text.includes("TOP SECRET PROMPT"));
  assert.ok(Math.abs(r.json.now - Date.now()) < 5000);
});

await check("10. multiple active calls are all listed; other assistants' calls are hidden", async () => {
  mock.makeCall({ id: CALL_2, assistantId: ASSISTANT_A, status: "ringing", type: "outboundPhoneCall" });
  mock.makeCall({ id: CALL_OTHER, assistantId: ASSISTANT_B });
  const r = await api("calls");
  assert.deepEqual(r.json.calls.map((c) => c.id).sort(), [CALL_1, CALL_2].sort());
  assert.equal(r.json.calls.find((c) => c.id === CALL_2).direction, "outbound");
});

await check("11. commands target exactly the requested call; wrong/ended/foreign calls are refused", async () => {
  mock.state.controls.length = 0;
  let r = await api(`calls/${CALL_2}/say`, { method: "POST", body: { text: "hi" } });
  assert.equal(r.status, 409, "ringing call is not controllable");
  assert.equal(r.json.error.code, "call_not_in_progress");
  r = await api(`calls/${CALL_OTHER}/say`, { method: "POST", body: { text: "hi" } });
  assert.equal(r.status, 404, "calls of other assistants are invisible");
  r = await api(`calls/not-a-call/say`, { method: "POST", body: { text: "hi" } });
  assert.equal(r.status, 400);
  r = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "hello one" } });
  assert.equal(r.status, 200);
  assert.equal(mock.state.controls.length, 1);
  assert.equal(mock.state.controls[0].callId, CALL_1);
  r = await api(`calls/${CALL_1}`, { });
  assert.equal(r.json.call.id, CALL_1);
  assert.equal(r.json.capabilities.control, true);
});

await check("12. call detail exposes the real start time for the timer", async () => {
  const r = await api(`calls/${CALL_1}?select=1`);
  assert.equal(r.json.call.startedAt, mock.state.calls.get(CALL_1).startedAt);
  assert.ok(main.logs.some((l) => l.includes('"evt":"call_selected"') && l.includes(CALL_1)));
});

// ---------------------------------------------------- commands 18-24 ---
await check("18. EXACT SAY sends the exact text verbatim (unicode preserved)", async () => {
  mock.state.controls.length = 0;
  const text = "I have a few other offers. I'll think about it. — $120, “quotes”, ёжик";
  const r = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text } });
  assert.equal(r.status, 200);
  assert.deepEqual(mock.state.controls[0].payload, { type: "say", content: text, endCallAfterSpoken: false });
  assert.equal(mock.state.controls[0].authorization, null, "private key must not be sent to the control URL");
  const r2 = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "Now", interruptAssistant: true } });
  assert.equal(r2.status, 200);
  assert.deepEqual(mock.state.controls[1].payload, { type: "say", content: "Now", endCallAfterSpoken: false, interruptAssistantEnabled: true });
  const empty = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "   " } });
  assert.equal(empty.status, 400);
});

await check("19. AI INSTRUCTION is an add-message for this call only (assistant untouched)", async () => {
  mock.state.controls.length = 0;
  const text = "Скажи ему, что цена слишком высокая и мне надо подумать.";
  const r = await api(`calls/${CALL_1}/instruction`, { method: "POST", body: { text } });
  assert.equal(r.status, 200);
  assert.deepEqual(mock.state.controls[0], {
    callId: CALL_1,
    payload: { type: "add-message", message: { role: "system", content: text }, triggerResponseEnabled: true },
    authorization: null,
  });
  assert.equal(mock.state.nonGetAssistantRequests, 0, "the assistant configuration must never be modified");
  // Operator mode inserts the instruction silently (no reply triggered).
  const silent = await api(`calls/${CALL_1}/instruction`, { method: "POST", body: { text: "stay silent", triggerResponse: false } });
  assert.equal(silent.status, 200);
  assert.equal(mock.state.controls.at(-1).payload.triggerResponseEnabled, false);
  // mute / unmute go through the documented control message; nothing else is allowed.
  for (const action of ["mute-assistant", "unmute-assistant"]) {
    const r = await api(`calls/${CALL_1}/control`, { method: "POST", body: { action } });
    assert.equal(r.status, 200);
    assert.deepEqual(mock.state.controls.at(-1).payload, { type: "control", control: action });
  }
  const bad = await api(`calls/${CALL_1}/control`, { method: "POST", body: { action: "say-first-message" } });
  assert.equal(bad.status, 400);
});

// ------------------------------------------ dictation, translation, mode ---
await check("dictation: the operator's recording is transcribed (Nova-3, then Whisper); the words are never logged", async () => {
  const transcribe = (body, { type = "audio/webm;codecs=opus", origin = MAIN, lang = "ru" } = {}) =>
    fetch(`${MAIN}/vapi-control/api/transcribe?lang=${lang}`, {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": TOKEN, Origin: origin, "Content-Type": type },
      body,
    });
  mock.state.aiRequests.length = 0;
  mock.state.ai.transcript = "Скажи ему, что сто двадцать это дорого";
  let res = await transcribe(Buffer.alloc(4000, 7));
  let json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.text, "Скажи ему, что сто двадцать это дорого");
  const stt = mock.state.aiRequests[0];
  assert.equal(stt.model, "@cf/deepgram/nova-3");
  assert.equal(stt.input.language, "ru");
  assert.equal(stt.input.audio.contentType, "audio/webm");
  assert.equal(Buffer.from(stt.input.audio.body, "base64").length, 4000, "audio reaches the model intact");
  // Nova-3 hears nothing -> Whisper takes over.
  mock.state.ai.transcript = "";
  mock.state.ai.whisperText = "Алло, слышно?";
  res = await transcribe(Buffer.alloc(4000, 7), { type: "audio/mp4" });
  json = await res.json();
  assert.equal(json.text, "Алло, слышно?");
  assert.deepEqual(mock.state.aiRequests.slice(1).map((r) => r.model), ["@cf/deepgram/nova-3", "@cf/openai/whisper-large-v3-turbo"]);
  mock.state.ai.transcript = "Скажи, что я подумаю";
  assert.equal((await transcribe("hello", { type: "text/plain" })).status, 415);
  assert.equal((await transcribe(Buffer.alloc(10))).status, 400);
  assert.equal((await transcribe(Buffer.alloc(4000), { origin: "https://evil.example" })).status, 403);
  assert.equal((await transcribe(Buffer.alloc(5 * 1024 * 1024))).status, 413);
  assert.ok(main.logs.some((l) => l.includes('"evt":"dictation_transcribed"')));
  assert.ok(!main.logs.some((l) => l.includes("сто двадцать") || l.includes("слышно")), "dictated words must not be logged");
});

await check("SAY translates Russian on the server and the caller hears the English line verbatim", async () => {
  mock.state.controls.length = 0;
  mock.state.aiRequests.length = 0;
  mock.state.ai.translations["Скажи, что я подумаю"] = "I'll think about it.";
  let r = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "Скажи, что я подумаю", translate: true, language: "English" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.spoken, "I'll think about it.");
  assert.equal(r.json.translated, true);
  assert.deepEqual(mock.state.controls.map((c) => c.payload), [{ type: "say", content: "I'll think about it.", endCallAfterSpoken: false }]);
  const tr = mock.state.aiRequests.find((q) => q.model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  assert.match(tr.input.messages[0].content, /English/);
  assert.equal(tr.input.messages[1].content, "Скажи, что я подумаю");
  // English (Latin script) is never sent for translation.
  mock.state.aiRequests.length = 0;
  r = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "I'll call you back.", translate: true } });
  assert.equal(r.json.translated, false);
  assert.equal(r.json.spoken, "I'll call you back.");
  assert.equal(mock.state.aiRequests.length, 0);
  // Translation down, or an answer still in Russian: nothing reaches the caller.
  mock.state.controls.length = 0;
  mock.state.ai.failTranslate = true;
  r = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "Привет", translate: true } });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "translate_failed");
  mock.state.ai.failTranslate = false;
  mock.state.ai.translations["Как дела"] = "Как дела?";
  r = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "Как дела", translate: true } });
  assert.equal(r.json.error.code, "translate_failed");
  assert.equal(mock.state.controls.length, 0);
});

await check("operator mode lives on the server: each line unmutes, the hub mutes again when the line is spoken", async () => {
  const types = () => mock.state.controls.map((c) => (c.payload.type === "control" ? c.payload.control : c.payload.type + (c.payload.triggerResponseEnabled === false ? ":silent" : "")));
  const events = await openWs(`${MAIN.replace("http", "ws")}/vapi-control/api/events`);
  await waitFor(() => events.handle.messages.length > 0, { what: "snapshot" });
  mock.state.controls.length = 0;
  let r = await api(`calls/${CALL_1}/mode`, { method: "POST", body: { operator: true, text: "[Operator control ON] stay silent", mute: true } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(types(), ["add-message:silent", "mute-assistant"]);
  // Every open console (any device) learns the mode.
  await waitFor(() => events.handle.messages.some((m) => { const x = JSON.parse(m); return x.type === "state" && x.call.callId === CALL_1 && x.call.operator === true; }), { what: "mode broadcast" });

  mock.state.controls.length = 0;
  r = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "Hold on a second." } });
  assert.equal(r.status, 200);
  assert.deepEqual(types(), ["unmute-assistant", "say"]);
  assert.equal(mock.state.controls[1].payload.interruptAssistantEnabled, true, "the line replaces queued speech");
  await webhook({ type: "speech-update", role: "assistant", status: "started", call: { id: CALL_1 }, timestamp: Date.now() });
  await sleep(600);
  assert.deepEqual(types(), ["unmute-assistant", "say"], "not muted while the line is being spoken");
  await webhook({ type: "speech-update", role: "assistant", status: "stopped", call: { id: CALL_1 }, timestamp: Date.now() });
  await waitFor(() => types().length === 3, { what: "re-mute after the line", timeout: 3000 });
  assert.equal(types()[2], "mute-assistant");
  assert.ok(main.logs.some((l) => l.includes('"evt":"assistant_remuted"') && l.includes("speech_stopped")));

  // No speech events at all: the estimate re-mutes anyway.
  mock.state.controls.length = 0;
  await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "Yes." } });
  assert.deepEqual(types(), ["unmute-assistant", "say"]);
  await waitFor(() => types().length === 3, { what: "re-mute by estimate", timeout: 8000 });
  assert.equal(types()[2], "mute-assistant");

  // The translation fallback (the model speaks the line) is a line too.
  mock.state.controls.length = 0;
  await api(`calls/${CALL_1}/instruction`, { method: "POST", body: { text: "[Operator dictation] Say: «Я подумаю»", line: true } });
  assert.deepEqual(types(), ["unmute-assistant", "add-message"]);

  // Hand back: silent note + unmute; afterwards lines leave mute alone.
  mock.state.controls.length = 0;
  r = await api(`calls/${CALL_1}/mode`, { method: "POST", body: { operator: false, text: "[Operator control OFF]", mute: true } });
  assert.deepEqual(types(), ["add-message:silent", "unmute-assistant"]);
  mock.state.controls.length = 0;
  await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "Thanks." } });
  await sleep(300);
  assert.deepEqual(types(), ["say"]);
  events.handle.ws.close();
});

await check("20. DTMF is refused (409) when the assistant has no dtmf tool; nothing is sent", async () => {
  mock.state.controls.length = 0;
  const detail = await api(`calls/${CALL_1}`);
  assert.equal(detail.json.capabilities.dtmf.directSupported, false);
  assert.equal(detail.json.capabilities.dtmf.viaAssistantTool, false);
  const r = await api(`calls/${CALL_1}/dtmf`, { method: "POST", body: { keys: "1" } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "dtmf_unsupported");
  assert.equal(mock.state.controls.length, 0);
});

await check("21-22. DTMF via the assistant's dtmf tool: digits, * and #, sequences", async () => {
  mock.makeCall({ id: CALL_DTMF, assistantId: ASSISTANT_A, extra: { assistant: { name: "Thumbtack", model: { tools: [{ type: "dtmf" }] } } } });
  const detail = await api(`calls/${CALL_DTMF}`);
  assert.equal(detail.json.capabilities.dtmf.viaAssistantTool, true);
  mock.state.controls.length = 0;
  for (const keys of ["1", "#", "*", "1w2w3w4w#"]) {
    const r = await api(`calls/${CALL_DTMF}/dtmf`, { method: "POST", body: { keys } });
    assert.equal(r.status, 200, keys);
    const last = mock.state.controls.at(-1);
    assert.equal(last.callId, CALL_DTMF);
    assert.equal(last.payload.type, "add-message");
    assert.equal(last.payload.message.role, "system");
    assert.ok(last.payload.message.content.includes(`keys "${keys}"`));
    assert.equal(last.payload.triggerResponseEnabled, true);
  }
  assert.equal(mock.state.controls.length, 4);
  const bad = await api(`calls/${CALL_DTMF}/dtmf`, { method: "POST", body: { keys: "12a" } });
  assert.equal(bad.status, 400);
  assert.ok(!main.logs.some((l) => l.includes("1w2w3w4w#")), "DTMF digits must not be logged");
  mock.endCall(CALL_DTMF, "test");
});

await check("24. SAY & HANG UP uses endCallAfterSpoken (no timers), then the call ends", async () => {
  mock.state.controls.length = 0;
  const r = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "Okay, I'll think about it. Bye.", endCallAfterSpoken: true } });
  assert.equal(r.status, 200);
  assert.deepEqual(mock.state.controls[0].payload, {
    type: "say",
    content: "Okay, I'll think about it. Bye.",
    endCallAfterSpoken: true,
    interruptionsEnabled: false,
  });
  await waitFor(async () => (await api("calls")).json.calls.every((c) => c.id !== CALL_1), { what: "call to end after spoken" });
  const after = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "too late" } });
  assert.equal(after.status, 409);
  assert.equal(after.json.error.code, "call_ended");
});

await check("23. END CALL terminates exactly the selected call", async () => {
  mock.makeCall({ id: CALL_1, assistantId: ASSISTANT_A });
  mock.state.calls.get(CALL_2).status = "in-progress";
  mock.state.controls.length = 0;
  const r = await api(`calls/${CALL_2}/end`, { method: "POST", body: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(mock.state.controls.map((c) => [c.callId, c.payload.type]), [[CALL_2, "end-call"]]);
  assert.equal(mock.state.calls.get(CALL_2).status, "ended");
  assert.equal(mock.state.calls.get(CALL_1).status, "in-progress");
  const again = await api(`calls/${CALL_2}/end`, { method: "POST", body: {} });
  assert.equal(again.status, 409);
});

await check("call ends while a command is in flight -> clear 'call ended' error", async () => {
  mock.state.calls.get(CALL_1).rejectControl = true;
  let r = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "x" } });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "control_rejected");
  delete mock.state.calls.get(CALL_1).rejectControl;
  // Vapi rejects because the call just ended between our status check and the command
  const original = mock.state.calls.get(CALL_1);
  original.rejectControl = true;
  setTimeout(() => (original.status = "ended"), 0);
  r = await api(`calls/${CALL_1}/say`, { method: "POST", body: { text: "x" } });
  assert.ok(["call_ended", "control_rejected"].includes(r.json.error.code));
  delete original.rejectControl;
  mock.makeCall({ id: CALL_1, assistantId: ASSISTANT_A });
});

// ------------------------------------------------------- 15-17 listen ---
await check("15-17. LISTEN: authenticated WS proxies binary audio; drop and stop are observed", async () => {
  mock.state.listenConnections.length = 0;
  const conn = await openWs(`${MAIN.replace("http", "ws")}/vapi-control/api/calls/${CALL_1}/listen`);
  assert.equal(conn.opened, true);
  await waitFor(() => conn.handle.binaryFrames >= 25, { what: "audio frames" });
  assert.ok(conn.handle.messages.includes(JSON.stringify({ type: "hello" })));
  assert.equal(mock.state.listenConnections.length, 1);
  assert.equal(mock.state.listenConnections[0].authorization, null, "private key must not be sent to the listen URL");
  // Remote side drops -> browser sees the close (the page then reconnects)
  mock.dropListen(CALL_1);
  await waitFor(() => conn.handle.closed !== null, { what: "close after drop" });
  // Reconnect works
  const again = await openWs(`${MAIN.replace("http", "ws")}/vapi-control/api/calls/${CALL_1}/listen`);
  assert.equal(again.opened, true);
  await waitFor(() => again.handle.binaryFrames >= 5, { what: "audio after reconnect" });
  // Operator stops listening -> upstream Vapi socket is closed too
  again.handle.ws.close(1000);
  await waitFor(() => (mock.state.listenSockets.get(CALL_1)?.size || 0) === 0, { what: "upstream socket cleanup" });
  // Listening to an ended call is refused
  const endedId = CALL_2;
  const refused = await openWs(`${MAIN.replace("http", "ws")}/vapi-control/api/calls/${endedId}/listen`);
  assert.equal(refused.opened, false);
  assert.ok(main.logs.some((l) => l.includes('"evt":"listen_connection_established"')));
});

// --------------------------------------------- 13-14, 26 webhook/events ---
await check("webhook ingress rejects missing/wrong secrets and forwards nothing", async () => {
  mock.state.forwarded.length = 0;
  const msg = { type: "status-update", status: "in-progress", call: { id: CALL_1 } };
  assert.equal((await webhook(msg, { secret: null })).status, 401);
  assert.equal((await webhook(msg, { secret: "wrong" })).status, 401);
  assert.equal(mock.state.forwarded.length, 0);
  const res = await fetch(`${HOOK}/vapi/events`, { method: "GET" });
  assert.equal(res.status, 405);
  assert.equal((await fetch(`${HOOK}/anything`)).status, 404);
});

await check("webhook forwards the untouched event to the previous Server URL (without our secret)", async () => {
  mock.state.forwarded.length = 0;
  const msg = { type: "end-of-call-report", endedReason: "hangup", call: { id: CALL_2, monitor: { controlUrl: "x" } }, artifact: { transcript: "..." } };
  const r = await webhook(msg);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { forwarded: true, results: [] });
  assert.equal(mock.state.forwarded.length, 1);
  assert.deepEqual(JSON.parse(mock.state.forwarded[0].body), { message: msg });
    assert.equal(mock.state.forwarded[0].headers["x-vapi-signature"], "sig-123");
  // A secret in a custom header is not accepted (only the Bearer credential)
  const custom = await webhook({ type: "speech-update", role: "user", status: "started", call: { id: CALL_1 } }, { headerName: "X-Vapi-Secret" });
  assert.equal(custom.status, 401);
  // A Vapi credential saved without the "Bearer " prefix is accepted too.
  const bare = await fetch(`${HOOK}/vapi/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: FAKE_WEBHOOK_SECRET },
    body: JSON.stringify({ message: { type: "speech-update", role: "user", status: "stopped", call: { id: CALL_1 } } }),
  });
  assert.equal(bare.status, 200);
  const wrong = await fetch(`${HOOK}/vapi/events`, { method: "POST", headers: { Authorization: "Bearer nope" }, body: "{}" });
  assert.equal(wrong.status, 401);
  assert.ok(hook.logs.some((l) => l.includes('"reason":"secret_mismatch"') && l.includes('"providedLength":4')), "rejection is diagnosable");
  assert.equal(mock.state.forwarded[0].headers.authorization, undefined, "our credential is not forwarded");
});

await check("13-14, 26. live events: transcript/status reach the browser socket, sanitized, in order", async () => {
  const events = await openWs(`${MAIN.replace("http", "ws")}/vapi-control/api/events`);
  assert.equal(events.opened, true);
  await waitFor(() => events.handle.messages.some((m) => JSON.parse(m).type === "snapshot"), { what: "snapshot" });
  const t0 = Date.now();
  await webhook({ type: "status-update", status: "in-progress", call: { id: CALL_1, monitor: { listenUrl: "wss://secret.vapi.ai/x" } }, timestamp: t0 });
  await webhook({ type: "transcript", role: "user", transcriptType: "partial", transcript: "How many", call: { id: CALL_1 }, timestamp: t0 + 10 });
  await webhook({ type: "transcript", role: "user", transcriptType: "final", transcript: "How many TVs?", call: { id: CALL_1 }, timestamp: t0 + 20 });
  await webhook({
    type: "conversation-update",
    call: { id: CALL_1 },
    timestamp: t0 + 30,
    messages: [
      { role: "system", message: "TOP SECRET PROMPT", time: t0 },
      { role: "user", message: "How many TVs?", time: t0 + 5 },
      { role: "bot", message: "One.", time: t0 + 25 },
    ],
  });
  await webhook({ type: "status-update", status: "ended", endedReason: "customer-ended-call", call: { id: CALL_1 }, timestamp: t0 + 40 });
  await waitFor(() => events.handle.messages.some((m) => m.includes("customer-ended-call")), { what: "ended event" });
  const msgs = events.handle.messages.map((m) => JSON.parse(m)).filter((m) => m.type !== "snapshot");
  const all = events.handle.messages.join("\n");
  assert.ok(!all.includes("vapi.ai"), "monitor URLs must not reach the browser");
  assert.ok(!all.includes("TOP SECRET PROMPT"), "assistant prompt must not reach the browser");
  assert.deepEqual(
    msgs.map((m) => (m.type === "live" ? `live:${m.transcriptType}:${m.text}` : m.type === "state" ? `state:${m.call.status}:${m.call.messages.length}` : m.type)),
    ["state:in-progress:0", "live:partial:How many", "live:final:How many TVs?", "state:in-progress:2", "state:ended:2"],
  );
  const conv = msgs.find((m) => m.type === "state" && m.call.messages.length === 2).call.messages;
  assert.deepEqual(conv.map((m) => `${m.role}:${m.text}`), ["user:How many TVs?", "assistant:One."]);
  events.handle.ws.close();
  // A reconnecting browser gets the full, deduplicated state in its snapshot
  const again = await openWs(`${MAIN.replace("http", "ws")}/vapi-control/api/events`);
  await waitFor(() => again.handle.messages.length > 0, { what: "snapshot 2" });
  const snap = JSON.parse(again.handle.messages[0]);
  const st = snap.calls.find((c) => c.callId === CALL_1);
  assert.equal(st.status, "ended");
  assert.equal(st.messages.length, 2);
  again.handle.ws.close();
  assert.ok(hook.logs.some((l) => l.includes('"evt":"webhook_status_event"') && l.includes("ended")));
});

await check("events socket requires Access and an allowed origin", async () => {
  assert.equal((await openWs(`${MAIN.replace("http", "ws")}/vapi-control/api/events`, { token: null })).opened, false);
  assert.equal((await openWs(`${MAIN.replace("http", "ws")}/vapi-control/api/events`, { origin: "https://evil.example" })).opened, false);
});

// ------------------------------------------------------------ web push ---
const PHONE = fakeSubscription(`${mock.base}/push/phone`);
const TABLET = fakeSubscription(`${mock.base}/push/tablet`);

await check("Web Push: a device subscribes; its test alert is encrypted for it and signed with VAPID", async () => {
  let r = await api("push/subscribe", { method: "POST", body: { subscription: PHONE.subscription, label: "Android · Chrome" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.devices, 1);
  r = await api("push/subscribe", { method: "POST", body: { subscription: { ...PHONE.subscription, endpoint: "https://evil.example/push" } } });
  assert.equal(r.status, 400, "unknown push services are refused");
  r = await api("push/subscribe", { method: "POST", body: { subscription: PHONE.subscription }, origin: "https://evil.example" });
  assert.equal(r.status, 403);
  mock.state.pushes.length = 0;
  r = await api("push/test", { method: "POST", body: { endpoint: PHONE.subscription.endpoint } });
  assert.equal(r.json.sent, 1);
  const p = mock.state.pushes[0];
  assert.equal(p.device, "phone");
  assert.equal(p.headers["content-encoding"], "aes128gcm");
  assert.equal(p.headers.urgency, "high");
  assert.ok(Number(p.headers.ttl) > 0);
  const claims = verifyVapid(p.headers.authorization, VAPID);
  assert.equal(claims.aud, mock.base);
  const msg = PHONE.decrypt(p.body);
  assert.equal(msg.type, "test");
  assert.ok(!p.body.toString("latin1").includes("Test alert"), "payload is encrypted");
});

await check("Web Push: a new call alerts every device once; devices the push service drops are removed", async () => {
  await api("push/subscribe", { method: "POST", body: { subscription: TABLET.subscription, label: "iPhone/iPad · Safari (app)" } });
  mock.state.pushes.length = 0;
  const NEW = "aaaaaaaa-0000-4000-8000-00000000000a";
  await webhook({ type: "status-update", status: "ringing", call: { id: NEW, type: "inboundPhoneCall", customer: { number: "+15557654321" } }, timestamp: Date.now() });
  await waitFor(() => mock.state.pushes.length >= 2, { what: "alerts to both devices" });
  const byDevice = Object.fromEntries(mock.state.pushes.map((p) => [p.device, p]));
  for (const [device, sub] of [["phone", PHONE], ["tablet", TABLET]]) {
    const alert = sub.decrypt(byDevice[device].body);
    assert.equal(alert.type, "call");
    assert.equal(alert.callId, NEW);
    assert.equal(alert.title, "📞 Incoming call");
    assert.match(alert.body, /\+15557654321/);
    assert.equal(alert.url, `./?call=${NEW}`);
  }
  assert.equal(byDevice.phone.headers.topic, NEW.replace(/-/g, ""));
  // Further events of the same call do not alert again.
  await webhook({ type: "status-update", status: "in-progress", call: { id: NEW }, timestamp: Date.now() });
  await webhook({ type: "speech-update", role: "user", status: "started", call: { id: NEW }, timestamp: Date.now() });
  await webhook({ type: "conversation-update", call: { id: NEW }, timestamp: Date.now(), messages: [] });
  await sleep(600);
  assert.equal(mock.state.pushes.length, 2);
  // A late report of a call that already ended is no reason to alert.
  await webhook({ type: "end-of-call-report", endedReason: "hangup", call: { id: "aaaaaaaa-0000-4000-8000-00000000000c" }, timestamp: Date.now() });
  await sleep(300);
  assert.equal(mock.state.pushes.length, 2);

  // The push service reports the tablet gone (410): it is dropped.
  mock.state.pushStatus.tablet = 410;
  mock.state.pushes.length = 0;
  const NEW2 = "aaaaaaaa-0000-4000-8000-00000000000b";
  await webhook({ type: "status-update", status: "in-progress", call: { id: NEW2 }, timestamp: Date.now() });
  await waitFor(() => mock.state.pushes.length >= 2, { what: "second call alerts" });
  await waitFor(() => main.logs.some((l) => l.includes('"evt":"push_sent"') && l.includes('"removed":1')), { what: "gone device removed" });
  mock.state.pushes.length = 0;
  let r = await api("push/test", { method: "POST", body: {} });
  assert.equal(r.json.sent, 1, "only the phone is left");
  await api("push/unsubscribe", { method: "POST", body: { endpoint: PHONE.subscription.endpoint } });
  r = await api("push/test", { method: "POST", body: {} });
  assert.equal(r.json.sent, 0);
  assert.ok(!main.logs.some((l) => l.includes("/push/phone") || l.includes("/push/tablet")), "push endpoints are not logged");
  for (const id of [NEW, NEW2]) await webhook({ type: "status-update", status: "ended", endedReason: "test", call: { id }, timestamp: Date.now() });
});

// ------------------------------------------------------ 29 Vapi errors ---
await check("29. Vapi failures become concise JSON errors (5xx, auth failure, not found)", async () => {
  mock.state.failList = 500;
  let r = await api("calls");
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, "vapi_unavailable");
  mock.state.failList = 429;
  r = await api("calls");
  assert.equal(r.json.error.code, "vapi_rate_limited");
  mock.state.failList = 401;
  r = await api("calls");
  assert.equal(r.json.error.code, "vapi_auth_failed");
  assert.ok(!r.text.includes(FAKE_VAPI_KEY));
  mock.state.failList = null;
  r = await api(`calls/${"aaaaaaaa-0000-4000-8000-00000000ffff"}`);
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "call_not_found");
  r = await api("nope");
  assert.equal(r.status, 404);
  r = await api(`calls/${CALL_1}/say`, { method: "POST", body: "not json", headers: { "Content-Type": "text/plain" } });
  assert.equal(r.status, 415);
});

// ---------------------------------------------------- 30 secret leakage ---
await check("30. no secret appears in any response, header or Worker log", async () => {
  await sleep(500);
  const haystack = [bodies.join("\n"), main.logs.join("\n"), hook.logs.join("\n")].join("\n");
  for (const secret of [FAKE_VAPI_KEY, FAKE_WEBHOOK_SECRET, TOKEN, VAPID.privateKey]) assert.ok(!haystack.includes(secret), `leaked: ${secret.slice(0, 12)}…`);
  const logText = [main.logs.join("\n"), hook.logs.join("\n")].join("\n");
  assert.ok(!/\/control\/|\/listen\/[^\s]*\/transport/.test(logText.replace(/vapi-control\/api\/calls\/[^\s"]+/g, "")), "monitor URLs must not be logged");
  for (const evt of ["active_call_detected", "call_selected", "say_requested", "say_and_hangup_requested", "ai_instruction_requested", "dtmf_requested", "end_call_requested", "listen_connection_established", "vapi_api_error", "call_ended"]) {
    assert.ok(logText.includes(`"evt":"${evt}"`), `missing operational log event ${evt}`);
  }
});

// ---------------------------------------------------------------- done ---
stopWorker(main);
stopWorker(hook);
await mock.close();
fs.mkdirSync(path.join(WORKER_DIR, "test-results"), { recursive: true });
fs.writeFileSync(path.join(WORKER_DIR, "test-results", "integration.json"), JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(WORKER_DIR, "test-results", "integration-worker-logs.txt"), main.logs.join("\n"));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} integration checks passed.`);
process.exit(failed.length ? 1 : 0);
