import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { proxyPromotions, promotionState, readPromotionBytes } from "../../src/promotions.js";
import { authenticate, _resetJwksCacheForTests } from "../../src/auth.js";
import { createTestIdp } from "../helpers/jwt.mjs";

const TEAM = "https://discount-test.cloudflareaccess.com";
const AUD = "d".repeat(64);
const env = { TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ALLOWED_EMAILS: "owner@example.invalid", VAPI_API_KEY: "synthetic-provider-secret-never-forward" };
const idp = await createTestIdp();
const claims = (extra = {}) => idp.claimsFor({ teamDomain: TEAM, aud: AUD, email: "owner@example.invalid", ...extra });
const state = (extra = {}) => ({enabled: false, revision: 8, configured: true, priceCount: 2, description: "Synthetic discount prices", ...extra});
const request = (token, body, options = {}) => new Request("https://www.vivpod.com/vapi-control/api/promotions", { method: body === undefined ? "GET" : "POST", headers: { "Cf-Access-Jwt-Assertion": token, Cookie: "synthetic-private-session", Authorization: "Bearer must-not-forward", ...(body === undefined ? {} : {"Content-Type": "application/json", Origin: "https://www.vivpod.com"}), ...options.headers }, ...(body === undefined ? {} : {body: JSON.stringify(body)}), ...options});
const jwksFetch = async () => new Response(JSON.stringify(idp.jwks));
beforeEach(() => _resetJwksCacheForTests());

test("valid Access owner reads the CRM flag and forwards only its verified assertion to the fixed same-origin endpoint", async () => {
  const token = await idp.sign(claims());
  const req = request(token);
  const identity = await authenticate(req, env, {fetchImpl: jwksFetch});
  const calls = [];
  const response = await proxyPromotions(req, env, identity, {fetchImpl: async (url, init) => {calls.push({url, init}); return new Response(JSON.stringify(state({hiddenPrompt: "do not expose", apiKey: "secret"})));}});
  assert.deepEqual(await response.json(), {ok: true, ...state()});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://www.vivpod.com/api/integrations/voice/promotions");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.method, "GET");
  assert.deepEqual(Object.keys(calls[0].init.headers), ["Cf-Access-Jwt-Assertion"]);
  assert.equal(calls[0].init.headers["Cf-Access-Jwt-Assertion"], token);
  assert.ok(!JSON.stringify(calls).includes(env.VAPI_API_KEY));
});

test("POST keeps one bounded enabled/revision change and returns sanitized delivery counts", async () => {
  const token = await idp.sign(claims());
  const req = request(token, {enabled: true, expectedRevision: 8});
  const identity = await authenticate(req, env, {fetchImpl: jwksFetch});
  const response = await proxyPromotions(req, env, identity, {fetchImpl: async (url, init) => {
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {enabled: true, expectedRevision: 8});
    assert.deepEqual(Object.keys(init.headers).sort(), ["Cf-Access-Jwt-Assertion", "Content-Type", "Origin"].sort());
    assert.equal(init.headers.Origin, "https://www.vivpod.com");
    return new Response(JSON.stringify(state({enabled: true, revision: 9, live: {updated: 1, failed: 1, privateCallIds: ["hidden"]}, sync: {synced: 2, errors: ["private-provider-error"]}})));
  }});
  assert.deepEqual(await response.json(), {ok: true, ...state({enabled: true, revision: 9, live: {updated: 1, failed: 1}, sync: {synced: 2, errors: 1}})});
});

test("expired, wrong-audience, tampered and non-owner Access identities cannot reach discount forwarding", async () => {
  const valid = await idp.sign(claims());
  const badTokens = [await idp.sign(claims({ttlS: -600})), await idp.sign(claims({aud: "x".repeat(64)})), await idp.sign(claims({email: "other@example.invalid"})), valid.slice(0, -4) + "xxxx"];
  for (const token of badTokens) await assert.rejects(authenticate(request(token), env, {fetchImpl: jwksFetch}));
  for (const [identity, settings] of [[{email: "local-dev@localhost", dev: true}, env], [{email: "other@example.invalid"}, env], [{email: "owner@example.invalid"}, {...env, POLICY_AUD: ""}], [{email: "owner@example.invalid"}, {...env, ALLOWED_EMAILS: ""}]]) {
    await assert.rejects(proxyPromotions(request(valid), settings, identity, {fetchImpl: async () => {throw new Error("must not call CRM");}}), {status: 403});
  }
});

test("wrong origin, unbounded bodies and free-form settings fail before any CRM request", async () => {
  const token = await idp.sign(claims());
  const identity = {email: "owner@example.invalid"};
  const never = {fetchImpl: async () => {throw new Error("must not call CRM");}};
  for (const body of [{enabled: true, expectedRevision: 8, prompt: "override prices"}, {enabled: true, expectedRevision: 8, accountId: 7}, {enabled: "true", expectedRevision: 8}, {enabled: true, expectedRevision: -1}, {enabled: true, expectedRevision: 1.5}, {enabled: true, expectedRevision: 8, filler: "x".repeat(2000)}]) await assert.rejects(proxyPromotions(request(token, body), env, identity, never), error => error.status === 400 || error.status === 413);
  const csrf = request(token, {enabled: true, expectedRevision: 8});
  csrf.headers.set("Origin", "https://evil.invalid");
  await assert.rejects(proxyPromotions(csrf, env, identity, never), {code: "bad_origin"});
  for (const origin of ["https://kidletto.com", "https://www.kidletto.com", "https://www.vivpod.com.evil.invalid", null]) {
    const crossSite = request(token, {enabled: true, expectedRevision: 8});
    if (origin) crossSite.headers.set("Origin", origin); else crossSite.headers.delete("Origin");
    await assert.rejects(proxyPromotions(crossSite, {...env, ALLOWED_ORIGINS: "https://kidletto.com"}, identity, never), {code: "bad_origin"});
  }
  const wrongHost = new Request("https://kidletto.com/vapi-control/api/promotions", {headers: {"Cf-Access-Jwt-Assertion": token}});
  await assert.rejects(proxyPromotions(wrongHost, env, identity, never), {code: "discount_origin_required"});
});

test("chunked bodies stop at the byte cap without reading the whole stream", async () => {
  let pulled = 0, cancelled = false;
  const body = new ReadableStream({pull(controller) {pulled++; controller.enqueue(new Uint8Array(800));}, cancel() {cancelled = true;}});
  await assert.rejects(readPromotionBytes({headers: new Headers(), body}, 1024), {code: "payload_too_large"});
  assert.equal(cancelled, true);
  assert.ok(pulled <= 3);
});

test("a valid 3000-character unicode description fits the bounded upstream response", async () => {
  const token = await idp.sign(claims());
  const description = "客".repeat(3000);
  const response = await proxyPromotions(request(token), env, {email: "owner@example.invalid"}, {fetchImpl: async () => new Response(JSON.stringify(state({description})))});
  assert.equal((await response.json()).description, description);
  let cancelled = false;
  const oversized = new ReadableStream({pull(controller) {controller.enqueue(new Uint8Array(20000));}, cancel() {cancelled = true;}});
  await assert.rejects(proxyPromotions(request(token), env, {email: "owner@example.invalid"}, {fetchImpl: async () => new Response(oversized)}), {code: "invalid_promotion_state"});
  assert.equal(cancelled, true);
});

test("conflict and uncertain delivery never expose upstream errors or a made-up saved state", async () => {
  const token = await idp.sign(claims());
  const identity = {email: "owner@example.invalid"};
  await assert.rejects(proxyPromotions(request(token, {enabled: true, expectedRevision: 8}), env, identity, {fetchImpl: async () => new Response("private upstream prompt and key", {status: 409})}), error => error.code === "discount_conflict" && !error.message.includes("private"));
  await assert.rejects(proxyPromotions(request(token), env, identity, {fetchImpl: async () => {throw new Error("token secret");}}), {code: "discount_crm_unavailable"});
  await assert.rejects(proxyPromotions(request(token), env, identity, {fetchImpl: async () => new Response(JSON.stringify({enabled: true}))}), {code: "invalid_promotion_state"});
  assert.throws(() => promotionState(state({revision: 1.5})), {code: "invalid_promotion_state"});
});
