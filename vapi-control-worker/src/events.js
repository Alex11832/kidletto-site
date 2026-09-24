// Converts Vapi Server URL webhook messages into small, sanitized events for
// the live transcript hub. Only documented message types are used:
//   status-update, end-of-call-report, conversation-update,
//   transcript (partial/final), speech-update.
// Everything else in the payload (monitor URLs, assistant config, customer
// data, artifacts, costs) is dropped here and never reaches the browser.

const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 300;
const MAX_TEXT = 2000;
const MAX_SYSTEM_TEXT = 600;

function text(value, max = MAX_TEXT) {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toolCallsText(message) {
  const calls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
  return calls
    .map((tc) => {
      const name = tc?.function?.name || tc?.type || "tool";
      const args = typeof tc?.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc?.function?.arguments ?? "");
      return `${name}(${text(args, 200)})`;
    })
    .join(", ");
}

export function sanitizeConversation(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  messages.forEach((m, index) => {
    const role = m?.role;
    const time = num(m?.time);
    const secondsFromStart = num(m?.secondsFromStart);
    if (role === "user") out.push({ role: "user", text: text(m.message ?? m.content), time, secondsFromStart });
    else if (role === "bot" || role === "assistant") {
      const t = m.message ?? m.content;
      if (typeof t === "string" && t) out.push({ role: "assistant", text: text(t), time, secondsFromStart });
      else if (Array.isArray(m.tool_calls) || Array.isArray(m.toolCalls)) {
        out.push({ role: "tool", text: toolCallsText({ toolCalls: m.toolCalls || m.tool_calls }), time, secondsFromStart });
      }
    } else if (role === "system") {
      // The first system message is the assistant's own prompt: never shown.
      if (index === 0) return;
      out.push({ role: "system", text: text(m.message ?? m.content, MAX_SYSTEM_TEXT), time, secondsFromStart });
    } else if (role === "tool_calls") {
      out.push({ role: "tool", text: toolCallsText(m), time, secondsFromStart });
    }
    // tool_call_result and unknown roles are intentionally omitted.
  });
  return out.filter((m) => m.text).slice(-MAX_MESSAGES);
}

export function sanitizeServerMessage(body, nowMs = Date.now()) {
  const msg = body?.message;
  if (!msg || typeof msg.type !== "string") return null;
  const callId = msg.call?.id;
  if (!CALL_ID.test(String(callId || ""))) return null;
  const at = num(msg.timestamp) ?? nowMs;
  const base = { callId: String(callId).toLowerCase(), at };

  switch (msg.type) {
    case "status-update":
      if (typeof msg.status !== "string") return null;
      return { ...base, kind: "status", status: msg.status, endedReason: text(msg.endedReason, 120) || null };
    case "end-of-call-report":
      return { ...base, kind: "status", status: "ended", endedReason: text(msg.endedReason, 120) || null };
    case "conversation-update":
      return { ...base, kind: "conversation", messages: sanitizeConversation(msg.messages) };
    case "transcript":
    case 'transcript[transcriptType="final"]': {
      const role = msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : null;
      const transcriptType = msg.transcriptType === "final" || msg.type !== "transcript" ? "final" : "partial";
      const t = text(msg.transcript);
      if (!role || !t) return null;
      return { ...base, kind: "transcript", role, transcriptType, text: t };
    }
    case "speech-update": {
      const role = msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : null;
      if (!role || (msg.status !== "started" && msg.status !== "stopped")) return null;
      return { ...base, kind: "speech", role, status: msg.status };
    }
    default:
      return null;
  }
}
