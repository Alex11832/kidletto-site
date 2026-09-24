// Same-origin client for the control-panel Worker API. Authentication is the
// Cloudflare Access session cookie, sent automatically by the browser; this
// code never sees or stores a credential.

export class ApiError extends Error {
  constructor(code, message, status = 0, details = null) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function createApi(baseUrl) {
  const base = new URL(baseUrl, window.location.href);

  async function request(path, { method = "GET", body } = {}) {
    let res;
    try {
      res = await fetch(new URL(path, base), {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: "same-origin",
        cache: "no-store",
        // An expired Access session answers with a redirect to the login page.
        redirect: "manual",
      });
    } catch {
      throw new ApiError("network", "Control server unreachable (network down or Worker unavailable).");
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
      throw new ApiError("session_expired", "Cloudflare Access session expired. Reload the page to sign in again.", res.status);
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok || !data || data.ok !== true) {
      const error = data?.error;
      throw new ApiError(
        error?.code || `http_${res.status}`,
        error?.message || `Control server error (HTTP ${res.status}).`,
        res.status,
        error?.details || null,
      );
    }
    return data;
  }

  function wsUrl(path) {
    const url = new URL(path, base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  const callPath = (id, action = "") => `calls/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

  return {
    session: () => request("session"),
    calls: () => request("calls"),
    call: (id, { select = false } = {}) => request(`${callPath(id)}${select ? "?select=1" : ""}`),
    say: (id, text, { endCallAfterSpoken = false, interruptAssistant = false } = {}) =>
      request(callPath(id, "say"), { method: "POST", body: { text, endCallAfterSpoken, interruptAssistant } }),
    instruction: (id, text, { triggerResponse = true } = {}) =>
      request(callPath(id, "instruction"), { method: "POST", body: { text, triggerResponse } }),
    phrases: () => request("phrases"),
    savePhrases: (phrases) => request("phrases", { method: "PUT", body: { phrases } }),
    control: (id, action) => request(callPath(id, "control"), { method: "POST", body: { action } }),
    dtmf: (id, keys) => request(callPath(id, "dtmf"), { method: "POST", body: { keys } }),
    end: (id) => request(callPath(id, "end"), { method: "POST", body: {} }),
    listenUrl: (id) => wsUrl(callPath(id, "listen")),
    eventsUrl: () => wsUrl("events"),
  };
}
