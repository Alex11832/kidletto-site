// Local stand-in for the Vapi API, Vapi monitor URLs, the Cloudflare Access
// certs endpoint and a previous webhook target. Used only by the automated
// tests; it mimics the documented request/response shapes.

import http from "node:http";
import { WebSocketServer } from "ws";

export async function startMockVapi({ apiKey, jwks }) {
  const state = {
    calls: new Map(),
    assistants: new Map(),
    tools: new Map(),
    controls: [],
    listRequests: [],
    forwarded: [],
    listenSockets: new Map(),
    listenConnections: [],
    nonGetAssistantRequests: 0,
    failList: null,
    // Calls Vapi's list endpoint does not show yet (it lags behind new calls).
    hiddenFromList: new Set(),
  };
  let base = "";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const body = await new Promise((resolve) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
    });
    const send = (status, obj, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
    };
    const authed = req.headers.authorization === `Bearer ${apiKey}`;

    if (url.pathname === "/cdn-cgi/access/certs") return send(200, jwks);

    if (url.pathname === "/forward-target" && req.method === "POST") {
      state.forwarded.push({ body, headers: req.headers });
      return send(200, { forwarded: true, results: [] });
    }

    let m;
    if ((m = /^\/control\/([^/]+)$/.exec(url.pathname)) && req.method === "POST") {
      const call = state.calls.get(m[1]);
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = null;
      }
      state.controls.push({ callId: m[1], payload, authorization: req.headers.authorization || null });
      if (!call || call.status === "ended") return send(400, { message: "Call not found or already ended" });
      if (call.rejectControl) return send(400, { message: "Invalid control message" });
      if (payload?.type === "end-call") endCall(m[1], "call.ended-by-control");
      if (payload?.type === "say" && payload.endCallAfterSpoken) setTimeout(() => endCall(m[1], "assistant-said-end-call-phrase"), 400);
      return send(200, "OK", "text/plain");
    }

    if (url.pathname === "/call" && req.method === "GET") {
      if (!authed) return send(401, { message: "Invalid Key." });
      state.listRequests.push(Object.fromEntries(url.searchParams));
      if (state.failList) return send(state.failList, { message: "upstream exploded" });
      const assistantId = url.searchParams.get("assistantId");
      const list = [...state.calls.values()].filter((c) => (!assistantId || c.assistantId === assistantId) && !state.hiddenFromList.has(c.id));
      return send(200, list);
    }
    if ((m = /^\/call\/([^/]+)$/.exec(url.pathname)) && req.method === "GET") {
      if (!authed) return send(401, { message: "Invalid Key." });
      const call = state.calls.get(m[1]);
      return call ? send(200, call) : send(404, { message: "Not Found" });
    }
    if ((m = /^\/assistant\/([^/]+)$/.exec(url.pathname))) {
      if (req.method !== "GET") {
        state.nonGetAssistantRequests++;
        return send(405, { message: "not allowed in tests" });
      }
      if (!authed) return send(401, { message: "Invalid Key." });
      const a = state.assistants.get(m[1]);
      return a ? send(200, a) : send(404, { message: "Not Found" });
    }
    if ((m = /^\/tool\/([^/]+)$/.exec(url.pathname)) && req.method === "GET") {
      if (!authed) return send(401, { message: "Invalid Key." });
      const t = state.tools.get(m[1]);
      return t ? send(200, t) : send(404, { message: "Not Found" });
    }
    send(404, { message: "Not Found" });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const m = /^\/listen\/([^/]+)\/transport$/.exec(new URL(req.url, base).pathname);
    const call = m && state.calls.get(m[1]);
    if (!call || call.status === "ended") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const callId = m[1];
      state.listenConnections.push({ callId, authorization: req.headers.authorization || null });
      if (!state.listenSockets.has(callId)) state.listenSockets.set(callId, new Set());
      state.listenSockets.get(callId).add(ws);
      ws.send(JSON.stringify({ type: "hello" }));
      // 16 kHz mono PCM16 tone, paced by wall-clock time (timer granularity
      // on Windows is ~15.6 ms, so frames are sized to catch up exactly).
      let n = 0;
      const t0 = Date.now();
      const timer = setInterval(() => {
        const due = Math.floor(((Date.now() - t0) / 1000) * 16000);
        const count = due - n;
        if (count <= 0) return;
        const frame = new Int16Array(count);
        for (let i = 0; i < frame.length; i++, n++) frame[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * n) / 16000) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 2 * n) / 16000)));
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from(frame.buffer));
      }, 10);
      ws.on("close", () => {
        clearInterval(timer);
        state.listenSockets.get(callId)?.delete(ws);
      });
    });
  });

  function endCall(id, reason) {
    const call = state.calls.get(id);
    if (!call || call.status === "ended") return;
    call.status = "ended";
    call.endedAt = new Date().toISOString();
    call.endedReason = reason;
    for (const ws of state.listenSockets.get(id) || []) ws.close(1000, "call ended");
  }

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  function makeCall({ id, status = "in-progress", assistantId, startedAgoMs = 65_000, number = "+15550001111", type = "inboundPhoneCall", extra = {} }) {
    const now = Date.now();
    const call = {
      id,
      orgId: "org-1",
      type,
      status,
      assistantId,
      phoneNumberId: "pn-1",
      createdAt: new Date(now - startedAgoMs - 2000).toISOString(),
      updatedAt: new Date(now).toISOString(),
      startedAt: status === "in-progress" ? new Date(now - startedAgoMs).toISOString() : undefined,
      customer: { number },
      monitor: {
        listenUrl: `ws://127.0.0.1:${server.address().port}/listen/${id}/transport`,
        controlUrl: `${base}/control/${id}`,
      },
      assistant: { name: "Thumbtack", model: { messages: [{ role: "system", content: "TOP SECRET PROMPT" }] } },
      ...extra,
    };
    state.calls.set(id, call);
    return call;
  }

  return {
    base,
    state,
    makeCall,
    endCall,
    dropListen(id) {
      for (const ws of state.listenSockets.get(id) || []) ws.terminate();
    },
    reset() {
      state.calls.clear();
      state.controls.length = 0;
      state.listRequests.length = 0;
      state.forwarded.length = 0;
      state.listenConnections.length = 0;
      state.failList = null;
    },
    close() {
      for (const set of state.listenSockets.values()) for (const ws of set) ws.terminate();
      wss.close();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
