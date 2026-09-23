// Vapi Live Control — operator console controller.
//
// Data flow:
//   poll   GET api/calls every few seconds  -> active call list (authoritative)
//   events WS  api/events                   -> live transcript / speech / status
//   listen WS  api/calls/:id/listen         -> call audio (only while LISTEN is on)
//   commands POST api/calls/:id/...         -> say / instruction / dtmf / end
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

const DEFAULTS = {
  apiBase: "api/",
  poll: { liveMs: 0, fallbackMs: 30000, hiddenMultiplier: 4 },
  notify: { sound: true, desktop: true, titleBadge: true },
  endedBannerMs: 5000,
  labels: { user: "PROVIDER", assistant: "ASSISTANT", system: "INSTRUCTION", tool: "TOOL" },
  say: {
    interruptAssistantByDefault: false,
    clearAfterSend: true,
    translate: { enabledByDefault: true, targetLanguage: "English", template: "{text}" },
  },
  operatorMode: { useMute: true, charsPerSecond: 14, extraMs: 1500, translatedExtraMs: 2500, enterText: "", leaveText: "" },
  aiInstruction: { template: "{instruction}", clearAfterSend: true },
  quickPhrases: [],
  dtmf: { pauseBetweenDigits: "w", sendOnPress: false, maxLength: 32 },
  listen: { defaultFormat: "auto", volume: 1 },
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
  // Call IDs the operator has taken over. Kept per call so switching calls
  // never silently carries the mode across.
  manualCalls: new Set(),
  notifiedCalls: new Set(),
  remute: null, // { callId, timer } while an operator line is being spoken
  fetchingCalls: new Set(),
};
if (!(state.audioFormatKey in FORMAT_PRESETS)) state.audioFormatKey = "auto";

const el = {
  callState: $("callState"),
  callStateText: $("callStateText"),
  timer: $("timer"),
  eventsPill: $("eventsPill"),
  enableNotify: $("enableNotify"),
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

// ---------------------------------------------------------------- helpers --

function selectedCall() {
  return state.selectedId ? state.calls.find((c) => c.id === state.selectedId) || null : null;
}

function canControl() {
  const call = selectedCall();
  return Boolean(call && call.status === "in-progress" && state.caps?.control && state.capsStatus === "in-progress" && !state.fatal);
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
  if (state.selectedId || state.ended || state.fatal) return;
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
  state.manualCalls.delete(id);
  if (state.remute?.callId === id) {
    clearTimeout(state.remute.timer);
    state.remute = null;
  }
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
function playChime() {
  if (!cfg.notify.sound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [880, 1320].forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + index * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    });
    setTimeout(() => ctx.close().catch(() => {}), 800);
  } catch {
    // Audio unavailable; the visual cues still fire.
  }
}

function announceCall(call) {
  if (state.notifiedCalls.has(call.id)) return;
  state.notifiedCalls.add(call.id);
  if (state.notifiedCalls.size > 200) state.notifiedCalls.clear();
  playChime();
  if (cfg.notify.desktop && window.Notification?.permission === "granted") {
    try {
      const who = call.customerNumber || call.customerName || directionLabel(call.direction);
      const note = new Notification("Vapi: incoming call", { body: `${who} · ${statusLabel(call.status)}`, tag: call.id, renotify: false });
      note.onclick = () => {
        window.focus();
        selectCall(call.id);
        note.close();
      };
    } catch {
      // Notification constructor can throw on some platforms.
    }
  }
}

function updateTitle() {
  if (!cfg.notify.titleBadge) return;
  const active = state.calls.length;
  document.title = active > 0 ? `(${active}) Vapi Live Control` : "Vapi Live Control";
}

async function askNotifyPermission() {
  if (!window.Notification) return;
  try {
    await Notification.requestPermission();
  } catch {
    // Older browsers use the callback form; ignore.
  }
  renderNotifyButton();
}

function renderNotifyButton() {
  const supported = Boolean(window.Notification);
  el.enableNotify.hidden = !supported || !cfg.notify.desktop || Notification.permission !== "default";
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

    // The assistant finished speaking an operator line: mute it again at once.
    if (msg.type === "speech" && msg.role === "assistant" && msg.status === "stopped" && state.remute?.callId === msg.callId) {
      setTimeout(() => remuteNow(msg.callId), 300);
    }
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
      state.manualCalls.delete(endedId);
      autoSelect();
      render();
    }
    // Any event about a call we don't know yet: fetch that call right away.
    const eventCallId = msg.callId || msg.call?.callId;
    const hubState = eventCallId ? store.calls.get(eventCallId) : null;
    if (eventCallId && hubState?.status !== "ended" && !state.calls.some((c) => c.id === eventCallId)) {
      fetchCallById(eventCallId);
    }
    if (affected === "*" || affected === id) renderTranscript();
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

// Only text in another script needs the model to translate; Latin-script
// text (already English) keeps going through verbatim say.
function needsTranslation(text) {
  return /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text);
}

function speechEstimateMs(text, translated) {
  const om = cfg.operatorMode;
  const ms = (text.length / (om.charsPerSecond || 14)) * 1000 + (om.extraMs || 0) + (translated ? om.translatedExtraMs || 0 : 0);
  return Math.min(30000, Math.max(2500, ms));
}

// In operator mode the assistant is muted; it is unmuted just for the
// operator's own line and muted again once that line has been spoken.
async function unmuteForLine(callId) {
  if (!cfg.operatorMode.useMute || !state.manualCalls.has(callId)) return;
  clearTimeout(state.remute?.timer);
  state.remute = null;
  await api.control(callId, "unmute-assistant");
}

function remuteAfterLine(callId, estimateMs) {
  if (!cfg.operatorMode.useMute || !state.manualCalls.has(callId)) return;
  clearTimeout(state.remute?.timer);
  const timer = setTimeout(() => remuteNow(callId), estimateMs);
  state.remute = { callId, timer };
}

function remuteNow(callId) {
  if (state.remute?.callId !== callId) return;
  clearTimeout(state.remute.timer);
  state.remute = null;
  if (!state.manualCalls.has(callId)) return;
  api.control(callId, "mute-assistant").catch((error) => {
    // The call ending in the meantime is not an error worth showing.
    if (!state.calls.some((c) => c.id === callId) || error.code === "call_ended" || /not active/i.test(error.message)) return;
    toast(`Could not mute the assistant again: ${error.message}`, "error", 7000);
  });
}

async function say(text, { hangUp, translate = el.translateSay.checked } = {}) {
  const content = String(text || "").trim();
  if (!content) return false;
  const manual = state.manualCalls.has(state.selectedId);
  // While you drive, your line replaces anything the assistant had queued.
  const interruptAssistant = manual || el.interruptBot.checked;
  const translateNow = translate && needsTranslation(content);

  // Vapi's say command is verbatim and cannot translate, so a translated line
  // goes to the model instead. That rules out endCallAfterSpoken, whose timing
  // only exists for say.
  if (translateNow && hangUp) {
    toast("SAY & HANG UP speaks verbatim, so write that line in English — or SAY it translated and then press END CALL.", "error", 9000);
    return false;
  }
  if (translateNow) {
    const prompt = fill(cfg.say.translate.template, { text: content, language: cfg.say.translate.targetLanguage });
    return command(
      "say",
      async (id) => {
        await unmuteForLine(id);
        await api.instruction(id, prompt);
        remuteAfterLine(id, speechEstimateMs(content, true));
      },
      `Sent for the assistant to say in ${cfg.say.translate.targetLanguage}.`,
    );
  }

  const ok = await command(
    hangUp ? "sayHangup" : "say",
    async (id) => {
      await unmuteForLine(id);
      await api.say(id, content, { endCallAfterSpoken: hangUp, interruptAssistant });
      if (!hangUp) remuteAfterLine(id, speechEstimateMs(content, false));
    },
    hangUp ? "Speaking, then hanging up…" : "Sent to the call.",
  );
  if (ok && hangUp) {
    state.hangingUp = state.selectedId;
    render();
    schedulePoll(1500);
  }
  return ok;
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
// told, for this call only, to stop improvising and wait for dictated lines.
// The message is inserted without triggering a reply, so nothing is spoken.
async function toggleOperatorMode() {
  const id = state.selectedId;
  if (!id) return;
  const goingManual = !state.manualCalls.has(id);
  const text = goingManual ? cfg.operatorMode.enterText : cfg.operatorMode.leaveText;
  if (!text) {
    toast("Operator mode text is not configured (config.js → operatorMode).", "error");
    return;
  }
  const ok = await command(
    "mode",
    async (callId) => {
      await api.instruction(callId, text, { triggerResponse: false });
      if (cfg.operatorMode.useMute) {
        if (state.remute?.callId === callId) {
          clearTimeout(state.remute.timer);
          state.remute = null;
        }
        await api.control(callId, goingManual ? "mute-assistant" : "unmute-assistant");
      }
    },
    goingManual ? "You are driving the call — the assistant is muted." : "Handed back to the assistant.",
  );
  if (!ok) return;
  if (goingManual) state.manualCalls.add(id);
  else state.manualCalls.delete(id);
  render();
}

function dtmfSequence(keys) {
  const pause = String(cfg.dtmf.pauseBetweenDigits || "");
  return pause ? keys.split("").join(pause) : keys;
}

async function sendDtmf(keys) {
  if (!keys) return;
  const ok = await command("dtmf", (id) => api.dtmf(id, dtmfSequence(keys)), `DTMF ${keys} sent to the assistant's dtmf tool.`);
  if (ok && !cfg.dtmf.sendOnPress) state.dtmf = "";
  renderControls();
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

function tick() {
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

  const dtmfTool = Boolean(state.caps?.dtmf?.viaAssistantTool);
  const dtmfEnabled = control && dtmfTool;
  for (const btn of el.keypad.querySelectorAll("button")) btn.disabled = !dtmfEnabled || state.busy.has("dtmf");
  el.dtmfClear.disabled = !dtmfEnabled || !state.dtmf;
  el.dtmfSend.disabled = !dtmfEnabled || !state.dtmf || state.busy.has("dtmf");
  el.dtmfSend.hidden = Boolean(cfg.dtmf.sendOnPress);
  el.dtmfDisplay.textContent = state.dtmf;
  el.dtmfState.dataset.state = dtmfTool ? "on" : "off";
  el.dtmfState.textContent = dtmfTool ? "via assistant dtmf tool" : "NOT SUPPORTED BY VAPI";
  el.dtmfNote.textContent = !call
    ? ""
    : dtmfTool
      ? "Vapi has no operator DTMF command. These keys are passed to the assistant's built-in dtmf tool, which sends real DTMF (RFC 2833); the model performs the key press."
      : "Vapi's live call control API cannot send operator DTMF. To enable this keypad, add Vapi's built-in DTMF tool to the assistant (see README).";
}

function renderMode() {
  const id = state.selectedId;
  const manual = Boolean(id && state.manualCalls.has(id));
  document.body.classList.toggle("manual-mode", manual);
  el.modeBtn.disabled = !canControl() || state.busy.has("mode");
  el.modeBtn.classList.toggle("on", manual);
  el.modeBtn.textContent = manual ? "HAND BACK TO ASSISTANT" : "TAKE OVER";
  el.modeState.dataset.state = manual ? "reconnecting" : "auto";
  el.modeState.textContent = manual ? "You (operator)" : "Assistant (auto)";
  el.modeNote.textContent = manual
    ? "The assistant is muted and told to stay silent. Each EXACT SAY line unmutes it just long enough to speak, then mutes it again."
    : "The assistant answers on its own. Take over and it stays silent — then everything the caller hears comes from EXACT SAY.";
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
  el.audioFormatInfo.textContent = listening && state.audioFormat ? describeFormat(state.audioFormat) + (state.audioFormat.source === "auto" ? " (auto)" : "") : "";
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

function renderQuickPhrases() {
  const phrases = Array.isArray(cfg.quickPhrases) ? cfg.quickPhrases : [];
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
  el.modeBtn.addEventListener("click", toggleOperatorMode);
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
    if (state.dtmf.length < (cfg.dtmf.maxLength || 32)) state.dtmf += key;
    renderControls();
  });
  el.dtmfClear.addEventListener("click", () => {
    state.dtmf = "";
    renderControls();
  });
  el.dtmfSend.addEventListener("click", () => sendDtmf(state.dtmf));

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
    if (!document.hidden) schedulePoll(0);
  });
  window.addEventListener("online", () => schedulePoll(0));
  window.addEventListener("offline", () => {
    state.pollError = "Network connection lost.";
    renderBanner();
  });
  window.addEventListener("pagehide", () => {
    stopListening("page closed");
    events.stop();
  });
}

async function init() {
  bindUi();
  renderQuickPhrases();
  render();
  setInterval(tick, 250);
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
  } catch (error) {
    state.fatal = error instanceof ApiError ? error.message : "Could not reach the control server.";
    // Still start the event stream; the poll loop recovers once fixed.
    events.start();
  }
  render();
  poll();
}

init();
