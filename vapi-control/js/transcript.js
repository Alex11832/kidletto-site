// Live transcript state, fed by CallHub messages (snapshot / state / live /
// speech / removed). Pure functions, no DOM: unit-tested in Node.
//
// Sources, in order of authority:
//   state.messages  committed conversation (Vapi conversation-update); replaced
//                   wholesale on every update, so it can never duplicate lines.
//   state.live      transcriber output not yet committed: at most one partial
//                   per role plus finals newer than the last commit.

const MAX_LIVE = 20;

function blank(callId) {
  return { callId, status: null, endedReason: null, messages: [], conversationAt: 0, live: [], speech: {}, updatedAt: 0 };
}

function normalizeCall(raw) {
  const st = { ...blank(raw.callId), ...raw };
  st.messages = Array.isArray(raw.messages) ? raw.messages : [];
  st.live = Array.isArray(raw.live) ? raw.live : [];
  st.speech = raw.speech && typeof raw.speech === "object" ? raw.speech : {};
  return st;
}

export function normText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function createTranscriptStore() {
  return { calls: new Map() };
}

function addLive(st, line) {
  if (st.status === "ended") return false;
  if (line.at <= st.conversationAt) return false;
  if (line.transcriptType === "partial") {
    // A partial older than the newest final of the same role is stale.
    const newerFinal = st.live.some((l) => l.role === line.role && l.transcriptType === "final" && l.at >= line.at);
    if (newerFinal) return false;
    st.live = st.live.filter((l) => !(l.role === line.role && l.transcriptType === "partial"));
  } else {
    st.live = st.live.filter((l) => !(l.role === line.role && l.transcriptType === "partial" && l.at <= line.at));
    const dup = st.live.some((l) => l.role === line.role && l.transcriptType === "final" && normText(l.text) === normText(line.text));
    if (dup) return false;
  }
  st.live.push(line);
  st.live.sort((a, b) => a.at - b.at);
  if (st.live.length > MAX_LIVE) st.live = st.live.slice(-MAX_LIVE);
  return true;
}

// Returns the affected call ID, "*" for everything, or null.
export function applyHubMessage(store, msg) {
  if (!msg || typeof msg.type !== "string") return null;
  switch (msg.type) {
    case "snapshot": {
      const prev = store.calls;
      store.calls = new Map();
      for (const raw of Array.isArray(msg.calls) ? msg.calls : []) {
        if (!raw?.callId) continue;
        const st = normalizeCall(raw);
        // Keep in-memory partials we already have that are still uncommitted.
        const old = prev.get(st.callId);
        if (old && st.status !== "ended") for (const l of old.live) addLive(st, { ...l });
        store.calls.set(st.callId, st);
      }
      return "*";
    }
    case "state": {
      const raw = msg.call;
      if (!raw?.callId) return null;
      const prev = store.calls.get(raw.callId);
      const next = normalizeCall(raw);
      if (prev && prev.conversationAt > next.conversationAt) {
        // Out-of-order state: keep the newer conversation we already have.
        next.messages = prev.messages;
        next.conversationAt = prev.conversationAt;
      }
      next.live = [];
      next.speech = { ...(prev?.speech || {}), ...next.speech };
      if (next.status === "ended") next.speech = {};
      else for (const l of [...(prev?.live || []), ...(raw.live || [])]) addLive(next, { ...l });
      store.calls.set(next.callId, next);
      return next.callId;
    }
    case "live": {
      if (!msg.callId || !msg.role) return null;
      const st = store.calls.get(msg.callId) || blank(msg.callId);
      store.calls.set(msg.callId, st);
      const changed = addLive(st, { role: msg.role, transcriptType: msg.transcriptType === "final" ? "final" : "partial", text: String(msg.text || ""), at: Number(msg.at) || Date.now() });
      return changed ? msg.callId : null;
    }
    case "speech": {
      if (!msg.callId || !msg.role) return null;
      const st = store.calls.get(msg.callId) || blank(msg.callId);
      store.calls.set(msg.callId, st);
      if (st.status === "ended") return null;
      const prev = st.speech[msg.role];
      if (prev && prev.at > msg.at) return null;
      st.speech[msg.role] = { status: msg.status, at: msg.at };
      return msg.callId;
    }
    case "removed":
      store.calls.delete(msg.callId);
      return msg.callId || null;
    default:
      return null;
  }
}

// Items to render, oldest first. `kind` is "final" (committed), "pending"
// (final transcript awaiting commit) or "partial" (still being spoken).
export function transcriptView(st) {
  if (!st) return [];
  const items = st.messages.map((m, i) => ({
    key: `m${i}`,
    role: m.role,
    text: m.text,
    kind: "final",
    time: m.time ?? null,
  }));
  for (const line of st.live) {
    let lastSame = null;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].role === line.role) {
        lastSame = items[i];
        break;
      }
    }
    // A commit can race the transcript event; identical text means same line.
    if (lastSame && normText(lastSame.text) === normText(line.text)) continue;
    items.push({
      key: `l-${line.role}-${line.at}-${line.transcriptType}`,
      role: line.role,
      text: line.text,
      kind: line.transcriptType === "partial" ? "partial" : "pending",
      time: line.at,
    });
  }
  return items;
}

export function speakingRoles(st, nowMs = Date.now(), staleMs = 30_000) {
  if (!st?.speech) return [];
  return Object.entries(st.speech)
    .filter(([, s]) => s?.status === "started" && nowMs - (s.at || 0) < staleMs)
    .map(([role]) => role);
}
