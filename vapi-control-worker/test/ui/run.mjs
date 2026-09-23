// Browser tests: the real console page in headless Chrome (DevTools
// protocol), served by the local Worker with real Access-JWT validation,
// against the mock Vapi server.
//
//   node test/ui/run.mjs

import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createTestIdp } from "../helpers/jwt.mjs";
import { startWorkers, stopWorker, WORKER_DIR } from "../helpers/devserver.mjs";
import { startMockVapi } from "../integration/mock-vapi.mjs";

const FAKE_VAPI_KEY = "ui-test-vapi-private-key-NEVER-LEAK";
const FAKE_WEBHOOK_SECRET = "ui-test-webhook-secret-NEVER-LEAK";
const AUD = "e".repeat(64);
const OPERATOR = "operator@example.com";
const ASSISTANT = "11111111-1111-4111-8111-111111111111";
const C1 = "cccccccc-0000-4000-8000-000000000001";
const C2 = "cccccccc-0000-4000-8000-000000000002";
const C3 = "cccccccc-0000-4000-8000-000000000003";
const C4 = "cccccccc-0000-4000-8000-000000000004";
const MAIN_PORT = 8799;
const HOOK_PORT = MAIN_PORT; // both Workers share one local process
const CDP_PORT = 9555;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean);

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.stack || error) });
    console.log(`  FAIL  ${name}\n        ${String(error?.message || error).split("\n").join("\n        ")}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ setup --
const idp = await createTestIdp();
const mock = await startMockVapi({ apiKey: FAKE_VAPI_KEY, jwks: idp.jwks });
mock.state.assistants.set(ASSISTANT, { id: ASSISTANT, model: { toolIds: [] } });
const TOKEN = await idp.sign(idp.claimsFor({ teamDomain: mock.base, aud: AUD, email: OPERATOR, ttlS: 3600 }));
const persistRoot = path.join(WORKER_DIR, ".wrangler", "test-ui");

let main;
let hook;
let chrome;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vapi-ui-"));
async function cleanup() {
  stopWorker(main);
  stopWorker(hook);
  if (chrome && chrome.exitCode === null) {
    try {
      if (process.platform === "win32") execSync(`taskkill /pid ${chrome.pid} /T /F`, { stdio: "ignore" });
      else chrome.kill("SIGKILL");
    } catch {
      // gone
    }
  }
  await mock.close();
  await sleep(300);
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold files briefly on Windows
  }
}

console.log("Starting local Workers and headless Chrome…");
try {
  main = await startWorkers({
    port: MAIN_PORT,
    inspectorPort: 9343,
    stateDir: persistRoot,
    secrets: { VAPI_API_KEY: FAKE_VAPI_KEY, VAPI_WEBHOOK_SECRET: FAKE_WEBHOOK_SECRET },
    mainVars: { VAPI_API_BASE_URL: mock.base, TEAM_DOMAIN: mock.base, POLICY_AUD: AUD, ALLOWED_EMAILS: OPERATOR },
    // No WEBHOOK_FORWARD_URL here: covers the "transcript only" setup.
    webhookVars: {},
  });
  hook = main;
  const exe = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!exe) throw new Error("No Chrome/Edge found (set CHROME_PATH).");
  chrome = spawn(exe, [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1400,900",
    "about:blank",
  ]);
  for (let i = 0; i < 100; i++) {
    try {
      await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      break;
    } catch {
      await sleep(200);
    }
  }
} catch (error) {
  console.error(String(error));
  await cleanup();
  process.exit(1);
}

// ------------------------------------------------------------ CDP client --
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === "page");
const cdp = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => cdp.once("open", r));
let seq = 0;
const pending = new Map();
const exceptions = [];
cdp.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") {
    exceptions.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    cdp.send(JSON.stringify({ id, method, params }));
  });
async function js(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (res.exceptionDetails) throw new Error(`JS error: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
  return res.result.value;
}
async function until(expression, { timeout = 8000, what = expression } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await js(expression);
      if (last) return last;
    } catch (error) {
      last = `error: ${error.message}`; // page still loading / navigating: keep polling
    }
    await sleep(100);
  }
  throw new Error(`Timed out: ${what} (last=${JSON.stringify(last)})`);
}
const text = (id) => js(`document.getElementById(${JSON.stringify(id)}).textContent`);
const click = (id) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
async function typeInto(id, value) {
  await js(`(() => { const t = document.getElementById(${JSON.stringify(id)}); t.focus(); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
}
async function ctrlEnter() {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 2 };
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
async function webhook(message) {
  const res = await fetch(`http://127.0.0.1:${HOOK_PORT}/vapi/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FAKE_WEBHOOK_SECRET}` },
    body: JSON.stringify({ message }),
  });
  assert.equal(res.status, 200);
}
// A call starting in Vapi: the API knows it and Vapi pushes status-update to
// the webhook, which is how the console learns about it instantly.
async function startCall(opts) {
  const call = mock.makeCall(opts);
  await webhook({ type: "status-update", status: call.status, call: { id: call.id }, timestamp: Date.now() });
  return call;
}
const lastControl = () => mock.state.controls.at(-1);
async function waitControl(count, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (mock.state.controls.length >= count) return mock.state.controls[count - 1];
    await sleep(50);
  }
  throw new Error(`expected ${count} control commands, got ${mock.state.controls.length}`);
}

await send("Runtime.enable");
await send("Network.enable");
// Stand-in for the header Cloudflare Access adds to every proxied request.
await send("Network.setExtraHTTPHeaders", { headers: { "Cf-Access-Jwt-Assertion": TOKEN } });
// Record any microphone request attempt.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source:
    "window.__micRequests = 0; if (navigator.mediaDevices) { const g = navigator.mediaDevices.getUserMedia?.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = (...a) => { window.__micRequests++; return g ? g(...a) : Promise.reject(new Error('blocked')); }; }",
});
await send("Page.enable");

const APP = `http://127.0.0.1:${MAIN_PORT}/vapi-control/`;
console.log("Running UI checks…");

await check("page loads at /vapi-control/ and shows NO ACTIVE CALL (no fake data)", async () => {
  await send("Page.navigate", { url: APP });
  await until(`document.getElementById('callStateText').textContent === 'NO ACTIVE CALL'`);
  assert.equal(await text("timer"), "--:--");
  assert.match(await text("transcript"), /NO ACTIVE CALL/);
  assert.equal(await js("document.getElementById('sayBtn').disabled"), true);
  assert.equal(await js("document.getElementById('endCallBtn').disabled"), true);
  assert.equal(await js("document.getElementById('listenBtn').disabled"), true);
  assert.equal(await text("userEmail"), OPERATOR);
  await until(`document.getElementById('eventsPill').dataset.state === 'connected'`, { what: "events socket connected through Access check" });
});

await check("a new call is detected automatically; timer uses Vapi startedAt", async () => {
  await startCall({ id: C1, assistantId: ASSISTANT, startedAgoMs: 43_000 });
  await until(`document.getElementById('callStateText').textContent === 'ACTIVE'`, { timeout: 8000 });
  assert.equal(await text("targetId"), C1);
  const t = await text("timer");
  assert.match(t, /^00:4[3-9]$/, `timer shows ${t}`);
  await until(`!document.getElementById('sayBtn').disabled || document.getElementById('sayText').value === ''`);
  assert.equal(await js("document.getElementById('callList').hidden"), true, "single call: no list needed");
});

await check("live transcript renders partial -> final -> committed without duplicates", async () => {
  const t0 = Date.now();
  await webhook({ type: "transcript", role: "user", transcriptType: "partial", transcript: "How many", call: { id: C1 }, timestamp: t0 });
  await until(`[...document.querySelectorAll('#transcript .msg.partial')].some(n => n.textContent.includes('How many'))`);
  await webhook({ type: "transcript", role: "user", transcriptType: "final", transcript: "How many TVs?", call: { id: C1 }, timestamp: t0 + 10 });
  await webhook({
    type: "conversation-update",
    call: { id: C1 },
    timestamp: t0 + 20,
    messages: [
      { role: "system", message: "SYSTEM PROMPT", time: t0 - 100 },
      { role: "user", message: "How many TVs?", time: t0 },
      { role: "bot", message: "One.", time: t0 + 15 },
    ],
  });
  await until(`document.querySelectorAll('#transcript .msg').length === 2 && !document.querySelector('#transcript .msg.partial')`);
  const rows = await js(`[...document.querySelectorAll('#transcript .msg')].map(n => n.querySelector('.who span').textContent + '|' + n.querySelector('.text').textContent)`);
  assert.deepEqual(rows, ["PROVIDER|How many TVs?", "ASSISTANT|One."]);
  assert.ok(!(await text("transcript")).includes("SYSTEM PROMPT"));
});

await check("EXACT SAY via Ctrl+Enter sends the exact text to the selected call", async () => {
  mock.state.controls.length = 0;
  await typeInto("sayText", "I have a few other offers. I'll think about it.");
  await until(`!document.getElementById('sayBtn').disabled`);
  await ctrlEnter();
  const c = await waitControl(1);
  assert.deepEqual(c, { callId: C1, payload: { type: "say", content: "I have a few other offers. I'll think about it.", endCallAfterSpoken: false }, authorization: null });
  await until(`document.getElementById('sayText').value === ''`);
});

await check("AI INSTRUCTION uses the configured template and targets the selected call", async () => {
  mock.state.controls.length = 0;
  await typeInto("instructionText", "Спроси его, это окончательная цена или будут дополнительные платежи.");
  await click("instructionBtn");
  const c = await waitControl(1);
  assert.equal(c.callId, C1);
  assert.equal(c.payload.type, "add-message");
  assert.equal(c.payload.message.role, "system");
  assert.equal(c.payload.triggerResponseEnabled, true);
  assert.ok(c.payload.message.content.includes("Спроси его, это окончательная цена или будут дополнительные платежи."));
  assert.ok(c.payload.message.content.includes("language of the phone conversation"));
});

await check("quick phrases: say immediately; hang-up phrase needs a confirming second click", async () => {
  mock.state.controls.length = 0;
  await js(`[...document.querySelectorAll('#quickPhrases button')].find(b => b.textContent === "What's the total?").click()`);
  const c = await waitControl(1);
  assert.deepEqual(c.payload, { type: "say", content: "What's the total price?", endCallAfterSpoken: false });
  await js(`document.querySelector('#quickPhrases button.hangup').click()`);
  await sleep(400);
  assert.equal(mock.state.controls.length, 1, "first click only arms the hang-up phrase");
  assert.match(await js(`document.querySelector('#quickPhrases button.hangup').textContent`), /Click again/);
  await sleep(3200);
  assert.equal(await js(`document.querySelector('#quickPhrases button.hangup').textContent`), "Goodbye + Hang Up", "disarms after 3 s");
});

await check("operator mode: TAKE OVER sends a silent instruction; translate routes EXACT SAY through the model", async () => {
  mock.state.controls.length = 0;
  await until(`!document.getElementById('modeBtn').disabled`);
  await click("modeBtn");
  const enter = await waitControl(1);
  assert.equal(enter.payload.type, "add-message");
  assert.equal(enter.payload.triggerResponseEnabled, false);
  assert.match(enter.payload.message.content, /Operator control ON/);
  await until(`document.body.classList.contains('manual-mode') && document.getElementById('modeBtn').textContent.includes('HAND BACK')`);
  await js(`document.getElementById('translateSay').checked = true`);
  await typeInto("sayText", "Скажи, что я подумаю");
  await until(`!document.getElementById('sayBtn').disabled`);
  await click("sayBtn");
  const tr = await waitControl(2);
  assert.equal(tr.payload.type, "add-message");
  assert.equal(tr.payload.triggerResponseEnabled, true);
  assert.ok(tr.payload.message.content.includes("Скажи, что я подумаю") && tr.payload.message.content.includes("English"));
  await js(`document.getElementById('translateSay').checked = false`);
  await click("modeBtn");
  const leave = await waitControl(3);
  assert.match(leave.payload.message.content, /Operator control OFF/);
  assert.equal(leave.payload.triggerResponseEnabled, false);
  await until(`!document.body.classList.contains('manual-mode')`);
});

await check("DTMF keypad is disabled and labelled NOT SUPPORTED when the assistant has no dtmf tool", async () => {
  assert.equal(await text("dtmfState"), "NOT SUPPORTED BY VAPI");
  assert.equal(await js(`[...document.querySelectorAll('#keypad button')].every(b => b.disabled)`), true);
  assert.equal(await js("document.getElementById('dtmfSend').disabled"), true);
});

await check("LISTEN: connects, auto-detects PCM format, survives a dropped stream, STOP cleans up; no microphone", async () => {
  await until(`!document.getElementById('listenBtn').disabled`);
  await click("listenBtn");
  await until(`document.getElementById('audioState').dataset.state === 'connected'`);
  await until(`document.getElementById('audioFormatInfo').textContent.includes('16 kHz mono')`, { timeout: 8000, what: "format detection" });
  assert.equal(await text("listenBtn"), "STOP LISTENING");
  mock.dropListen(C1);
  await until(`['reconnecting','connecting'].includes(document.getElementById('audioState').dataset.state)`, { timeout: 4000 });
  await until(`document.getElementById('audioState').dataset.state === 'connected'`, { timeout: 8000, what: "reconnected" });
  assert.equal(mock.state.listenSockets.get(C1)?.size, 1);
  await click("listenBtn");
  await until(`document.getElementById('audioState').dataset.state === 'disconnected'`);
  await until(`${0} === 0`);
  const end = Date.now() + 3000;
  while ((mock.state.listenSockets.get(C1)?.size || 0) > 0 && Date.now() < end) await sleep(50);
  assert.equal(mock.state.listenSockets.get(C1)?.size || 0, 0, "upstream listen socket closed");
  assert.equal(await js("window.__micRequests"), 0);
});

await check("multiple calls: list shown, selection stays explicit, commands go to the chosen call", async () => {
  await startCall({ id: C2, assistantId: ASSISTANT, startedAgoMs: 5000, number: "+15552223333" });
  await until(`!document.getElementById('callList').hidden && document.querySelectorAll('#callRows .call-row').length === 2`);
  assert.equal(await text("targetId"), C1, "no silent switch to the new call");
  assert.ok(await js(`!!document.querySelector('#callRows .badge-new')`), "new call is flagged");
  await js(`document.querySelector('#callRows .call-row[data-call-id="${C2}"]').click()`);
  await until(`document.getElementById('targetId').textContent === '${C2}'`);
  await until(`!document.getElementById('instructionBtn').disabled || true`);
  mock.state.controls.length = 0;
  await typeInto("sayText", "Hello second call");
  await until(`!document.getElementById('sayBtn').disabled`);
  await click("sayBtn");
  const c = await waitControl(1);
  assert.equal(c.callId, C2);
});

await check("END CALL asks for confirmation; Cancel sends nothing; End Call ends the selected call", async () => {
  mock.state.controls.length = 0;
  await click("endCallBtn");
  await until(`document.getElementById('endDialog').open`);
  assert.match(await text("endDialogMeta"), new RegExp(C2));
  await click("endCancel");
  await sleep(300);
  assert.equal(mock.state.controls.length, 0);
  await click("endCallBtn");
  await until(`document.getElementById('endDialog').open`);
  await click("endConfirm");
  const c = await waitControl(1);
  assert.deepEqual([c.callId, c.payload.type], [C2, "end-call"]);
  await until(`document.getElementById('callStateText').textContent === 'CALL ENDED'`);
  assert.equal(mock.state.calls.get(C1).status, "in-progress", "other call untouched");
  // After the banner, the remaining single call is selected again automatically.
  await until(`document.getElementById('targetId').textContent === '${C1}'`, { timeout: 9000 });
});

await check("remote hang-up (webhook status-update) is detected -> CALL ENDED -> NO ACTIVE CALL", async () => {
  await until(`!document.getElementById('listenBtn').disabled`, { what: "LISTEN enabled once call details load" });
  await click("listenBtn");
  await until(`document.getElementById('audioState').dataset.state === 'connected'`);
  mock.endCall(C1, "customer-ended-call");
  await webhook({ type: "status-update", status: "ended", endedReason: "customer-ended-call", call: { id: C1 }, timestamp: Date.now() });
  await until(`document.getElementById('callStateText').textContent === 'CALL ENDED'`, { timeout: 4000 });
  assert.match(await text("banner"), /customer-ended-call/);
  assert.equal(await js(`document.getElementById('audioState').dataset.state`), "disconnected");
  await until(`document.getElementById('callStateText').textContent === 'NO ACTIVE CALL'`, { timeout: 9000 });
  assert.equal(await text("timer"), "--:--");
  assert.equal(await js("document.getElementById('sayBtn').disabled"), true);
  assert.equal([...(mock.state.listenSockets.values())].reduce((n, s) => n + s.size, 0), 0, "all listen sockets closed");
});

await check("SAY & HANG UP: speaks, then the call ends by itself -> NO ACTIVE CALL", async () => {
  await startCall({ id: C3, assistantId: ASSISTANT, startedAgoMs: 1000, extra: { assistant: { name: "Thumbtack", model: { tools: [{ type: "dtmf" }] } } } });
  await until(`document.getElementById('targetId').textContent === '${C3}'`, { timeout: 8000 });
  mock.state.controls.length = 0;
  // DTMF keypad is available here (inline assistant has the dtmf tool)
  await until(`document.getElementById('dtmfState').textContent === 'via assistant dtmf tool'`);
  for (const key of ["1", "2", "#"]) await js(`document.querySelector('#keypad button[data-key="${key}"]').click()`);
  assert.equal(await text("dtmfDisplay"), "12#");
  await click("dtmfSend");
  const d = await waitControl(1);
  assert.ok(d.payload.message.content.includes('keys "1w2w#"'));
  await until(`document.getElementById('dtmfDisplay').textContent === ''`);
  await typeInto("sayText", "Okay, I'll think about it. Bye.");
  await until(`!document.getElementById('sayHangupBtn').disabled`);
  await click("sayHangupBtn");
  const c = await waitControl(2);
  assert.deepEqual(c.payload, { type: "say", content: "Okay, I'll think about it. Bye.", endCallAfterSpoken: true, interruptionsEnabled: false });
  await until(`document.getElementById('banner').textContent.includes('hang up when it finishes') || document.getElementById('callStateText').textContent === 'CALL ENDED'`);
  await until(`document.getElementById('callStateText').textContent === 'CALL ENDED'`, { timeout: 8000 });
  await until(`document.getElementById('callStateText').textContent === 'NO ACTIVE CALL'`, { timeout: 9000 });
});

await check("Vapi errors are shown without crashing, and the page recovers", async () => {
  // Polling is only a safety net while events are live (15 s), so allow for it.
  mock.state.failList = 500;
  await until(`!document.getElementById('banner').hidden && document.getElementById('banner').textContent.includes('Vapi is unavailable')`, { timeout: 25000 });
  mock.state.failList = null;
  await until(`document.getElementById('banner').hidden`, { timeout: 25000 });
  assert.equal(await text("callStateText"), "NO ACTIVE CALL");
});

await check("no uncaught JavaScript exceptions; no secrets in the page", async () => {
  assert.deepEqual(exceptions, []);
  const html = await js("document.documentElement.outerHTML");
  assert.ok(!html.includes(FAKE_VAPI_KEY));
  const storage = await js("JSON.stringify(Object.assign({}, localStorage))");
  assert.ok(!storage.includes(FAKE_VAPI_KEY) && !storage.includes(TOKEN), "no credentials in localStorage");
});

await check("phone-width layout has no horizontal scroll", async () => {
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  const overflow = await js("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(path.join(WORKER_DIR, "test-results"), { recursive: true });
  fs.writeFileSync(path.join(WORKER_DIR, "test-results", "ui-phone.png"), Buffer.from(shot.data, "base64"));
  await send("Emulation.clearDeviceMetricsOverride");
});

await check("desktop screenshot with an active call", async () => {
  await startCall({ id: C4, assistantId: ASSISTANT, startedAgoMs: 222_000 });
  await until(`document.getElementById('callStateText').textContent === 'ACTIVE'`, { timeout: 8000 });
  const t0 = Date.now();
  await webhook({
    type: "conversation-update",
    call: { id: C4 },
    timestamp: t0,
    messages: [
      { role: "system", message: "prompt", time: t0 - 9000 },
      { role: "user", message: "How many TVs?", time: t0 - 8000 },
      { role: "bot", message: "One.", time: t0 - 7000 },
      { role: "user", message: "What kind of wall?", time: t0 - 6000 },
      { role: "bot", message: "Drywall.", time: t0 - 5000 },
    ],
  });
  await webhook({ type: "transcript", role: "user", transcriptType: "partial", transcript: "So the total would be one hundred", call: { id: C4 }, timestamp: t0 + 10 });
  await until(`document.querySelectorAll('#transcript .msg').length === 5`);
  await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(WORKER_DIR, "test-results", "ui-desktop.png"), Buffer.from(shot.data, "base64"));
});

cdp.close();
fs.mkdirSync(path.join(WORKER_DIR, "test-results"), { recursive: true });
fs.writeFileSync(path.join(WORKER_DIR, "test-results", "ui-worker-logs.txt"), main.logs.join(String.fromCharCode(10)));
await cleanup();
const failed = results.filter((r) => !r.ok);
fs.mkdirSync(path.join(WORKER_DIR, "test-results"), { recursive: true });
fs.writeFileSync(path.join(WORKER_DIR, "test-results", "ui.json"), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} UI checks passed.`);
process.exit(failed.length ? 1 : 0);
