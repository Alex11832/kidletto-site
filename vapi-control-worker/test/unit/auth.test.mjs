import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { authenticate, configWarnings, normalizeTeamDomain, normalizeTeamDomains, verifyAccessJwt, _resetJwksCacheForTests } from "../../src/auth.js";
import { createTestIdp } from "../helpers/jwt.mjs";

const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "a".repeat(64);
const idp = await createTestIdp();
const jwksRequests = [];
const jwksFetch = async (url) => {
  jwksRequests.push(String(url));
  assert.match(String(url), /\/cdn-cgi\/access\/certs$/);
  return new Response(JSON.stringify(idp.jwks), { headers: { "Content-Type": "application/json" } });
};
const env = { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ALLOWED_EMAILS: "operator@example.com, second@example.com" };
const req = (token, host = "kidletto-vapi-control.example.workers.dev") =>
  new Request(`https://${host}/vapi-control/api/session`, { headers: token ? { "Cf-Access-Jwt-Assertion": token } : {} });

beforeEach(() => _resetJwksCacheForTests());

test("valid Access JWT for an allowed email is accepted", async () => {
  const token = await idp.sign(idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: "Operator@Example.com" }));
  const identity = await authenticate(req(token), env, { fetchImpl: jwksFetch });
  assert.equal(identity.email, "operator@example.com");
});

test("missing token is rejected with 401", async () => {
  await assert.rejects(authenticate(req(null), env, { fetchImpl: jwksFetch }), { status: 401, code: "unauthenticated" });
});

test("wrong audience is rejected", async () => {
  const token = await idp.sign(idp.claimsFor({ teamDomain: TEAM, aud: "b".repeat(64), email: "operator@example.com" }));
  await assert.rejects(authenticate(req(token), env, { fetchImpl: jwksFetch }), { status: 403, code: "wrong_audience" });
});

test("wrong issuer is rejected", async () => {
  const token = await idp.sign(idp.claimsFor({ teamDomain: "https://evil.cloudflareaccess.com", aud: AUD, email: "operator@example.com" }));
  await assert.rejects(authenticate(req(token), env, { fetchImpl: jwksFetch }), { status: 401, code: "invalid_token" });
});

test("expired token is rejected", async () => {
  const token = await idp.sign(idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: "operator@example.com", ttlS: -600 }));
  await assert.rejects(authenticate(req(token), env, { fetchImpl: jwksFetch }), { status: 401, code: "token_expired" });
});

test("tampered payload fails signature verification", async () => {
  const token = await idp.sign(idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: "someone@example.com" }));
  const [h, , s] = token.split(".");
  const forged = Buffer.from(JSON.stringify(idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: "operator@example.com" }))).toString("base64url");
  await assert.rejects(authenticate(req(`${h}.${forged}.${s}`), env, { fetchImpl: jwksFetch }), { status: 401, code: "invalid_token" });
});

test("token signed by a different key is rejected", async () => {
  const other = await createTestIdp({ kid: idp.kid });
  const token = await other.sign(other.claimsFor({ teamDomain: TEAM, aud: AUD, email: "operator@example.com" }));
  await assert.rejects(authenticate(req(token), env, { fetchImpl: jwksFetch }), { status: 401, code: "invalid_token" });
});

test("alg=none / HS256 tokens are rejected", async () => {
  const claims = Buffer.from(JSON.stringify(idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: "operator@example.com" }))).toString("base64url");
  for (const alg of ["none", "HS256"]) {
    const header = Buffer.from(JSON.stringify({ alg, kid: idp.kid })).toString("base64url");
    await assert.rejects(authenticate(req(`${header}.${claims}.`), env, { fetchImpl: jwksFetch }), { status: 401 });
  }
});

test("service tokens (no email) are rejected", async () => {
  const token = await idp.sign(idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: undefined, extra: { common_name: "svc.access" } }));
  await assert.rejects(authenticate(req(token), env, { fetchImpl: jwksFetch }), { status: 403, code: "forbidden" });
});

test("email outside ALLOWED_EMAILS is rejected even with a valid Access token", async () => {
  const token = await idp.sign(idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: "intruder@example.com" }));
  await assert.rejects(authenticate(req(token), env, { fetchImpl: jwksFetch }), { status: 403, code: "forbidden" });
});

test("missing TEAM_DOMAIN fails closed with 503", async () => {
  for (const bad of ["", "   ", "not a url"]) {
    await assert.rejects(authenticate(req("x.y.z"), { ...env, TEAM_DOMAIN: bad }, { fetchImpl: jwksFetch }), {
      status: 503,
      code: "access_not_configured",
    });
  }
});

test("POLICY_AUD and ALLOWED_EMAILS are optional, but reported as warnings", async () => {
  const minimal = { TEAM_DOMAIN: TEAM };
  // Any email identity of the team is accepted, from any of its applications.
  const token = await idp.sign(idp.claimsFor({ teamDomain: TEAM, aud: "f".repeat(64), email: "anyone@example.com" }));
  const identity = await authenticate(req(token), minimal, { fetchImpl: jwksFetch });
  assert.equal(identity.email, "anyone@example.com");
  const warnings = configWarnings(minimal).join(" ");
  assert.match(warnings, /POLICY_AUD/);
  assert.match(warnings, /ALLOWED_EMAILS/);
  // A forged or expired token is still rejected with the minimal configuration.
  await assert.rejects(authenticate(req("x.y.z"), minimal, { fetchImpl: jwksFetch }), { status: 401 });
  const expired = await idp.sign(idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: "a@b.c", ttlS: -600 }));
  await assert.rejects(authenticate(req(expired), minimal, { fetchImpl: jwksFetch }), { status: 401, code: "token_expired" });
  const foreign = await createTestIdp({ kid: idp.kid });
  const foreignToken = await foreign.sign(foreign.claimsFor({ teamDomain: TEAM, aud: AUD, email: "a@b.c" }));
  await assert.rejects(authenticate(req(foreignToken), minimal, { fetchImpl: jwksFetch }), { status: 401, code: "invalid_token" });
  // Service tokens stay out even without an email allowlist.
  const service = await idp.sign(idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: undefined, extra: { common_name: "svc" } }));
  await assert.rejects(authenticate(req(service), minimal, { fetchImpl: jwksFetch }), { status: 403, code: "forbidden" });
  // Fully configured: no warnings.
  assert.deepEqual(configWarnings(env), []);
  assert.match(configWarnings({ ...env, DEV_AUTH_BYPASS: "true" }).join(" "), /DEV_AUTH_BYPASS/);
});

test("DEV_AUTH_BYPASS only works on localhost", async () => {
  const devEnv = { DEV_AUTH_BYPASS: "true" };
  const local = await authenticate(req(null, "127.0.0.1:8787"), devEnv);
  assert.equal(local.dev, true);
  await assert.rejects(authenticate(req(null, "kidletto.com"), devEnv), { status: 503 });
  await assert.rejects(authenticate(req(null, "kidletto-vapi-control.example.workers.dev"), { ...env, DEV_AUTH_BYPASS: "true" }, { fetchImpl: jwksFetch }), {
    status: 401,
  });
});

test("team domain normalization rejects non-https (except localhost)", () => {
  assert.equal(normalizeTeamDomain("example-team.cloudflareaccess.com/"), TEAM);
  assert.equal(normalizeTeamDomain("http://example-team.cloudflareaccess.com"), null);
  assert.equal(normalizeTeamDomain("https://x.cloudflareaccess.com/path"), null);
  assert.equal(normalizeTeamDomain("http://127.0.0.1:9999"), "http://127.0.0.1:9999");
  // A bare word must not become a trusted issuer.
  assert.equal(normalizeTeamDomain("not"), null);
  assert.deepEqual(normalizeTeamDomains("not a url"), []);
});

test("verifyAccessJwt accepts aud given as a string", async () => {
  const token = await idp.sign({ ...idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: "operator@example.com" }), aud: AUD });
  const claims = await verifyAccessJwt(token, { teamDomain: TEAM, audiences: [AUD], fetchImpl: jwksFetch });
  assert.equal(claims.email, "operator@example.com");
});

test("TEAM_DOMAIN accepts several team names; keys come from the token's own issuer", async () => {
  const ALT = "https://plain-lake-24f1.cloudflareaccess.com";
  const multi = { ...env, TEAM_DOMAIN: `${TEAM}, ${ALT}` };
  assert.deepEqual(normalizeTeamDomains(multi.TEAM_DOMAIN), [TEAM, ALT]);
  for (const issuer of [TEAM, ALT]) {
    _resetJwksCacheForTests();
    jwksRequests.length = 0;
    const token = await idp.sign(idp.claimsFor({ teamDomain: issuer, aud: AUD, email: "operator@example.com" }));
    const identity = await authenticate(req(token), multi, { fetchImpl: jwksFetch });
    assert.equal(identity.email, "operator@example.com");
    assert.deepEqual(jwksRequests, [`${issuer}/cdn-cgi/access/certs`]);
  }
  // An issuer outside the list is refused, and its keys are never fetched.
  _resetJwksCacheForTests();
  jwksRequests.length = 0;
  const evil = await idp.sign(idp.claimsFor({ teamDomain: "https://evil.cloudflareaccess.com", aud: AUD, email: "operator@example.com" }));
  await assert.rejects(authenticate(req(evil), multi, { fetchImpl: jwksFetch }), { status: 401, code: "invalid_token" });
  assert.deepEqual(jwksRequests, [], "keys must not be fetched from an untrusted issuer");
});
