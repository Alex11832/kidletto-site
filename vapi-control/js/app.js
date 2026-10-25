// Vapi Live Control — operator console controller.
//
// Data flow:
//   poll   GET api/calls every few seconds  -> active call list (authoritative)
//   events WS  api/events                   -> live transcript / speech / status / operator mode
//   listen WS  api/calls/:id/listen         -> call audio (only while LISTEN is on)
//   commands POST api/calls/:id/...         -> say / instruction / mode / dtmf / end
//   dictate  POST api/transcribe            -> operator's recorded voice -> text
//   alerts   sw.js + api/push/...           -> Web Push call alerts, console closed or not
//
// Safety rules:
//   - A command always targets the call ID shown under CONTROLLING at the
//     moment of the click; nothing is ever sent without an explicit selection.
//   - With several active calls nothing is auto-selected.
//   - When the selected call ends, the selection is cleared (no silent switch).

import { ApiError, createApi } from "./api.js";
import { EventsClient } from "./events.js";
import { ListenPlayer, describeFormat, FORMAT_PRESETS } from "./audio.js";
import { applyHubMessage, createTranscriptStore, speakingRoles, transcriptView } from "./transcript.js";
import { callElapsedMs, clockTime, directionLabel, formatDuration, shortId, statusLabel } from "./format.js";
import { Recorder, dictationSupported } from "./dictation.js";
import { currentSubscription, disablePush, enablePush, isIos, isStandalone, pushSupported, registerServiceWorker } from "./push.js";
import { createPromotionController } from "./promotions.js";

const DEFAULTS = {
  apiBase: "api/",
  poll: { liveMs: 0, fallbackMs: 30000, hiddenMultiplier: 4 },
  notify: { sound: true, desktop: true, titleBadge: true, push: true },
  endedBannerMs: 5000,
  labels: { user: "PROVIDER", assistant: "ASSISTANT", system: "INSTRUCTION", tool: "TOOL" },
  say: {
    interruptAssistantByDefault: false,
    clearAfterSend: true,
    translate: { enabledByDefault: true, targetLanguage: "English", template: "{text}" },
  },
  dictation: { language: "ru", autoSend: true, maxSeconds: 45 },
  operatorMode: { useMute: true, enterText: "", leaveText: "" },
  aiInstruction: { template: "{instruction}", clearAfterSend: true },
  quickPhrases: [],
  dtmf: { pauseBetweenDigits: "w", sendOnPress: false, autoSendAfterMs: 1200, confirmWithinSeconds: 12, maxLength: 32 },
  listen: { defaultFormat: "auto", volume: 1, autoStart: true },
};

function mergeConfig(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      out[key] = mergeConfig(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

const cfg = mergeConfig(DEFAULTS, window.VAPI_CONTROL_CONFIG);
const api = createApi(cfg.apiBase);
const store = createTranscriptStore();
const $ = (id) => document.getElementById(id);

function loadPref(key, fallback) {
  try {
    const value = window.localStorage.getItem(`vapiControl.${key}`);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function savePref(key, value) {
  try {
    window.localStorage.setItem(`vapiControl.${key}`, String(value));
  } catch {
    // Storage unavailable (private mode); preferences just won't persist.
  }
}

const state = {
  session: null,
  calls: [],
  loaded: false,
  fatal: null,
  pollError: null,
  pollTimer: null,
  polling: false,
  skewMs: 0,
  selectedId: null,
  caps: null,
  capsStatus: null,
  ended: null,
  hangingUp: null,
  seen: new Set(),
  newIds: new Set(),
  busy: new Set(),
  dtmf: "",
  follow: true,
  eventsState: "offline",
  hubSeen: new Set(),
  listen: null,
  audioState: "disconnected",
  audioDetail: "",
  audioFormat: null,
  audioFormatKey: loadPref("audioFormat", cfg.listen.defaultFormat),
  volume: Number(loadPref("volume", cfg.listen.volume)) || 1,
  endTarget: null,
  notifiedCalls: new Set(),
  fetchingCalls: new Set(),
  // Browsers allow audio only after the operator has clicked the page once.
  audioUnlocked: false,
  sharedAudio: null,
  phrases: null, // null = config defaults; else the list saved on the server
  // Dictation: idle | starting | recording | working
  dictation: { phase: "idle", recorder: null, status: "", error: false, timer: null },
  autoSend: loadPref("autoSendDictation", cfg.dictation.autoSend ? "1" : "0") === "1",
  lastLine: null, // { heard, spoken }
  // Alerts / install
  swReg: null,
  pushKey: null,
  pushOn: false,
  installPrompt: null,
  // Call named by an alert click (?call=… or a service-worker message).
  wantedCallId: null,
};
if (!(state.audioFormatKey in FORMAT_PRESETS)) state.audioFormatKey = "auto";

const el = {
  applyPromotions: $("applyPromotions"),
  promotionSummary: $("promotionSummary"),
  promotionStatus: $("promotionStatus"),
  refreshPromotions: $("refreshPromotions"),
  callState: $("callState"),
  callStateText: $("callStateText"),
  timer: $("timer"),
  eventsPill: $("eventsPill"),
  enableNotify: $("enableNotify"),
  alertsBtn: $("alertsBtn"),
  installBtn: $("installBtn"),
  alertsDialog: $("alertsDialog"),
  alertsStatus: $("alertsStatus"),
  alertsHint: $("alertsHint"),
  alertsEnable: $("alertsEnable"),
  alertsTest: $("alertsTest"),
  alertsDisable: $("alertsDisable"),
  alertsClose: $("alertsClose"),
  micBtn: $("micBtn"),
  micLabel: $("micLabel"),
  micCancel: $("micCancel"),
  micStatus: $("micStatus"),
  micLevel: $("micLevel"),
  micLevelBar: $("micLevelBar"),
  autoSendDictation: $("autoSendDictation"),
  lastLine: $("lastLine"),
  editPhrases: $("editPhrases"),
  phraseDialog: $("phraseDialog"),
  phraseRows: $("phraseRows"),
  phraseAdd: $("phraseAdd"),
  phraseReset: $("phraseReset"),
  phraseCancel: $("phraseCancel"),
  phraseSave: $("phraseSave"),
  configWarning: $("configWarning"),
  userEmail: $("userEmail"),
  modeState: $("modeState"),
  modeBtn: $("modeBtn"),
  modeNote: $("modeNote"),
  translateSay: $("translateSay"),
  translateLang: $("translateLang"),
  banner: $("banner"),
  callList: $("callList"),
  callRows: $("callRows"),
  callListHint: $("callListHint"),
  transcript: $("transcript"),
  speaking: $("speaking"),
  jumpLatest: $("jumpLatest"),
  target: $("target"),
  targetId: $("targetId"),
  targetMeta: $("targetMeta"),
  listenBtn: $("listenBtn"),
  volume: $("volume"),
  audioState: $("audioState"),
  audioFormat: $("audioFormat"),
  audioFormatInfo: $("audioFormatInfo"),
  sayText: $("sayText"),
  interruptBot: $("interruptBot"),
  sayBtn: $("sayBtn"),
  sayHangupBtn: $("sayHangupBtn"),
  instructionText: $("instructionText"),
  instructionBtn: $("instructionBtn"),
  dtmfState: $("dtmfState"),
  dtmfDisplay: $("dtmfDisplay"),
  keypad: $("keypad"),
  dtmfClear: $("dtmfClear"),
  dtmfSend: $("dtmfSend"),
  dtmfNote: $("dtmfNote"),
  quickPhrases: $("quickPhrases"),
  endCallBtn: $("endCallBtn"),
  endDialog: $("endDialog"),
  endDialogMeta: $("endDialogMeta"),
  endCancel: $("endCancel"),
  endConfirm: $("endConfirm"),
  toasts: $("toasts"),
};

const promotions = createPromotionController(api, renderPromotions);
function renderPromotions() {
  const view = promotions.state;
  el.applyPromotions.checked = view.snapshot?.enabled === true;
  el.applyPromotions.disabled = !promotions.canChange();
  el.refreshPromotions.disabled = view.loading || view.saving;
  el.promotionSummary.textContent = view.saving ? "Saving pricing and updating active calls…" : view.loading ? "Checking the saved discount setting…" : !view.verified ? "Discount status could not be confirmed." : !view.snapshot.configured ? "Set discounted prices in the CRM first." : `${view.snapshot.enabled ? "Discounted prices only" : "Standard prices"} · ${view.snapshot.priceCount} discounted services · same setting in CRM`;
  el.promotionStatus.textContent = view.error || view.notice;
  el.promotionStatus.dataset.state = view.error ? "error" : view.warning ? "warning" : "saved";
}

// ---------------------------------------------------------------- helpers --

function selectedCall() {
  return state.selectedId ? state.calls.find((c) => c.id === state.selectedId) || null : null;
}

function canControl() {
  const call = selectedCall();
  return Boolean(call && call.status === "in-progress" && state.caps?.control && state.capsStatus === "in-progress" && !state.fatal);
}

// Operator mode is kept per call by the server (hub), so it is the same in
// every browser and on every device, and survives a page reload.
function isManual(id) {
  return Boolean(id && store.calls.get(id)?.operator);
}

function toast(message, kind = "info", ms = 4500) {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  el.toasts.appendChild(node);
  while (el.toasts.children.length > 4) el.toasts.firstChild.remove();
  setTimeout(() => node.remove(), ms);
}

const BLOCKING_CODES = new Set([
  "session_expired",
  "unauthenticated",
  "forbidden",
  "wrong_audience",
  "token_expired",
  "invalid_token",
  "access_not_configured",
  "access_keys_unavailable",
  "vapi_not_configured",
  "vapi_auth_failed",
]);

// ------------------------------------------------------------------ polling --

async function poll() {
  if (state.polling) return;
  state.polling = true;
  try {
    const data = await api.calls();
    state.skewMs = data.now - Date.now();
    state.pollError = null;
    state.fatal = null;
    updateCalls(Array.isArray(data.calls) ? data.calls : []);
  } catch (error) {
    if (BLOCKING_CODES.has(error.code)) state.fatal = error.message;
    else state.pollError = error.message;
  } finally {
    state.polling = false;
    state.loaded = true;
    render();
    schedulePoll();
  }
}

// New calls arrive over the event stream, so polling is only a safety net and
// stays slow while that stream is connected. It speeds up when the stream is
// down, because then it is the only way to notice a call at all.
// 0 disables periodic polling for that state. An explicit delay (page load,
// reconnect, an event about an unknown call, after a command) always polls.
function pollInterval() {
  let ms = state.eventsState === "connected" ? cfg.poll.liveMs : cfg.poll.fallbackMs;
  if (!(ms > 0)) return 0;
  if (document.hidden) ms *= cfg.poll.hiddenMultiplier;
  if (state.fatal) ms *= 4;
  return ms;
}

function schedulePoll(delay) {
  clearTimeout(state.pollTimer);
  const ms = delay ?? pollInterval();
  if (delay === undefined && !(ms > 0)) return;
  state.pollTimer = setTimeout(poll, ms);
}

function updateCalls(calls) {
  const firstLoad = !state.loaded;
  for (const call of calls) {
    if (!state.seen.has(call.id)) {
      state.seen.add(call.id);
      if (!firstLoad) {
        state.newIds.add(call.id);
        announceCall(call);
      }
    }
  }
  state.calls = calls;
  const ids = new Set(calls.map((c) => c.id));
  for (const id of state.newIds) if (!ids.has(id)) state.newIds.delete(id);

  if (state.selectedId) {
    const call = calls.find((c) => c.id === state.selectedId);
    if (!call) callEnded(state.selectedId, null);
    else if (call.status !== state.capsStatus) refreshCaps(false);
  }
  autoSelect();
}

function autoSelect() {
  if (state.fatal) return;
  // A call named by a clicked alert is selected even among several.
  const wanted = state.wantedCallId && state.calls.find((c) => c.id === state.wantedCallId);
  if (wanted) {
    state.wantedCallId = null;
    if (state.selectedId !== wanted.id) {
      state.ended = null;
      selectCall(wanted.id);
    }
    return;
  }
  if (state.selectedId || state.ended) return;
  if (state.calls.length === 1) selectCall(state.calls[0].id);
}

function selectCall(id) {
  if (state.selectedId === id) return;
  stopListening("call changed");
  state.selectedId = id;
  state.caps = null;
  state.capsStatus = null;
  state.dtmf = "";
  state.follow = true;
  state.hangingUp = null;
  state.newIds.delete(id);
  closeEndDialog();
  render();
  refreshCaps(true);
  promotions.load();
}

async function refreshCaps(announce) {
  const id = state.selectedId;
  if (!id || (state.capsLoading === id && !announce)) return;
  state.capsLoading = id;
  try {
    const data = await api.call(id, { select: announce });
    if (state.selectedId !== id) return;
    state.caps = data.capabilities;
    state.capsStatus = data.call.status;
    maybeAutoListen();
    const index = state.calls.findIndex((c) => c.id === id);
    if (index >= 0) state.calls[index] = { ...state.calls[index], ...data.call };
    if (data.call.status === "ended") callEnded(id, data.call.endedReason);
  } catch (error) {
    if (state.selectedId !== id) return;
    if (error.code === "call_not_found") callEnded(id, "not found");
    else if (BLOCKING_CODES.has(error.code)) state.fatal = error.message;
    else toast(`Could not load call details: ${error.message}`, "error");
  } finally {
    if (state.capsLoading === id) state.capsLoading = null;
  }
  render();
}

// The selected call ended (remote hang-up, END CALL, SAY & HANG UP, ...).
function callEnded(id, reason) {
  if (state.selectedId !== id) return;
  stopListening("call ended");
  closeEndDialog();
  state.selectedId = null;
  state.caps = null;
  state.capsStatus = null;
  state.dtmf = "";
  state.hangingUp = null;
  state.calls = state.calls.filter((c) => c.id !== id);
  state.ended = { callId: id, reason: reason || null };
  render();
  setTimeout(() => {
    if (state.ended?.callId !== id) return;
    state.ended = null;
    autoSelect();
    render();
  }, cfg.endedBannerMs);
  if (!reason) {
    api
      .call(id)
      .then((data) => {
        if (state.ended?.callId === id && data.call.endedReason) {
          state.ended.reason = data.call.endedReason;
          renderBanner();
        }
      })
      .catch(() => {});
  }
}

// A webhook event named a call the page does not know yet. Vapi's call *list*
// can lag several seconds behind a new call, but the call itself is readable
// by ID straight away — so fetch it directly instead of waiting for the list.
async function fetchCallById(callId) {
  if (!callId || state.fetchingCalls.has(callId) || state.calls.some((c) => c.id === callId)) return;
  state.fetchingCalls.add(callId);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      let data;
      try {
        data = await api.call(callId);
      } catch (error) {
        if (error.code === "call_not_found" && attempt < 2) {
          await new Promise((r) => setTimeout(r, 700)); // not visible yet, or another assistant's call
          continue;
        }
        return;
      }
      const call = data.call;
      if (!call || !["queued", "ringing", "in-progress", "forwarding"].includes(call.status)) return;
      if (state.calls.some((c) => c.id === call.id)) return;
      state.skewMs = data.now - Date.now();
      state.calls = [call, ...state.calls];
      if (!state.seen.has(call.id)) {
        state.seen.add(call.id);
        state.newIds.add(call.id);
        announceCall(call);
      }
      autoSelect();
      render();
      return;
    }
  } finally {
    state.fetchingCalls.delete(callId);
  }
}

// ----------------------------------------------------------- notifications --

// Short two-tone chime, synthesised so the page needs no audio file and no
// extra request. Browsers only allow this after the operator has interacted
// with the page, which the notification permission button takes care of.
function sharedAudio() {
  if (!state.sharedAudio) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    state.sharedAudio = new Ctx();
  }
  return state.sharedAudio;
}

// Browsers block sound until the page has been clicked once. The first click
// anywhere (or the "Enable sound" button) unlocks it for the whole session.
function unlockAudio() {
  if (state.audioUnlocked) return;
  try {
    const ctx = sharedAudio();
    ctx.resume().catch(() => {});
    state.audioUnlocked = true;
  } catch {
    return;
  }
  renderNotifyButton();
  maybeAutoListen();
}

// Ring-like chime: two bursts of a two-tone ring, loud enough to hear from
// across the room.
function playChime() {
  if (!cfg.notify.sound || !state.audioUnlocked) return;
  try {
    const ctx = sharedAudio();
    const now = ctx.currentTime + 0.02;
    for (let burst = 0; burst < 2; burst++) {
      for (let i = 0; i < 6; i++) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = i % 2 ? 1175 : 880;
        const start = now + burst * 1.1 + i * 0.09;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.6, start + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.085);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.09);
      }
    }
  } catch {
    // Audio unavailable; the visual cues still fire.
  }
}

// "Sound always on": start LISTEN by itself whenever a call is selected.
function maybeAutoListen() {
  if (!cfg.listen.autoStart || !state.audioUnlocked || state.listen) return;
  if (state.selectedId && state.caps?.listen && !state.fatal) toggleListen();
}

function announceCall(call) {
  if (state.notifiedCalls.has(call.id)) return;
  state.notifiedCalls.add(call.id);
  if (state.notifiedCalls.size > 200) state.notifiedCalls.clear();
  playChime();
  // While the operator is looking at the console, the chime is enough.
  if (!cfg.notify.desktop || window.Notification?.permission !== "granted" || (document.visibilityState === "visible" && document.hasFocus())) return;
  const who = call.customerNumber || call.customerName || directionLabel(call.direction);
  const options = { body: `${who} · ${statusLabel(call.status)}`, tag: call.id, renotify: false, icon: "icons/icon-192.png", data: { url: `./?call=${call.id}`, callId: call.id } };
  // Same tag as the Web Push alert for this call, so it never shows twice.
  if (state.swReg) {
    state.swReg.showNotification("📞 Incoming call", options).catch(() => {});
    return;
  }
  try {
    const note = new Notification("📞 Incoming call", options);
    note.onclick = () => {
      window.focus();
      selectCall(call.id);
      note.close();
    };
  } catch {
    // Android Chrome has no Notification constructor (service worker only).
  }
}

function updateTitle() {
  if (!cfg.notify.titleBadge) return;
  const active = state.calls.length;
  document.title = active > 0 ? `(${active}) Vapi Live Control` : "Vapi Live Control";
}

async function askNotifyPermission() {
  unlockAudio();
  if (window.Notification && cfg.notify.desktop && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      // Older browsers use the callback form; ignore.
    }
  }
  // Same click also turns on alerts for when the console is closed.
  if (window.Notification?.permission === "granted" && canPush() && !state.pushOn) await turnOnPush({ quiet: true });
  renderNotifyButton();
}

function renderNotifyButton() {
  const notifyPending = Boolean(window.Notification) && cfg.notify.desktop && Notification.permission === "default";
  el.enableNotify.hidden = state.audioUnlocked && !notifyPending;
  // A call is waiting and it is silent: make the button impossible to miss.
  el.enableNotify.classList.toggle("attention", !state.audioUnlocked && state.calls.length > 0);
  el.alertsBtn.hidden = !cfg.notify.push || !state.pushKey;
  el.alertsBtn.textContent = state.pushOn ? "🔔 Alerts on" : "🔕 Alerts off";
  el.alertsBtn.classList.toggle("attention", !state.pushOn && Boolean(state.pushKey) && !notifyPending);
  el.installBtn.hidden = !state.installPrompt;
}

// ------------------------------------------------ alerts (web push) + install --

function canPush() {
  return Boolean(cfg.notify.push && state.pushKey && state.swReg && pushSupported());
}

async function turnOnPush({ quiet = false } = {}) {
  if (!canPush()) return false;
  try {
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") {
      if (!quiet) toast("Notifications are blocked for this site. Allow them in the browser's site settings, then try again.", "error", 9000);
      return false;
    }
    await enablePush(api, state.swReg, state.pushKey);
    state.pushOn = true;
    if (!quiet) toast("Call alerts are on for this device.", "ok", 3000);
    return true;
  } catch (error) {
    if (!quiet) toast(`Could not turn on alerts: ${error.message}`, "error", 8000);
    return false;
  } finally {
    renderNotifyButton();
    renderAlertsDialog();
  }
}

// Keeps this device's subscription registered with the Worker on every
// visit (the server forgets devices whose push service reports them gone).
async function renewPush() {
  if (!canPush() || Notification.permission !== "granted") return;
  const sub = await currentSubscription(state.swReg);
  if (!sub) return; // never turned on here, or turned off: stay off
  await turnOnPush({ quiet: true });
}

async function sendTestAlert() {
  const sub = await currentSubscription(state.swReg);
  if (!sub) {
    toast("Turn on alerts first.", "error");
    return;
  }
  try {
    let res = await api.pushTest(sub.endpoint);
    // The server does not know this device (yet): register it and try once more.
    if (res.configured !== false && (res.results || []).length === 0) {
      await enablePush(api, state.swReg, state.pushKey);
      res = await api.pushTest(sub.endpoint);
    }
    const answer = (res.results || []).map((r) => `${r.host}: ${r.status ? `HTTP ${r.status}` : r.error || "no answer"}`).join(", ");
    if (res.sent > 0) toast("Test alert sent — it should appear in a few seconds. Close the console to see it arrive without it.", "ok", 7000);
    else if (res.configured === false) toast("Push alerts are not configured on the server (VAPID keys).", "error", 9000);
    else toast(`The test alert was not delivered (${answer || "this device is not registered"}). Turn alerts off and on again.`, "error", 10000);
  } catch (error) {
    toast(`Test alert failed: ${error.message}`, "error", 8000);
  }
}

async function turnOffPush() {
  await disablePush(api, state.swReg);
  state.pushOn = false;
  toast("Call alerts are off for this device.", "ok", 3000);
  renderNotifyButton();
  renderAlertsDialog();
}

function renderAlertsDialog() {
  if (!el.alertsDialog.open) return;
  const permission = window.Notification ? Notification.permission : "unsupported";
  const rows = [
    ["This device", state.pushOn ? ["Alerts on", "ok"] : ["Alerts off", "bad"]],
    ["Notifications", permission === "granted" ? ["Allowed", "ok"] : permission === "denied" ? ["Blocked in browser settings", "bad"] : permission === "default" ? ["Not asked yet", ""] : ["Not supported here", "bad"]],
    ["Opened as", isStandalone() ? ["Installed app", "ok"] : ["Browser tab", ""]],
  ];
  el.alertsStatus.replaceChildren(
    ...rows.flatMap(([label, [value, cls]]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      if (cls) dd.className = cls;
      return [dt, dd];
    }),
  );
  let hint = "Alerts use the device's notification sound. They arrive while the browser is running in the background, even with this console closed.";
  if (isIos() && !isStandalone()) hint = "iPhone/iPad: tap Share → Add to Home Screen, open Vapi Control from the Home Screen, then turn on alerts there. iOS delivers web alerts only to Home Screen apps.";
  else if (!pushSupported()) hint = "This browser cannot receive alerts with the console closed. Use Chrome, Edge, Firefox or Safari (iOS 16.4+ from the Home Screen).";
  else if (permission === "denied") hint = "Notifications were blocked for this site. Allow them in the browser's site settings (lock icon next to the address), then turn alerts on.";
  el.alertsHint.textContent = hint;
  el.alertsEnable.hidden = state.pushOn;
  el.alertsEnable.disabled = !canPush() || permission === "denied";
  el.alertsTest.hidden = !state.pushOn;
  el.alertsDisable.hidden = !state.pushOn;
}

function openAlertsDialog() {
  unlockAudio();
  el.alertsDialog.showModal();
  renderAlertsDialog();
}

async function installApp() {
  const prompt = state.installPrompt;
  if (!prompt) return;
  state.installPrompt = null;
  renderNotifyButton();
  try {
    await prompt.prompt();
  } catch {
    // dismissed
  }
}

async function initAlerts(session) {
  state.pushKey = cfg.notify.push ? session?.push?.publicKey || null : null;
  state.swReg = await registerServiceWorker();
  if (state.swReg) {
    const sub = await currentSubscription(state.swReg);
    state.pushOn = Boolean(sub && window.Notification?.permission === "granted");
  }
  renderNotifyButton();
  renewPush().catch(() => {});
}

// ------------------------------------------------------------ event stream --

const events = new EventsClient({
  url: api.eventsUrl(),
  onState: (s) => {
    const was = state.eventsState;
    state.eventsState = s;
    // Catch up once whenever the stream (re)connects, then rely on events.
    if (s === "connected" && was !== "connected") schedulePoll(0);
    else if (was === "connected" && s !== "connected") schedulePoll();
    renderEventsPill();
    renderTranscript();
  },
  onMessage: (msg) => {
    const affected = applyHubMessage(store, msg);
    if (!affected) return;
    if (affected === "*") for (const id of store.calls.keys()) state.hubSeen.add(id);
    else state.hubSeen.add(affected);

    const id = state.selectedId;
    if (id && (affected === "*" || affected === id)) {
      const st = store.calls.get(id);
      if (st?.status === "ended") {
        callEnded(id, st.endedReason);
        return;
      }
      if (st?.status === "in-progress" && state.capsStatus && state.capsStatus !== "in-progress") refreshCaps(false);
    }
    // With no periodic polling, the event stream is what retires calls: an
    // ended call that is not the selected one leaves the list here.
    const endedId = msg.type === "state" && msg.call?.status === "ended" ? msg.call.callId : null;
    if (endedId && endedId !== state.selectedId && state.calls.some((c) => c.id === endedId)) {
      state.calls = state.calls.filter((c) => c.id !== endedId);
      state.newIds.delete(endedId);
      autoSelect();
      render();
    }
    // Any event about a call we don't know yet: fetch that call right away.
    const eventCallId = msg.callId || msg.call?.callId;
    const hubState = eventCallId ? store.calls.get(eventCallId) : null;
    if (eventCallId && hubState?.status !== "ended" && !state.calls.some((c) => c.id === eventCallId)) {
      fetchCallById(eventCallId);
    }
    if (affected === "*" || affected === id) {
      renderTranscript();
      // Operator mode may have been switched from another device.
      if (msg.type === "state" || msg.type === "snapshot") {
        checkDtmfWatch();
        renderMode();
        renderControls();
      }
    }
  },
});

// ------------------------------------------------------------------ listen --

function toggleListen() {
  if (state.listen) {
    stopListening("stopped by operator");
    return;
  }
  const id = state.selectedId;
  if (!id || !state.caps?.listen) return;
  const player = new ListenPlayer({
    url: api.listenUrl(id),
    formatKey: state.audioFormatKey,
    volume: state.volume,
    shouldReconnect: () => state.selectedId === id && state.calls.some((c) => c.id === id),
    onState: (s, detail) => {
      if (state.listen?.player !== player) return;
      state.audioState = s;
      state.audioDetail = detail || "";
      if ((s === "error" || s === "disconnected") && player.stopped) state.listen = null;
      renderAudio();
    },
    onFormat: (format) => {
      if (state.listen?.player !== player) return;
      state.audioFormat = format;
      renderAudio();
    },
  });
  state.listen = { player, callId: id };
  state.audioFormat = null;
  player.start().catch((error) => {
    toast(`Audio could not start: ${error.message}`, "error");
    stopListening("error");
  });
  renderAudio();
}

function stopListening(reason) {
  const current = state.listen;
  state.listen = null;
  if (current) current.player.stop(reason);
  state.audioState = "disconnected";
  state.audioDetail = "";
  renderAudio();
}

// ---------------------------------------------------------------- commands --

const COMMAND_LABELS = { say: "Say", sayHangup: "Say & hang up", instruction: "AI instruction", mode: "Operator mode", dtmf: "DTMF", end: "End call" };

async function command(name, fn, successMessage) {
  const callId = state.selectedId;
  if (!callId || state.busy.has(name)) return false;
  state.busy.add(name);
  renderControls();
  try {
    await fn(callId);
    if (successMessage) toast(successMessage, "ok", 2500);
    return true;
  } catch (error) {
    const label = COMMAND_LABELS[name] || name;
    if (error.code === "call_ended" || error.code === "call_not_found") {
      toast(`${label}: the call has already ended.`, "error");
      callEnded(callId, error.details?.endedReason || null);
    } else {
      if (BLOCKING_CODES.has(error.code)) state.fatal = error.message;
      toast(`${label} failed: ${error.message}`, "error", 7000);
    }
    return false;
  } finally {
    state.busy.delete(name);
    render();
  }
}

function fill(template, values) {
  let out = String(template || "");
  for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(value);
  return out;
}

// The caller hears `text`. Russian (non-Latin) text is translated on the
// server and the English line is spoken verbatim; the server also unmutes
// the assistant for the line in operator mode and mutes it again afterwards.
async function say(text, { hangUp = false, translate = el.translateSay.checked, heard = null } = {}) {
  const content = String(text || "").trim();
  if (!content) return false;
  let result = null;
  const ok = await command(hangUp ? "sayHangup" : "say", async (id) => {
    try {
      result = await api.say(id, content, {
        endCallAfterSpoken: hangUp,
        interruptAssistant: el.interruptBot.checked,
        translate,
        language: cfg.say.translate.targetLanguage,
      });
    } catch (error) {
      // Translation service down: let the call's own model translate and
      // speak it (not possible together with hang-up).
      if (hangUp || !["translate_failed", "ai_unavailable"].includes(error.code)) throw error;
      const prompt = fill(cfg.say.translate.template, { text: content, language: cfg.say.translate.targetLanguage });
      await api.instruction(id, prompt, { line: true });
      result = { viaModel: true };
    }
  });
  if (!ok) return false;
  if (result?.viaModel) {
    toast(`Translation service unavailable — the assistant will say it in ${cfg.say.translate.targetLanguage} itself.`, "info", 6000);
    state.lastLine = { heard: heard || content, spoken: null };
  } else {
    state.lastLine = { heard: result?.translated ? heard || content : heard, spoken: result?.spoken || content };
    toast(hangUp ? `Saying “${state.lastLine.spoken}”, then hanging up…` : `Saying: “${state.lastLine.spoken}”`, "ok", 3500);
  }
  renderLastLine();
  if (hangUp) {
    state.hangingUp = state.selectedId;
    render();
    schedulePoll(1500);
  }
  return true;
}

async function sayFromInput(hangUp) {
  const ok = await say(el.sayText.value, { hangUp });
  if (ok && cfg.say.clearAfterSend) el.sayText.value = "";
  renderControls();
}

async function sendInstruction() {
  const instruction = el.instructionText.value.trim();
  if (!instruction) return;
  const text = fill(cfg.aiInstruction.template || "{instruction}", { instruction });
  const ok = await command("instruction", (id) => api.instruction(id, text), "Instruction sent to the AI.");
  if (ok && cfg.aiInstruction.clearAfterSend) el.instructionText.value = "";
  renderControls();
}

// Operator mode. Vapi has no "hand over to a human" switch, so the assistant is
// told, for this call only, to stop improvising and wait for dictated lines
// (inserted without triggering a reply), and is muted. The server keeps the
// mode, so every device sees it.
async function toggleOperatorMode() {
  const id = state.selectedId;
  if (!id) return;
  const goingManual = !isManual(id);
  const text = goingManual ? cfg.operatorMode.enterText : cfg.operatorMode.leaveText;
  if (!text) {
    toast("Operator mode text is not configured (config.js → operatorMode).", "error");
    return;
  }
  const ok = await command(
    "mode",
    (callId) => api.mode(callId, { operator: goingManual, text, mute: cfg.operatorMode.useMute !== false }),
    goingManual ? "You are driving the call — the assistant is muted." : "Handed back to the assistant.",
  );
  if (!ok) return;
  // The hub broadcasts the change too; set it now so the button flips at once.
  const st = store.calls.get(id);
  if (st) st.operator = goingManual;
  else applyHubMessage(store, { type: "state", call: { callId: id, operator: goingManual } });
  render();
}

// -------------------------------------------------------------- dictation --

function setDictation(phase, status = "", error = false) {
  state.dictation.phase = phase;
  state.dictation.status = status;
  state.dictation.error = error;
  renderDictation();
}

async function toggleDictation() {
  const d = state.dictation;
  if (d.phase === "recording") return finishDictation();
  if (d.phase !== "idle") return;
  unlockAudio();
  const recorder = new Recorder({ maxMs: (cfg.dictation.maxSeconds || 45) * 1000, onLimit: () => finishDictation() });
  d.recorder = recorder;
  setDictation("starting", "Starting microphone…");
  try {
    await recorder.start();
  } catch (error) {
    d.recorder = null;
    const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
    setDictation("idle", denied ? "Microphone access is blocked. Allow the microphone for this site (lock icon next to the address) and try again." : `Microphone unavailable: ${error?.message || error}`, true);
    return;
  }
  if (d.recorder !== recorder) return; // cancelled while starting
  setDictation("recording");
  clearInterval(d.timer);
  d.timer = setInterval(renderDictation, 250);
}

function cancelDictation() {
  const d = state.dictation;
  clearInterval(d.timer);
  d.recorder?.cancel();
  d.recorder = null;
  setDictation("idle", "Recording discarded.");
}

async function finishDictation() {
  const d = state.dictation;
  if (d.phase !== "recording" || !d.recorder) return;
  clearInterval(d.timer);
  const recorder = d.recorder;
  const tooShort = recorder.elapsedMs() < 600;
  const silent = recorder.heardOnlySilence();
  d.recorder = null;
  setDictation("working", "Recognizing…");
  const blob = await recorder.stop().catch(() => null);
  if (tooShort || !blob || blob.size < 800) {
    setDictation("idle", "Too short — tap DICTATE, speak, then tap again to send.", true);
    return;
  }
  if (silent) {
    setDictation(
      "idle",
      "The microphone delivered only silence. On a phone this happens during a regular phone call: Android and iOS give the microphone to the call and other apps get silence. Dictate from another device, or end the phone call.",
      true,
    );
    return;
  }
  let heard = "";
  try {
    heard = (await api.transcribe(blob, cfg.dictation.language)).text.trim();
  } catch (error) {
    setDictation("idle", `Speech recognition failed: ${error.message}`, true);
    return;
  }
  if (!heard) {
    setDictation("idle", "Nothing was recognised. Try again, a little closer to the microphone.", true);
    return;
  }
  // Send straight to the caller, or leave it in the box to edit first.
  if (!state.autoSend || !canControl()) {
    el.sayText.value = heard;
    renderControls();
    setDictation("idle", canControl() ? "Check the text, then press SAY." : "No call to speak to — the text is in the box.");
    return;
  }
  setDictation("working", `Sending: ${heard}`);
  const ok = await say(heard, { translate: true, heard });
  if (ok) setDictation("idle", "");
  else {
    // Keep what was said so it is not lost.
    el.sayText.value = heard;
    renderControls();
    setDictation("idle", "Not sent — the text is in the box.", true);
  }
}

function dtmfSequence(keys) {
  const pause = String(cfg.dtmf.pauseBetweenDigits || "");
  return pause ? keys.split("").join(pause) : keys;
}

// Keys pile up while the operator types and go out together a moment after
// the last press (or at once with SEND DTMF): one tool call per sequence.
function queueDtmf(key) {
  if (state.dtmf.length < (cfg.dtmf.maxLength || 32)) state.dtmf += key;
  clearTimeout(state.dtmfTimer);
  const ms = Number(cfg.dtmf.autoSendAfterMs) || 0;
  if (ms > 0) state.dtmfTimer = setTimeout(flushDtmf, ms);
  renderControls();
}

async function flushDtmf() {
  clearTimeout(state.dtmfTimer);
  if (state.busy.has("dtmf")) {
    state.dtmfTimer = setTimeout(flushDtmf, 300);
    return;
  }
  const keys = state.dtmf;
  if (!keys) return;
  state.dtmf = "";
  const ok = await sendDtmf(keys);
  if (!ok) state.dtmf = keys + state.dtmf; // keep them for another try
  renderControls();
}

const isDtmfToolLine = (m) => m.role === "tool" && /\bdtmf\b/i.test(m.text);

async function sendDtmf(keys) {
  if (!keys) return false;
  const callId = state.selectedId;
  const before = (store.calls.get(callId)?.messages || []).filter(isDtmfToolLine).length;
  const ok = await command("dtmf", (id) => api.dtmf(id, dtmfSequence(keys)), `Keys ${keys} passed to the assistant — waiting for it to press them…`);
  renderControls();
  if (!ok) return false;
  // Vapi cannot send operator DTMF itself; the model has to call its dtmf
  // tool. Watch the call log for that tool call and tell the operator.
  clearTimeout(state.dtmfWatch?.timer);
  const watch = { callId, keys, before, timer: null };
  watch.timer = setTimeout(() => {
    if (state.dtmfWatch !== watch) return;
    state.dtmfWatch = null;
    toast(`The assistant did not press ${keys}: no dtmf tool call appeared in the call log. Try again — Vapi can send tones only through the assistant's own dtmf tool.`, "error", 12000);
  }, (Number(cfg.dtmf.confirmWithinSeconds) || 12) * 1000);
  state.dtmfWatch = watch;
  checkDtmfWatch();
  return true;
}

function checkDtmfWatch() {
  const watch = state.dtmfWatch;
  if (!watch) return;
  const count = (store.calls.get(watch.callId)?.messages || []).filter(isDtmfToolLine).length;
  if (count <= watch.before) return;
  clearTimeout(watch.timer);
  state.dtmfWatch = null;
  toast(`✓ The assistant pressed ${watch.keys}.`, "ok", 4000);
}

function openEndDialog() {
  const call = selectedCall();
  if (!call) return;
  state.endTarget = call.id;
  el.endDialogMeta.textContent = `${call.id}\n${directionLabel(call.direction)}${call.customerNumber ? ` · ${call.customerNumber}` : ""} · ${statusLabel(call.status)}`;
  if (typeof el.endDialog.showModal === "function") el.endDialog.showModal();
  else if (window.confirm(`End this call?\n${call.id}`)) confirmEnd();
  el.endCancel.focus();
}

function closeEndDialog() {
  state.endTarget = null;
  if (el.endDialog.open) el.endDialog.close();
}

async function confirmEnd() {
  const target = state.endTarget;
  closeEndDialog();
  if (!target || target !== state.selectedId) {
    toast("Selection changed — call was NOT ended. Try again.", "error");
    return;
  }
  const ok = await command("end", (id) => api.end(id), "Call ended.");
  if (ok) callEnded(target, "ended by operator");
}

// --------------------------------------------------------------- rendering --

function render() {
  renderNotifyButton();
  updateTitle();
  renderMode();
  renderHeader();
  renderBanner();
  renderCallList();
  renderTarget();
  renderControls();
  renderAudio();
  renderTranscript();
  renderEventsPill();
}

function renderHeader() {
  const call = selectedCall();
  let mode = "idle";
  let text = "NO ACTIVE CALL";
  if (state.fatal) {
    mode = "error";
    text = "NOT READY";
  } else if (call) {
    mode = call.status === "in-progress" ? "active" : "pending";
    text = statusLabel(call.status);
  } else if (state.ended) {
    mode = "ended";
    text = "CALL ENDED";
  } else if (state.calls.length > 1) {
    mode = "pending";
    text = `${state.calls.length} ACTIVE CALLS`;
  } else if (!state.loaded) {
    mode = "loading";
    text = "CONNECTING…";
  }
  el.callState.dataset.state = mode;
  el.callStateText.textContent = text;
  tick();
}

// What the listen stream is actually doing — tells "nothing arrives" apart
// from "arrives but is not played".
function audioDiagnostics() {
  const stats = state.listen?.player.stats();
  if (!stats) return "";
  const kb = (stats.bytesReceived / 1024).toFixed(0);
  if (state.audioState === "connected" && stats.bytesReceived === 0) return "connected, no audio arriving yet";
  const parts = [`${kb} KB received`];
  if (stats.format) parts.push(describeFormat(stats.format) + (stats.format.source === "auto" ? " (auto)" : ""));
  else if (stats.bytesReceived > 0) parts.push("detecting format…");
  if (stats.contextState !== "running") parts.push(`audio ${stats.contextState} — click the page`);
  return parts.join(" · ");
}

function tick() {
  if (state.listen) el.audioFormatInfo.textContent = audioDiagnostics();
  const call = selectedCall();
  const elapsed = call ? callElapsedMs(call, Date.now(), state.skewMs) : null;
  el.timer.textContent = elapsed === null ? "--:--" : formatDuration(elapsed);
  for (const node of el.callRows.querySelectorAll("[data-started]")) {
    const ms = callElapsedMs({ startedAt: node.dataset.started }, Date.now(), state.skewMs);
    node.textContent = ms === null ? "--:--" : formatDuration(ms);
  }
}

function renderBanner() {
  let cls = "";
  let text = "";
  if (state.fatal) {
    cls = "error";
    text = state.fatal;
  } else if (state.ended) {
    cls = "ended";
    text = `CALL ENDED${state.ended.reason ? ` — ${state.ended.reason}` : ""}`;
  } else if (state.hangingUp && state.hangingUp === state.selectedId) {
    cls = "info";
    text = "Speaking the final message — the call will hang up when it finishes.";
  } else if (state.pollError) {
    cls = "error";
    text = `${state.pollError} Retrying…`;
  }
  el.banner.hidden = !text;
  el.banner.className = `banner ${cls}`;
  el.banner.textContent = text;
}

function renderCallList() {
  const calls = state.calls;
  const show = calls.length > 1 || (calls.length === 1 && !state.selectedId && !state.ended);
  el.callList.hidden = !show;
  if (!show) {
    el.callRows.replaceChildren();
    return;
  }
  el.callListHint.textContent = state.selectedId ? "" : "Select the call to monitor and control";
  const rows = calls.map((call) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "call-row";
    row.dataset.callId = call.id;
    row.setAttribute("aria-pressed", String(call.id === state.selectedId));
    const id = document.createElement("span");
    const code = document.createElement("code");
    code.textContent = shortId(call.id);
    code.title = call.id;
    id.appendChild(code);
    if (state.newIds.has(call.id)) {
      const badge = document.createElement("span");
      badge.className = "badge-new";
      badge.textContent = "NEW";
      id.appendChild(badge);
    }
    const dir = document.createElement("span");
    dir.className = "dir";
    dir.textContent = directionLabel(call.direction);
    const num = document.createElement("span");
    num.textContent = call.customerNumber || call.customerName || "—";
    const dur = document.createElement("span");
    dur.className = "dur";
    if (call.startedAt) dur.dataset.started = call.startedAt;
    dur.textContent = "--:--";
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = statusLabel(call.status);
    const action = document.createElement("span");
    action.className = "select";
    action.textContent = call.id === state.selectedId ? "Selected" : "Select";
    row.append(id, dir, num, dur, status, action);
    row.addEventListener("click", () => selectCall(call.id));
    return row;
  });
  el.callRows.replaceChildren(...rows);
  tick();
}

function renderTarget() {
  const call = selectedCall();
  el.target.classList.toggle("none", !call);
  if (!call) {
    el.targetId.textContent = state.calls.length > 1 ? "— select a call above —" : "— no call selected —";
    el.targetMeta.textContent = "";
    return;
  }
  el.targetId.textContent = call.id;
  const parts = [directionLabel(call.direction), call.customerNumber || call.customerName, statusLabel(call.status)];
  if (call.assistantName) parts.push(call.assistantName);
  el.targetMeta.textContent = parts.filter(Boolean).join(" · ");
}

function renderControls() {
  const control = canControl();
  const call = selectedCall();
  el.sayBtn.disabled = !control || !el.sayText.value.trim() || state.busy.has("say") || state.busy.has("sayHangup");
  el.sayHangupBtn.disabled = !control || !el.sayText.value.trim() || state.busy.has("sayHangup") || state.busy.has("say");
  el.instructionBtn.disabled = !control || !el.instructionText.value.trim() || state.busy.has("instruction");
  el.sayBtn.classList.toggle("busy", state.busy.has("say"));
  el.sayHangupBtn.classList.toggle("busy", state.busy.has("sayHangup"));
  el.instructionBtn.classList.toggle("busy", state.busy.has("instruction"));
  el.endCallBtn.disabled = !call || !call.controlAvailable || state.busy.has("end") || Boolean(state.fatal);
  el.endCallBtn.classList.toggle("busy", state.busy.has("end"));
  for (const btn of el.quickPhrases.querySelectorAll("button")) btn.disabled = !control || state.busy.has("say") || state.busy.has("sayHangup");
  renderDictation();

  const dtmfTool = Boolean(state.caps?.dtmf?.viaAssistantTool);
  const dtmfEnabled = control && dtmfTool;
  // Keys stay usable while a sequence is being sent: new ones queue up.
  for (const btn of el.keypad.querySelectorAll("button")) btn.disabled = !dtmfEnabled;
  el.dtmfClear.disabled = !dtmfEnabled || !state.dtmf;
  el.dtmfSend.disabled = !dtmfEnabled || !state.dtmf || state.busy.has("dtmf");
  el.dtmfSend.hidden = Boolean(cfg.dtmf.sendOnPress);
  el.dtmfDisplay.textContent = state.dtmf;
  el.dtmfState.dataset.state = dtmfTool ? "on" : "off";
  el.dtmfState.textContent = dtmfTool ? "via assistant dtmf tool" : "NOT SUPPORTED BY VAPI";
  el.dtmfNote.textContent = !call
    ? ""
    : dtmfTool
      ? `Keys go out ${Number(cfg.dtmf.autoSendAfterMs) > 0 ? `${(cfg.dtmf.autoSendAfterMs / 1000).toFixed(1)} s after the last press (or with SEND DTMF)` : "with SEND DTMF"}. Vapi has no operator DTMF command, so the assistant's dtmf tool presses them — takes a few seconds; the console confirms when it happened.`
      : "Vapi's live call control API cannot send operator DTMF. To enable this keypad, add Vapi's built-in DTMF tool to the assistant (see README).";
}

function renderMode() {
  const manual = isManual(state.selectedId);
  document.body.classList.toggle("manual-mode", manual);
  el.modeBtn.disabled = !canControl() || state.busy.has("mode");
  el.modeBtn.classList.toggle("on", manual);
  el.modeBtn.textContent = manual ? "HAND BACK TO ASSISTANT" : "TAKE OVER";
  el.modeState.dataset.state = manual ? "reconnecting" : "auto";
  el.modeState.textContent = manual ? "You (operator)" : "Assistant (auto)";
  el.modeNote.textContent = manual
    ? "The assistant is muted and told to stay silent. Each line you SAY or DICTATE unmutes it just long enough to speak, then it is muted again."
    : "The assistant answers on its own. Take over and it stays silent — then everything the caller hears comes from SAY TO CALLER.";
}

function renderDictation() {
  const d = state.dictation;
  const supported = dictationSupported() && state.session?.dictation !== false;
  const recording = d.phase === "recording";
  el.micBtn.disabled = !supported || d.phase === "starting" || d.phase === "working" || Boolean(state.fatal);
  el.micBtn.classList.toggle("recording", recording);
  el.micBtn.classList.toggle("working", d.phase === "starting" || d.phase === "working");
  el.micBtn.setAttribute("aria-pressed", String(recording));
  el.micCancel.hidden = !recording;
  el.micLevel.hidden = !recording || !d.recorder?.meter;
  if (recording) el.micLevelBar.style.width = `${Math.min(100, Math.round((d.recorder?.level || 0) * 600))}%`;
  if (recording) {
    const s = Math.floor((d.recorder?.elapsedMs() || 0) / 1000);
    const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    el.micLabel.textContent = `${state.autoSend && canControl() ? "TAP TO SEND" : "TAP TO STOP"} · ${clock}`;
  } else if (d.phase === "working" || d.phase === "starting") {
    el.micLabel.textContent = d.phase === "starting" ? "STARTING…" : "WORKING…";
  } else {
    el.micLabel.textContent = "DICTATE";
  }
  let status = d.status;
  if (!supported && !status) status = state.session?.dictation === false ? "Dictation is not configured on the server (Workers AI)." : "This browser cannot record audio here.";
  if (recording && !status) {
    const spoken = { ru: "Russian", uk: "Ukrainian", en: "English" }[String(cfg.dictation.language).split("-")[0]];
    status = `● Recording — ${spoken ? `speak ${spoken}, ` : ""}the caller hears ${cfg.say.translate.targetLanguage}.`;
  }
  el.micStatus.textContent = status;
  el.micStatus.classList.toggle("error", Boolean(d.error));
}

function renderLastLine() {
  const line = state.lastLine;
  el.lastLine.hidden = !line;
  if (!line) return;
  const parts = [];
  if (line.heard) parts.push(document.createTextNode(`${line.heard} → `));
  const spoken = document.createElement("strong");
  spoken.textContent = line.spoken ? `“${line.spoken}”` : `(the assistant translates it)`;
  parts.push(spoken);
  el.lastLine.replaceChildren(...parts);
}

function renderAudio() {
  const listening = Boolean(state.listen);
  const call = selectedCall();
  el.listenBtn.textContent = listening ? "STOP LISTENING" : "LISTEN";
  el.listenBtn.disabled = !listening && !(call && state.caps?.listen && !state.fatal);
  el.listenBtn.classList.toggle("primary", listening);
  const labels = {
    connected: "● Connected",
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    disconnected: "Disconnected",
    error: "Error",
  };
  const s = listening ? state.audioState : state.audioState === "error" ? "error" : "disconnected";
  el.audioState.dataset.state = s;
  el.audioState.textContent = `${labels[s] || s}${state.audioDetail && (s === "error" || s === "reconnecting") ? ` (${state.audioDetail})` : ""}`;
  // Say *why* LISTEN is off, instead of a silently greyed-out button.
  if (!listening && call && state.caps && !state.caps.listen) {
    el.audioState.dataset.state = "error";
    el.audioState.textContent = call.listenAvailable ? "Unavailable for this call" : "Listening disabled in Vapi (no listen URL)";
  }
  el.audioFormatInfo.textContent = listening ? audioDiagnostics() : "";
}

function renderEventsPill() {
  const labels = { connected: "Events: live", connecting: "Events: connecting", reconnecting: "Events: reconnecting", offline: "Events: offline" };
  el.eventsPill.dataset.state = state.eventsState;
  el.eventsPill.textContent = labels[state.eventsState] || `Events: ${state.eventsState}`;
}

function emptyState(title, detail) {
  const box = document.createElement("div");
  box.className = "empty";
  const strong = document.createElement("strong");
  strong.textContent = title;
  box.appendChild(strong);
  if (detail) {
    const p = document.createElement("div");
    p.textContent = detail;
    box.appendChild(p);
  }
  return box;
}

function messageNode(item) {
  const node = document.createElement("div");
  node.dataset.key = item.key;
  const who = document.createElement("div");
  who.className = "who";
  const label = document.createElement("span");
  const time = document.createElement("time");
  who.append(label, time);
  const text = document.createElement("div");
  text.className = "text";
  node.append(who, text);
  updateMessageNode(node, item);
  return node;
}

function updateMessageNode(node, item) {
  node.className = `msg ${item.role} ${item.kind}`;
  const [label, time] = node.firstChild.children;
  label.textContent = cfg.labels[item.role] || item.role.toUpperCase();
  time.textContent = item.time ? clockTime(item.time) : "";
  if (node.lastChild.textContent !== item.text) node.lastChild.textContent = item.text;
}

function renderTranscript() {
  const box = el.transcript;
  const id = state.selectedId;
  const st = id ? store.calls.get(id) : null;
  const speaking = speakingRoles(st).map((r) => `${cfg.labels[r] || r} speaking`);
  el.speaking.textContent = speaking.join(" · ");

  if (!id) {
    el.jumpLatest.hidden = true;
    let title = "NO ACTIVE CALL";
    let detail = "The console detects new calls automatically.";
    if (state.fatal) {
      title = "NOT READY";
      detail = state.fatal;
    } else if (state.ended) {
      title = "CALL ENDED";
      detail = state.ended.reason || "";
    } else if (state.calls.length > 1) {
      title = "SELECT A CALL";
      detail = `${state.calls.length} calls are active. Choose one above.`;
    } else if (!state.loaded) {
      title = "CONNECTING…";
      detail = "";
    }
    box.replaceChildren(emptyState(title, detail));
    return;
  }

  const items = transcriptView(st);
  if (!items.length) {
    let detail = "Waiting for the conversation…";
    if (state.eventsState !== "connected") detail = "Live event stream is not connected — transcript unavailable right now.";
    else if (!state.hubSeen.has(id)) detail = "No transcript events for this call yet. Live transcript requires the Vapi Server URL to point at the webhook Worker (see README).";
    box.replaceChildren(emptyState("LIVE TRANSCRIPT", detail));
    return;
  }

  const hadEmpty = box.querySelector(".empty");
  if (hadEmpty) box.replaceChildren();
  const existing = new Map();
  for (const child of [...box.children]) {
    if (child.dataset.key) existing.set(child.dataset.key, child);
    else child.remove();
  }
  const previousCount = box.children.length;
  items.forEach((item, index) => {
    let node = existing.get(item.key);
    if (node) {
      existing.delete(item.key);
      updateMessageNode(node, item);
    } else {
      node = messageNode(item);
    }
    if (box.children[index] !== node) box.insertBefore(node, box.children[index] || null);
  });
  for (const node of existing.values()) node.remove();

  if (state.follow) {
    box.scrollTop = box.scrollHeight;
    el.jumpLatest.hidden = true;
  } else if (box.children.length !== previousCount || items.some((i) => i.kind !== "final")) {
    el.jumpLatest.hidden = false;
  }
}

function currentPhrases() {
  return Array.isArray(state.phrases) ? state.phrases : Array.isArray(cfg.quickPhrases) ? cfg.quickPhrases : [];
}

function renderQuickPhrases() {
  const phrases = currentPhrases();
  const buttons = phrases
    .filter((p) => p && typeof p.text === "string" && p.text.trim())
    .map((phrase) => {
      const hangUp = phrase.action === "say-and-hang-up";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `btn${hangUp ? " hangup" : ""}`;
      btn.textContent = phrase.label || phrase.text;
      btn.title = `${hangUp ? "Say, then hang up: " : "Say: "}${phrase.text}`;
      let armedUntil = 0;
      let disarmTimer = null;
      btn.addEventListener("click", async () => {
        if (hangUp && phrase.confirm && Date.now() > armedUntil) {
          armedUntil = Date.now() + 3000;
          btn.classList.add("armed");
          btn.textContent = "Click again to hang up";
          clearTimeout(disarmTimer);
          disarmTimer = setTimeout(() => {
            btn.classList.remove("armed");
            btn.textContent = phrase.label || phrase.text;
          }, 3000);
          return;
        }
        armedUntil = 0;
        clearTimeout(disarmTimer);
        btn.classList.remove("armed");
        btn.textContent = phrase.label || phrase.text;
        // Quick phrases are already written in the call's language.
        await say(phrase.text, { hangUp, translate: false });
      });
      return btn;
    });
  el.quickPhrases.replaceChildren(...buttons);
}

// ----------------------------------------------------------------- binding --

function bindUi() {
  el.listenBtn.addEventListener("click", toggleListen);
  el.volume.value = String(state.volume);
  el.volume.addEventListener("input", () => {
    state.volume = Number(el.volume.value);
    savePref("volume", state.volume);
    state.listen?.player.setVolume(state.volume);
  });
  el.audioFormat.value = state.audioFormatKey;
  el.audioFormat.addEventListener("change", () => {
    state.audioFormatKey = el.audioFormat.value in FORMAT_PRESETS ? el.audioFormat.value : "auto";
    savePref("audioFormat", state.audioFormatKey);
    state.audioFormat = null;
    state.listen?.player.setFormatKey(state.audioFormatKey);
    renderAudio();
  });

  el.interruptBot.checked = Boolean(cfg.say.interruptAssistantByDefault);
  el.translateSay.checked = Boolean(cfg.say.translate.enabledByDefault);
  el.translateLang.textContent = cfg.say.translate.targetLanguage;
  el.autoSendDictation.checked = state.autoSend;
  el.autoSendDictation.addEventListener("change", () => {
    state.autoSend = el.autoSendDictation.checked;
    savePref("autoSendDictation", state.autoSend ? "1" : "0");
    renderDictation();
  });
  el.micBtn.addEventListener("click", toggleDictation);
  el.micCancel.addEventListener("click", cancelDictation);
  el.alertsBtn.addEventListener("click", openAlertsDialog);
  el.alertsEnable.addEventListener("click", () => turnOnPush());
  el.alertsTest.addEventListener("click", sendTestAlert);
  el.alertsDisable.addEventListener("click", turnOffPush);
  el.alertsClose.addEventListener("click", () => el.alertsDialog.close());
  el.installBtn.addEventListener("click", installApp);
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    renderNotifyButton();
  });
  window.addEventListener("appinstalled", () => {
    state.installPrompt = null;
    renderNotifyButton();
    toast("Installed. Open Vapi Control from the Home Screen / Start menu.", "ok", 6000);
  });
  navigator.serviceWorker?.addEventListener("message", (event) => {
    const msg = event.data || {};
    const callId = msg.type === "select-call" ? msg.callId : msg.type === "push" && msg.data?.type === "call" ? msg.data.callId : null;
    if (!callId) return;
    if (msg.type === "select-call") {
      state.wantedCallId = callId;
      autoSelect();
    }
    // The alert may beat the event stream: look the call up directly.
    fetchCallById(callId);
  });
  el.modeBtn.addEventListener("click", toggleOperatorMode);
  el.applyPromotions.addEventListener("change", () => { void promotions.change(el.applyPromotions.checked); });
  el.refreshPromotions.addEventListener("click", () => { void promotions.load(); });
  // Any click or key press on the page unlocks sound for the session.
  document.addEventListener("pointerdown", unlockAudio, { capture: true });
  document.addEventListener("keydown", unlockAudio, { capture: true });
  el.editPhrases.addEventListener("click", openPhraseEditor);
  el.phraseAdd.addEventListener("click", () => el.phraseRows.appendChild(phraseRow({ label: "", text: "", action: "say" })));
  el.phraseReset.addEventListener("click", () => fillPhraseEditor(cfg.quickPhrases || []));
  el.phraseCancel.addEventListener("click", () => el.phraseDialog.close());
  el.phraseSave.addEventListener("click", savePhrases);
  el.enableNotify.addEventListener("click", askNotifyPermission);
  renderNotifyButton();
  el.sayText.addEventListener("input", renderControls);
  el.instructionText.addEventListener("input", renderControls);
  el.sayBtn.addEventListener("click", () => sayFromInput(false));
  el.sayHangupBtn.addEventListener("click", () => sayFromInput(true));
  el.instructionBtn.addEventListener("click", sendInstruction);
  el.sayText.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (!el.sayBtn.disabled) sayFromInput(false);
    }
  });
  el.instructionText.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      if (!el.instructionBtn.disabled) sendInstruction();
    }
  });

  el.keypad.addEventListener("click", (event) => {
    const key = event.target?.dataset?.key;
    if (!key || event.target.disabled) return;
    if (cfg.dtmf.sendOnPress) {
      sendDtmf(key);
      return;
    }
    queueDtmf(key);
  });
  el.dtmfClear.addEventListener("click", () => {
    clearTimeout(state.dtmfTimer);
    state.dtmf = "";
    renderControls();
  });
  el.dtmfSend.addEventListener("click", flushDtmf);

  el.endCallBtn.addEventListener("click", openEndDialog);
  el.endCancel.addEventListener("click", closeEndDialog);
  el.endConfirm.addEventListener("click", confirmEnd);
  el.endDialog.addEventListener("cancel", () => {
    state.endTarget = null;
  });

  el.transcript.addEventListener("scroll", () => {
    const box = el.transcript;
    state.follow = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    if (state.follow) el.jumpLatest.hidden = true;
  });
  el.jumpLatest.addEventListener("click", () => {
    state.follow = true;
    el.transcript.scrollTop = el.transcript.scrollHeight;
    el.jumpLatest.hidden = true;
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { schedulePoll(0); promotions.load(); }
  });
  window.addEventListener("online", () => schedulePoll(0));
  window.addEventListener("focus", () => { if (!document.hidden) promotions.load(); });
  window.addEventListener("offline", () => {
    state.pollError = "Network connection lost.";
    renderBanner();
  });
  window.addEventListener("pagehide", () => {
    stopListening("page closed");
    events.stop();
  });
}

// Opened from a call alert: ./?call=<id> selects that call once it is known.
function takeWantedCallFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("call");
  if (!id) return;
  if (/^[0-9a-f-]{36}$/i.test(id)) state.wantedCallId = id.toLowerCase();
  params.delete("call");
  const rest = params.toString();
  history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
}

// Installed apps (and sites the browser trusts) may play sound without a
// click first; then listening and the ring work right after an alert opens
// the console.
function tryAutoUnlock() {
  if (state.audioUnlocked) return;
  try {
    const ctx = sharedAudio();
    ctx.resume().catch(() => {});
    setTimeout(() => {
      if (!state.audioUnlocked && ctx.state === "running") unlockAudio();
    }, 400);
  } catch {
    // no Web Audio
  }
}

async function init() {
  takeWantedCallFromUrl();
  bindUi();
  renderQuickPhrases();
  render();
  setInterval(tick, 250);
  setInterval(() => { if (!document.hidden && document.hasFocus()) promotions.load(); }, 10000);
  tryAutoUnlock();
  try {
    const session = await api.session();
    state.session = session;
    state.skewMs = session.now - Date.now();
    el.userEmail.textContent = session.user?.email || "";
    const warnings = Array.isArray(session.warnings) ? session.warnings : [];
    el.configWarning.hidden = warnings.length === 0;
    el.configWarning.textContent = warnings.length === 1 ? "Security notice" : `${warnings.length} security notices`;
    el.configWarning.title = warnings.join("\n");
    if (!session.vapiConfigured) state.fatal = "The Vapi private API key secret is not configured on the Worker.";
    if (session.eventsAvailable) events.start();
    initAlerts(session).catch(() => {});
  } catch (error) {
    state.fatal = error instanceof ApiError ? error.message : "Could not reach the control server.";
    // Still start the event stream; the poll loop recovers once fixed.
    events.start();
  }
  render();
  poll();
  loadPhrases();
  promotions.load();
}

// ----------------------------------------------------------- phrase editor --

async function loadPhrases() {
  try {
    const data = await api.phrases();
    if (Array.isArray(data.phrases)) {
      state.phrases = data.phrases;
      renderQuickPhrases();
      renderControls();
    }
  } catch {
    // Keep the defaults from config.js.
  }
}

function phraseRow(phrase) {
  const row = document.createElement("div");
  row.className = "phrase-row";
  const label = document.createElement("input");
  label.placeholder = "Button label";
  label.maxLength = 60;
  label.value = phrase.label || "";
  label.dataset.field = "label";
  const text = document.createElement("input");
  text.placeholder = "What the assistant says (English)";
  text.maxLength = 1000;
  text.value = phrase.text || "";
  text.dataset.field = "text";
  const action = document.createElement("select");
  action.dataset.field = "action";
  for (const [value, title] of [["say", "Say"], ["say-and-hang-up", "Say & hang up"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = title;
    action.appendChild(option);
  }
  action.value = phrase.action === "say-and-hang-up" ? "say-and-hang-up" : "say";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn danger del";
  del.textContent = "✕";
  del.title = "Delete";
  del.addEventListener("click", () => row.remove());
  row.append(label, text, action, del);
  return row;
}

function fillPhraseEditor(phrases) {
  el.phraseRows.replaceChildren(...phrases.map(phraseRow));
}

function openPhraseEditor() {
  fillPhraseEditor(currentPhrases());
  el.phraseDialog.showModal();
}

async function savePhrases() {
  const phrases = [...el.phraseRows.querySelectorAll(".phrase-row")]
    .map((row) => ({
      label: row.querySelector('[data-field="label"]').value.trim(),
      text: row.querySelector('[data-field="text"]').value.trim(),
      action: row.querySelector('[data-field="action"]').value,
    }))
    .filter((p) => p.text);
  el.phraseSave.disabled = true;
  try {
    const data = await api.savePhrases(phrases);
    state.phrases = data.phrases;
    renderQuickPhrases();
    renderControls();
    el.phraseDialog.close();
    toast("Quick phrases saved.", "ok", 2500);
  } catch (error) {
    toast(`Could not save: ${error.message}`, "error", 7000);
  } finally {
    el.phraseSave.disabled = false;
  }
}

init();
