// Cloudflare Access authentication for every control-panel request.
//
// Cloudflare Access sits in front of the Worker and performs the login. On
// every request it forwards, Access adds a signed JWT in the
// `Cf-Access-Jwt-Assertion` header. Cloudflare's guidance is that the
// application must validate that JWT itself; otherwise anyone who reaches the
// Worker by another path (e.g. a misconfigured route) would bypass the login.
//
// Validation performed here (RS256 via WebCrypto, no dependencies):
//   - signature against the team's published keys (<team>/cdn-cgi/access/certs)
//   - `iss` equals TEAM_DOMAIN                        (required)
//   - `exp` / `nbf` with a small clock-skew allowance (required)
//   - an `email` identity, so service tokens cannot reach the panel (required)
//   - `aud` contains one of the POLICY_AUD values     (only if POLICY_AUD is set)
//   - the email is in ALLOWED_EMAILS                  (only if ALLOWED_EMAILS is set)
//
// Only TEAM_DOMAIN is required: without a trusted team domain there is no
// trustworthy source of signing keys, so a token could be forged. POLICY_AUD
// and ALLOWED_EMAILS are optional hardening on top of the Access policy; when
// they are missing the Worker still runs but reports a warning (see
// configWarnings, surfaced in the console header).
//
// Missing TEAM_DOMAIN fails closed (HTTP 503), never open.

import { parseList } from "./http.js";

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_MIN_REFRESH_MS = 30 * 1000;
const CLOCK_SKEW_S = 60;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Per-isolate cache of imported signing keys.
const jwksCache = new Map(); // certsUrl -> { fetchedAt, keys: Map<kid, CryptoKey> }

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// TEAM_DOMAIN may list several origins (comma or whitespace separated).
export function normalizeTeamDomains(value) {
  return parseList(value)
    .map(normalizeTeamDomain)
    .filter((domain, index, all) => domain && all.indexOf(domain) === index);
}

export function normalizeTeamDomain(value) {
  let v = String(value || "").trim().replace(/\/+$/, "");
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  let url;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  // Plain http is only tolerated for a local test identity provider.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  // A real team domain is <team>.cloudflareaccess.com; requiring a dot stops a
  // stray word in the list from silently becoming a trusted issuer.
  if (!url.hostname.includes(".") && !LOCAL_HOSTS.has(url.hostname)) return null;
  return url.origin;
}

function base64UrlToBytes(input) {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "===".slice((b64.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonSegment(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

async function loadKeys(certsUrl, fetchImpl) {
  const res = await fetchImpl(certsUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new AuthError(503, "access_keys_unavailable", "Could not load Cloudflare Access signing keys.");
  const body = await res.json();
  const keys = new Map();
  for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
    if (!jwk?.kid || jwk.kty !== "RSA") continue;
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      keys.set(jwk.kid, key);
    } catch {
      // Skip malformed keys; others may still be usable.
    }
  }
  const entry = { fetchedAt: Date.now(), keys };
  jwksCache.set(certsUrl, entry);
  return entry;
}

async function getSigningKey(teamDomain, kid, fetchImpl) {
  const certsUrl = `${teamDomain}/cdn-cgi/access/certs`;
  let entry = jwksCache.get(certsUrl);
  if (!entry || Date.now() - entry.fetchedAt > JWKS_TTL_MS) entry = await loadKeys(certsUrl, fetchImpl);
  let key = entry.keys.get(kid);
  // Unknown kid: Access may have rotated keys. Refresh once (rate limited).
  if (!key && Date.now() - entry.fetchedAt > JWKS_MIN_REFRESH_MS) {
    entry = await loadKeys(certsUrl, fetchImpl);
    key = entry.keys.get(kid);
  }
  return key || null;
}

export function _resetJwksCacheForTests() {
  jwksCache.clear();
}

// `teamDomain` may be a single origin or a list. A team can be reachable under
// more than one name (Cloudflare's auto-generated name plus a renamed one), and
// each serves its own signing keys, so every accepted issuer is listed
// explicitly by the operator. The issuer is checked against that list *before*
// any key is fetched, so keys are never loaded from a domain out of a token.
export async function verifyAccessJwt(token, { teamDomain, audiences, nowMs = Date.now(), fetchImpl = fetch }) {
  const issuers = (Array.isArray(teamDomain) ? teamDomain : [teamDomain]).filter(Boolean);
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new AuthError(401, "invalid_token", "Malformed Access token.");
  let header;
  let payload;
  try {
    header = decodeJsonSegment(parts[0]);
    payload = decodeJsonSegment(parts[1]);
  } catch {
    throw new AuthError(401, "invalid_token", "Malformed Access token.");
  }
  if (header?.alg !== "RS256" || !header.kid) throw new AuthError(401, "invalid_token", "Unsupported Access token algorithm.");

  // Trust the issuer first; only then is it allowed to supply signing keys.
  const issuer = typeof payload.iss === "string" ? payload.iss.replace(/\/+$/, "") : "";
  if (!issuers.includes(issuer)) throw new AuthError(401, "invalid_token", "Access token issuer mismatch.");

  const key = await getSigningKey(issuer, header.kid, fetchImpl);
  if (!key) throw new AuthError(401, "invalid_token", "Access token signed with an unknown key.");

  const signature = base64UrlToBytes(parts[2]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  if (!valid) throw new AuthError(401, "invalid_token", "Access token signature is invalid.");

  const now = Math.floor(nowMs / 1000);
  // An empty `audiences` means POLICY_AUD was left unset: every application of
  // this Access team is then accepted (configWarnings reports it).
  const tokenAud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (audiences.length > 0 && !tokenAud.some((aud) => audiences.includes(aud))) {
    throw new AuthError(403, "wrong_audience", "Access token is for a different application.");
  }
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < now) {
    throw new AuthError(401, "token_expired", "Access session expired.");
  }
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > now) {
    throw new AuthError(401, "invalid_token", "Access token not yet valid.");
  }
  return payload;
}

export function isDevBypassAllowed(request, env) {
  if (String(env.DEV_AUTH_BYPASS || "").toLowerCase() !== "true") return false;
  return LOCAL_HOSTS.has(new URL(request.url).hostname);
}

// Returns the authenticated identity or throws AuthError.
export async function authenticate(request, env, { fetchImpl = fetch } = {}) {
  if (isDevBypassAllowed(request, env)) return { email: "local-dev@localhost", dev: true };

  const teamDomains = normalizeTeamDomains(env.TEAM_DOMAIN);
  if (teamDomains.length === 0) {
    throw new AuthError(
      503,
      "access_not_configured",
      "Cloudflare Access is not configured on this Worker: set the TEAM_DOMAIN variable to https://<team>.cloudflareaccess.com.",
    );
  }
  const audiences = parseList(env.POLICY_AUD);
  const allowedEmails = parseList(env.ALLOWED_EMAILS).map((e) => e.toLowerCase());

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new AuthError(401, "unauthenticated", "Missing Cloudflare Access credentials.");

  const claims = await verifyAccessJwt(token, { teamDomain: teamDomains, audiences, fetchImpl });
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!email) throw new AuthError(403, "forbidden", "A user identity is required (service tokens are not accepted).");
  if (allowedEmails.length > 0 && !allowedEmails.includes(email)) {
    throw new AuthError(403, "forbidden", "This account is not authorized to use the control panel.");
  }
  return { email, sub: claims.sub || null };
}

// Non-fatal configuration gaps, shown in the console header so a weaker setup
// is visible instead of silent.
export function configWarnings(env) {
  const warnings = [];
  if (isDevBypassEnabled(env)) warnings.push("DEV_AUTH_BYPASS is on: requests to localhost skip the Access check.");
  if (normalizeTeamDomains(env.TEAM_DOMAIN).length === 0) return warnings;
  if (parseList(env.POLICY_AUD).length === 0) {
    warnings.push("POLICY_AUD is not set: any Cloudflare Access application of this team can reach the panel.");
  }
  if (parseList(env.ALLOWED_EMAILS).length === 0) {
    warnings.push("ALLOWED_EMAILS is not set: everyone your Access policy admits can control calls.");
  }
  return warnings;
}

function isDevBypassEnabled(env) {
  return String(env.DEV_AUTH_BYPASS || "").toLowerCase() === "true";
}
