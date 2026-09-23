// Structured operational logging. Every log line is one JSON object so it is
// searchable in Workers Logs. Values under sensitive-looking keys are redacted
// and bearer tokens / monitor URLs are scrubbed from strings, so a careless
// call site cannot leak the Vapi key, Access JWTs or per-call capability URLs.

const SENSITIVE_KEY = /authorization|api[-_]?key|secret|token|cookie|jwt|password|listenurl|controlurl|assertion/i;
const BEARER = /bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const VAPI_MONITOR_URL = /\b(?:wss?|https?):\/\/[^\s"']*vapi\.ai\/[^\s"']*/gi;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function scrubString(value) {
  return String(value)
    .replace(BEARER, "Bearer [redacted]")
    .replace(JWT_LIKE, "[redacted-jwt]")
    .replace(VAPI_MONITOR_URL, "[redacted-vapi-url]");
}

export function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value !== "object") return value;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export function log(event, fields = {}) {
  const line = { evt: event, ts: new Date().toISOString(), ...redact(fields) };
  const level = event.endsWith("_error") || event.endsWith("_failed") ? "warn" : "log";
  console[level](JSON.stringify(line));
}
