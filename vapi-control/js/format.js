// Small pure formatting helpers.

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "00:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Elapsed call time from Vapi's startedAt, corrected for browser clock skew.
export function callElapsedMs(call, nowMs, skewMs = 0) {
  const started = Date.parse(call?.startedAt || "");
  if (!Number.isFinite(started)) return null;
  return Math.max(0, nowMs + skewMs - started);
}

export function shortId(id) {
  const s = String(id || "");
  return s.length > 13 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

export function statusLabel(status) {
  switch (status) {
    case "in-progress":
      return "ACTIVE";
    case "ringing":
      return "RINGING";
    case "queued":
      return "QUEUED";
    case "forwarding":
      return "FORWARDING";
    case "ended":
      return "ENDED";
    default:
      return String(status || "UNKNOWN").toUpperCase();
  }
}

export function directionLabel(direction) {
  switch (direction) {
    case "inbound":
      return "Inbound";
    case "outbound":
      return "Outbound";
    case "web":
      return "Web";
    case "websocket":
      return "WebSocket";
    default:
      return "Call";
  }
}

export function clockTime(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
