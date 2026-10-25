import { HttpError, json, parseList } from "./http.js";

// This route is deliberately fixed: the Access assertion must never reach an
// operator-supplied URL, another tenant, a redirect, or the Vapi API.
const CRM_PROMOTIONS_URL = "https://www.vivpod.com/api/integrations/voice/promotions";
const MAX_BODY_BYTES = 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const count = (value) => Array.isArray(value) ? value.length : Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Enforce the cap while reading, including a chunked body with no length. */
export async function readPromotionBytes(message, maximum) {
  const declared = Number(message.headers.get("Content-Length") || 0);
  if (declared > maximum) throw new HttpError(413, "payload_too_large", "Discount settings are too large.");
  if (!message.body) return new Uint8Array();
  const reader = message.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, "payload_too_large", "Discount settings are too large.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {result.set(chunk, offset); offset += chunk.byteLength;}
  return result;
}

export function promotionState(value) {
  if (!value || typeof value !== "object" || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.configured !== "boolean" || !Number.isSafeInteger(value.priceCount) || value.priceCount < 0) {
    throw new HttpError(502, "invalid_promotion_state", "The CRM returned an invalid discount status. Refresh before changing discounts.");
  }
  return {
    enabled: value.enabled,
    revision: value.revision,
    configured: value.configured,
    priceCount: value.priceCount,
    description: typeof value.description === "string" ? value.description.slice(0, 3000) : "",
    ...(value.live && typeof value.live === "object" ? { live: { updated: count(value.live.updated), failed: count(value.live.failed) } } : {}),
    ...(value.sync && typeof value.sync === "object" ? { sync: { synced: count(value.sync.synced), errors: count(value.sync.errors) } } : {}),
  };
}

/** Identity was cryptographically verified by the Worker's existing Access
 * middleware. CRM independently verifies the exact same signed assertion. */
export async function proxyPromotions(request, env, identity, { fetchImpl = fetch } = {}) {
  if (request.method !== "GET" && request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  const allowed = parseList(env.ALLOWED_EMAILS).map((email) => email.toLowerCase());
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (identity?.dev || !assertion || !identity?.email || !allowed.includes(identity.email.toLowerCase()) || !parseList(env.POLICY_AUD).length) {
    throw new HttpError(403, "discount_access_required", "Discount controls require the configured owner's Cloudflare Access session.");
  }
  if (new URL(request.url).origin !== new URL(CRM_PROMOTIONS_URL).origin) throw new HttpError(403, "discount_origin_required", "Open the control panel on www.vivpod.com to manage discounts.");
  let body;
  if (request.method === "POST") {
    if (request.headers.get("Origin") !== new URL(CRM_PROMOTIONS_URL).origin) throw new HttpError(403, "bad_origin", "Discount changes must come from www.vivpod.com.");
    if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Expected a JSON request body.");
    let value;
    try {
      const bytes = await readPromotionBytes(request, MAX_BODY_BYTES);
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "invalid_discount_settings", "Expected a discount checkbox value and its saved revision.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) throw new HttpError(400, "invalid_discount_settings", "Expected only enabled and expectedRevision.");
    body = JSON.stringify({ enabled: value.enabled, expectedRevision: value.expectedRevision });
  }
  const headers = { "Cf-Access-Jwt-Assertion": assertion, ...(body ? { "Content-Type": "application/json", Origin: new URL(CRM_PROMOTIONS_URL).origin } : {}) };
  let response;
  try {
    response = await fetchImpl(CRM_PROMOTIONS_URL, { method: request.method, headers, ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(20000) });
  } catch {
    throw new HttpError(502, "discount_crm_unavailable", "Could not confirm the saved discount setting. Refresh before trying again.");
  }
  if (!response.ok) {
    const status = [400, 401, 403, 409, 503].includes(response.status) ? response.status : 502;
    const message = status === 409 ? "Discount settings changed elsewhere. Refresh and try again." : status === 401 || status === 403 ? "The CRM could not authorize this discount change. Sign in again." : status === 400 ? "Configure discounted prices in the CRM before enabling discounts." : "Discount settings are unavailable. Refresh or open the CRM to review them.";
    throw new HttpError(status, status === 409 ? "discount_conflict" : "discount_crm_rejected", message);
  }
  let value;
  try {
    const bytes = await readPromotionBytes(response, MAX_RESPONSE_BYTES);
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(502, "invalid_promotion_state", "The CRM returned an invalid discount status. Refresh before changing discounts.");
  }
  return json({ ok: true, ...promotionState(value) });
}
