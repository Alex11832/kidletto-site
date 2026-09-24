// Web Push crypto (src/push.js): RFC 8291 test vector, an independent
// decryption with node:crypto, and VAPID JWT verification.
import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { decryptPush } from "../helpers/webpush.mjs";
import { b64urlDecode, b64urlEncode, encryptPayload, validateSubscription, vapidAuthorization } from "../../src/push.js";

// RFC 8291, Appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  message:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function importEcdh(pubB64, privB64) {
  const raw = b64urlDecode(pubB64);
  const jwk = { kty: "EC", crv: "P-256", x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33)), d: privB64, ext: true };
  return {
    privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, true, []),
  };
}

test("aes128gcm encryption matches the RFC 8291 test vector byte for byte", async () => {
  const body = await encryptPayload(new TextEncoder().encode(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, {
    localKeys: await importEcdh(RFC.asPublic, RFC.asPrivate),
    salt: b64urlDecode(RFC.salt),
  });
  assert.equal(b64urlEncode(body), RFC.message);
  assert.equal(decryptPush(body, RFC.uaPrivate, RFC.uaPublic, RFC.auth), RFC.plaintext);
});

test("a fresh message decrypts with the subscriber's key (random salt and sender key)", async () => {
  const ecdh = nodeCrypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const sub = { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(nodeCrypto.randomBytes(16)) };
  const text = JSON.stringify({ title: "📞 Incoming call", body: "+1 555 000 1111 — Звонок" });
  const a = await encryptPayload(new TextEncoder().encode(text), sub);
  const b = await encryptPayload(new TextEncoder().encode(text), sub);
  assert.notEqual(b64urlEncode(a), b64urlEncode(b), "every message uses a new salt and key");
  assert.equal(decryptPush(a, b64urlEncode(ecdh.getPrivateKey()), sub.p256dh, sub.auth), text);
});

test("VAPID authorization is a valid ES256 JWT for the push service origin", async () => {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = b64urlEncode(Buffer.concat([Buffer.from([4]), Buffer.from(b64urlDecode(jwk.x)), Buffer.from(b64urlDecode(jwk.y))]));
  const env = { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: jwk.d, VAPID_SUBJECT: "https://kidletto.com" };
  const now = Math.floor(Date.now() / 1000);
  const auth = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc:def", env, now);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
  assert.ok(m, auth);
  assert.equal(m[2], pub);
  const [h, c, s] = m[1].split(".");
  assert.deepEqual(JSON.parse(Buffer.from(b64urlDecode(h)).toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(b64urlDecode(c)).toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "https://kidletto.com");
  assert.ok(claims.exp > now && claims.exp <= now + 24 * 3600, "exp within 24 h (RFC 8292)");
  const ok = nodeCrypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(b64urlDecode(s)));
  assert.equal(ok, true, "signature verifies with the public key");
});

test("subscriptions are accepted only for known push services with valid keys", () => {
  const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };
  const prod = {};
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-bl2p.notify.windows.com/w/?token=x",
    "https://web.push.apple.com/QGx",
  ]) {
    assert.equal(validateSubscription({ endpoint, keys }, prod).endpoint, endpoint);
  }
  for (const endpoint of ["https://evil.example/push", "http://fcm.googleapis.com/x", "http://127.0.0.1:9/push", "notaurl"]) {
    assert.throws(() => validateSubscription({ endpoint, keys }, prod), /push|endpoint/i, endpoint);
  }
  assert.throws(() => validateSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "AAAA", auth: RFC.auth } }, prod));
  // Local endpoints only in the automated tests (local Vapi mock configured).
  assert.ok(validateSubscription({ endpoint: "http://127.0.0.1:9/push", keys }, { VAPI_API_BASE_URL: "http://127.0.0.1:5000" }));
});
