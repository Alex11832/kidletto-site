// HTTP helpers shared by the API router: JSON responses, typed errors,
// security headers, request-body parsing and origin/CORS policy.

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Applied to every response the control panel Worker produces. The page never
// needs the microphone, camera or third-party scripts, so the browser is told
// to refuse them outright.
export const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Permissions-Policy": "microphone=(), camera=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Strict-Transport-Security": "max-age=31536000",
};

export function withSecurityHeaders(response, { noStore = true } = {}) {
  // Responses carrying a WebSocket must be returned untouched.
  if (response.webSocket || response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (noStore) headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export function apiError(status, code, message, details) {
  const error = { code, message };
  if (details) error.details = details;
  return json({ ok: false, error }, status);
}

const MAX_JSON_BODY_BYTES = 16 * 1024;

export async function readJsonBody(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected a JSON request body.");
  }
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_BYTES) {
    throw new HttpError(413, "payload_too_large", "Request body is too large.");
  }
  try {
    const body = JSON.parse(text || "{}");
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

export function parseList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// Origins allowed to make state-changing requests / open WebSockets:
// the Worker's own origin (the normal same-origin case) plus ALLOWED_ORIGINS.
export function allowedOrigins(request, env) {
  const self = new URL(request.url).origin;
  return new Set([self, ...parseList(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, ""))]);
}

// CSRF / cross-site WebSocket hijacking guard. Browsers always send Origin on
// POST and on WebSocket handshakes, so a missing Origin is treated as hostile.
export function assertOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(request, env).has(origin)) {
    throw new HttpError(403, "bad_origin", "Request origin is not allowed.");
  }
}

// CORS is only relevant for origins explicitly listed in ALLOWED_ORIGINS; the
// control panel itself is same-origin and never needs it. No wildcard, ever.
export function corsHeadersFor(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  const self = new URL(request.url).origin;
  if (origin === self) return null;
  if (!parseList(env.ALLOWED_ORIGINS).map((o) => o.replace(/\/+$/, "")).includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

export function preflightResponse(request, env) {
  const cors = corsHeadersFor(request, env);
  if (!cors) return new Response(null, { status: 403, headers: { Vary: "Origin" } });
  return new Response(null, {
    status: 204,
    headers: {
      ...cors,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
    },
  });
}

export function applyCors(response, request, env) {
  const cors = corsHeadersFor(request, env);
  if (!cors || response.webSocket || response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function isWebSocketUpgrade(request) {
  return (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
}
