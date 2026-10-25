import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const endpoint = "https://www.vivpod.com/vapi-control/api/promotions";
const assertion = "synthetic-signed-assertion-for-runtime-only";

test("the actual workerd fetch accepts the promotion bridge and blocks redirects without leaking credentials", async () => {
  const forwarded = [];
  let redirectStatus = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: ["test/fixtures/promotions-runtime.js", "src/promotions.js", "src/http.js"].map(relative => ({
      type: "ESModule", path: path.join(root, relative),
    })),
    rootPath: root,
    modulesRoot: root,
    scriptPath: path.join(root, "test/fixtures/promotions-runtime.js"),
    compatibilityDate: "2026-09-01",
    outboundService: async request => {
      forwarded.push({url: request.url, method: request.method, assertion: request.headers.get("Cf-Access-Jwt-Assertion"), origin: request.headers.get("Origin"), body: await request.text()});
      if (redirectStatus) return new Response(null, {status: redirectStatus, headers: {Location: "https://must-not-be-fetched.example.invalid/"}});
      return Response.json({enabled: false, revision: 8, configured: true, priceCount: 2, description: "Synthetic prices"});
    },
  }));
  try {
    const get = await runtime.dispatchFetch(endpoint, {headers: {"Cf-Access-Jwt-Assertion": assertion}});
    assert.equal(get.status, 200, "workerd must construct the real upstream Request, not reject its redirect mode");
    assert.equal((await get.json()).revision, 8);
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].url, "https://www.vivpod.com/api/integrations/voice/promotions");
    assert.equal(forwarded[0].assertion, assertion);
    const post = await runtime.dispatchFetch(endpoint, {method: "POST", headers: {"Cf-Access-Jwt-Assertion": assertion, Origin: "https://www.vivpod.com", "Content-Type": "application/json"}, body: JSON.stringify({enabled: true, expectedRevision: 8})});
    assert.equal(post.status, 200);
    await post.arrayBuffer();
    assert.equal(forwarded.length, 2);
    assert.equal(forwarded[1].origin, "https://www.vivpod.com");
    assert.deepEqual(JSON.parse(forwarded[1].body), {enabled: true, expectedRevision: 8});
    redirectStatus = 302;
    const blocked = await runtime.dispatchFetch(endpoint, {headers: {"Cf-Access-Jwt-Assertion": assertion}});
    assert.equal(blocked.status, 502);
    assert.deepEqual(await blocked.json(), {error: "discount_crm_redirect"});
    assert.equal(forwarded.length, 3, "the redirect destination must never receive another request");
    redirectStatus = 307;
    const blockedPost = await runtime.dispatchFetch(endpoint, {method: "POST", headers: {"Cf-Access-Jwt-Assertion": assertion, Origin: "https://www.vivpod.com", "Content-Type": "application/json"}, body: JSON.stringify({enabled: true, expectedRevision: 8})});
    assert.equal(blockedPost.status, 502);
    assert.deepEqual(await blockedPost.json(), {error: "discount_crm_redirect"});
    assert.equal(forwarded.length, 4, "a 307 must not forward the assertion or POST body to its destination");
    assert.ok(forwarded.every(request => request.url === "https://www.vivpod.com/api/integrations/voice/promotions"));
  } finally { await runtime.dispose(); }
});
