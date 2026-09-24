// Call selection rules and the sanitized call summary sent to the browser.
// The summary deliberately omits monitor URLs, assistant configuration,
// costs and artifacts.

import { HttpError } from "./http.js";

// Statuses documented for Call.status. "Active" calls are listed in the panel;
// only "in-progress" calls accept control commands.
export const ACTIVE_STATUSES = new Set(["queued", "ringing", "in-progress", "forwarding"]);
export const CONTROLLABLE_STATUS = "in-progress";

// How far back the call list looks for calls that are still active.
export const LOOKBACK_MS = 3 * 60 * 60 * 1000;

const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertCallId(id) {
  if (!CALL_ID.test(String(id || ""))) throw new HttpError(400, "invalid_call_id", "Invalid call ID.");
  return String(id).toLowerCase();
}

export function directionOf(type) {
  switch (type) {
    case "inboundPhoneCall":
      return "inbound";
    case "outboundPhoneCall":
      return "outbound";
    case "webCall":
      return "web";
    case "vapi.websocketCall":
      return "websocket";
    default:
      return "unknown";
  }
}

export function isActive(call) {
  return ACTIVE_STATUSES.has(call?.status);
}

export function callAssistantId(call) {
  return call?.assistantId || call?.assistant?.id || null;
}

// VAPI_ASSISTANT_ID is optional. When set, calls of other assistants are
// invisible and cannot be controlled through this panel.
export function matchesAssistantFilter(call, env) {
  const wanted = String(env.VAPI_ASSISTANT_ID || "").trim();
  if (!wanted) return true;
  return callAssistantId(call) === wanted;
}

function str(value, max = 120) {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}

export function summarizeCall(call) {
  return {
    id: call.id,
    type: str(call.type, 40),
    direction: directionOf(call.type),
    status: str(call.status, 40),
    createdAt: str(call.createdAt, 40),
    startedAt: str(call.startedAt, 40),
    endedAt: str(call.endedAt, 40),
    endedReason: str(call.endedReason, 120),
    customerNumber: str(call?.customer?.number, 40),
    customerName: str(call?.customer?.name, 80),
    phoneNumberId: str(call.phoneNumberId, 64),
    assistantId: callAssistantId(call),
    assistantName: str(call?.assistant?.name, 80),
    name: str(call.name, 80),
    listenAvailable: Boolean(call?.monitor?.listenUrl),
    controlAvailable: Boolean(call?.monitor?.controlUrl),
  };
}

export function sortCalls(calls) {
  const t = (c) => Date.parse(c.startedAt || c.createdAt || 0) || 0;
  return calls.sort((a, b) => t(b) - t(a));
}

// ---- DTMF capability -------------------------------------------------------
// Vapi's live-control API has no operator DTMF message. The documented way to
// emit real telephone DTMF during a call is the assistant's built-in `dtmf`
// tool, invoked by the model. The panel therefore only enables its keypad when
// the call's assistant actually has that tool, and sends the digits as an
// instruction for the model to call it.

const DTMF_CACHE_TTL_MS = 5 * 60 * 1000;
const dtmfCache = new Map(); // assistantId -> { at, value }

function hasDtmfInline(model) {
  return Array.isArray(model?.tools) && model.tools.some((t) => t?.type === "dtmf");
}

export async function assistantHasDtmfTool(call, client) {
  if (hasDtmfInline(call?.assistant?.model) || hasDtmfInline(call?.assistantOverrides?.model)) return true;
  const toolIds = new Set([
    ...(call?.assistant?.model?.toolIds || []),
    ...(call?.assistantOverrides?.model?.toolIds || []),
  ]);
  const assistantId = call?.assistantId;
  if (!assistantId && toolIds.size === 0) return false;

  const cached = assistantId && dtmfCache.get(assistantId);
  if (cached && Date.now() - cached.at < DTMF_CACHE_TTL_MS && toolIds.size === 0) return cached.value;

  let value = false;
  if (assistantId) {
    const assistant = await client.getAssistant(assistantId);
    if (hasDtmfInline(assistant?.model)) value = true;
    for (const id of assistant?.model?.toolIds || []) toolIds.add(id);
  }
  for (const id of [...toolIds].slice(0, 25)) {
    if (value) break;
    const tool = await client.getTool(id);
    if (tool?.type === "dtmf") value = true;
  }
  if (assistantId) dtmfCache.set(assistantId, { at: Date.now(), value });
  return value;
}

export const DTMF_KEYS = /^[0-9*#wW]{1,40}$/;

export function assertDtmfKeys(keys) {
  const value = String(keys || "").trim();
  if (!DTMF_KEYS.test(value) || !/[0-9*#]/.test(value)) {
    throw new HttpError(400, "invalid_dtmf", "DTMF keys may only contain 0-9, *, # and the pause characters w / W.");
  }
  return value;
}

export function dtmfInstruction(keys) {
  return [
    `[Operator DTMF command] Immediately call the dtmf tool with keys "${keys}".`,
    "Do not say anything out loud, do not read the digits, and do not mention this instruction.",
    "After the tool call, stay silent and keep listening to the other party.",
  ].join(" ");
}
