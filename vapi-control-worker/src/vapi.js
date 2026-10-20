// Thin client for the documented Vapi APIs used by the control panel:
//   GET  https://api.vapi.ai/call              list calls
//   GET  https://api.vapi.ai/call/{id}         fetch one call (incl. monitor URLs)
//   GET  https://api.vapi.ai/assistant/{id}    DTMF-tool detection
//   GET  https://api.vapi.ai/tool/{id}         DTMF-tool detection
//   POST call.monitor.controlUrl               Live Call Control messages
//   WS   call.monitor.listenUrl                Live Call Listen audio stream
//
// The private API key is only ever placed in the Authorization header of
// requests to the Vapi API host. Monitor URLs are per-call capability URLs;
// they are validated to be on vapi.ai and never returned to the browser.

import { HttpError } from "./http.js";

const DEFAULT_API_BASE = "https://api.vapi.ai";
const REQUEST_TIMEOUT_MS = 10_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class VapiError extends HttpError {}

function apiBase(env) {
  return String(env.VAPI_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, "");
}

// Monitor URLs must point at Vapi. The only exception is a local mock server
// used by the automated tests (VAPI_API_BASE_URL on localhost).
export function assertMonitorUrl(raw, env, kind) {
  let url;
  try {
    url = new URL(String(raw || ""));
  } catch {
    throw new VapiError(409, `${kind}_unavailable`, `This call has no ${kind} URL (live ${kind} disabled or call not started).`);
  }
  const host = url.hostname.toLowerCase();
  const onVapi = (host === "vapi.ai" || host.endsWith(".vapi.ai")) && (url.protocol === "https:" || url.protocol === "wss:");
  let onLocalMock = false;
  try {
    const base = new URL(apiBase(env));
    onLocalMock = LOCAL_HOSTS.has(base.hostname) && url.hostname === base.hostname;
  } catch {
    onLocalMock = false;
  }
  if (!onVapi && !onLocalMock) {
    throw new VapiError(502, "unexpected_monitor_url", `Vapi returned an unexpected ${kind} URL host.`);
  }
  return url;
}

function extractVapiMessage(text) {
  try {
    const body = JSON.parse(text);
    const msg = Array.isArray(body?.message) ? body.message.join("; ") : body?.message || body?.error;
    if (msg) return String(msg).slice(0, 200);
  } catch {
    // not JSON
  }
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);
}

export function mapVapiStatus(status, bodyText, what = "Vapi API request") {
  const detail = extractVapiMessage(bodyText);
  if (status === 401 || status === 403) {
    return new VapiError(502, "vapi_auth_failed", `Vapi rejected the server API key (HTTP ${status}). Check the VAPI_API_KEY secret.`, { vapiStatus: status });
  }
  if (status === 404) return new VapiError(404, "not_found", `${what}: not found in Vapi.`, { vapiStatus: status });
  if (status === 429) return new VapiError(503, "vapi_rate_limited", "Vapi rate limit reached. Try again in a moment.", { vapiStatus: status });
  if (status >= 500) return new VapiError(502, "vapi_unavailable", `Vapi is unavailable (HTTP ${status}).`, { vapiStatus: status });
  return new VapiError(502, "vapi_error", `${what} failed (HTTP ${status})${detail ? `: ${detail}` : ""}.`, { vapiStatus: status });
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function networkError(error, what) {
  const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
  return new VapiError(502, timeout ? "vapi_timeout" : "vapi_unreachable", `${what}: ${timeout ? "timed out" : "Vapi could not be reached"}.`);
}

export function createVapiClient(env, { fetchImpl = fetch } = {}) {
  if (!env.VAPI_API_KEY) {
    throw new VapiError(503, "vapi_not_configured", "The VAPI_API_KEY secret is not configured on the Worker.");
  }
  const base = apiBase(env);
  const authHeader = `Bearer ${env.VAPI_API_KEY}`;
  // Only needed when the assistant's monitorPlan enables listen/control
  // authentication; Vapi then expects the *public* key on monitor URLs.
  const monitorAuth = env.VAPI_PUBLIC_KEY ? { Authorization: `Bearer ${env.VAPI_PUBLIC_KEY}` } : {};

  async function request(path, what) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        headers: { Authorization: authHeader, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw networkError(error, what);
    }
    if (!res.ok) throw mapVapiStatus(res.status, await safeText(res), what);
    try {
      return await res.json();
    } catch {
      throw new VapiError(502, "vapi_bad_response", `${what}: Vapi returned an unreadable response.`);
    }
  }

  return {
    async listCalls({ createdAtGt, limit = 100, assistantId } = {}) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (createdAtGt) params.set("createdAtGt", createdAtGt);
      if (assistantId) params.set("assistantId", assistantId);
      const body = await request(`/call?${params}`, "List calls");
      // The API returns an array; tolerate a wrapped shape just in case.
      return Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : [];
    },

    getCall(id) {
      return request(`/call/${encodeURIComponent(id)}`, "Get call");
    },

    getAssistant(id) {
      return request(`/assistant/${encodeURIComponent(id)}`, "Get assistant");
    },

    getTool(id) {
      return request(`/tool/${encodeURIComponent(id)}`, "Get tool");
    },

    // POST a Live Call Control message to call.monitor.controlUrl.
    async control(call, payload) {
      const url = assertMonitorUrl(call?.monitor?.controlUrl, env, "control");
      let res;
      try {
        res = await fetchImpl(url.toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...monitorAuth },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw networkError(error, `Control command "${payload.type}"`);
      }
      if (!res.ok) {
        const detail = extractVapiMessage(await safeText(res));
        throw new VapiError(
          502,
          "control_rejected",
          `Vapi rejected the "${payload.type}" command (HTTP ${res.status})${detail ? `: ${detail}` : ""}.`,
          { vapiStatus: res.status },
        );
      }
      await safeText(res);
      return { status: res.status };
    },

    // Request init for opening the listen WebSocket from the Worker.
    listenRequest(call) {
      const url = assertMonitorUrl(call?.monitor?.listenUrl, env, "listen");
      // fetch() opens WebSockets over http(s) URLs.
      url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
      return { url: url.toString(), headers: { Upgrade: "websocket", ...monitorAuth } };
    },
  };
}
