// Receiving side of Web Push for the tests: a browser-like subscription and
// RFC 8291 decryption written against node:crypto, independent of the
// WebCrypto implementation in src/push.js.
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (s) => Buffer.from(String(s), "base64url");

export function decryptPush(body, uaPrivateB64, uaPublicB64, authB64) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen);
  const ecdh = nodeCrypto.createECDH("prime256v1");
  ecdh.setPrivateKey(fromB64url(uaPrivateB64));
  const shared = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), fromB64url(uaPublicB64), asPublic]);
  const ikm = Buffer.from(nodeCrypto.hkdfSync("sha256", shared, fromB64url(authB64), info, 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const data = buf.subarray(21 + idlen);
  const decipher = nodeCrypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, "last-record delimiter");
  return plain.subarray(0, end).toString("utf8");
}

// A subscription as a browser would create it, plus its private key.
export function fakeSubscription(endpoint) {
  const ecdh = nodeCrypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(nodeCrypto.randomBytes(16)) };
  return {
    subscription: { endpoint, expirationTime: null, keys },
    decrypt: (body) => JSON.parse(decryptPush(body, b64url(ecdh.getPrivateKey()), keys.p256dh, keys.auth)),
  };
}

export function vapidKeys() {
  const { publicKey, privateKey } = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = b64url(Buffer.concat([Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)]));
  return { publicKey: pub, privateKey: jwk.d, keyObject: publicKey };
}

// Checks the VAPID Authorization header (RFC 8292) and returns its claims.
export function verifyVapid(header, { publicKey, keyObject }) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(String(header || ""));
  assert.ok(m, `VAPID header: ${header}`);
  assert.equal(m[2], publicKey);
  const [h, c, s] = m[1].split(".");
  const ok = nodeCrypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: keyObject, dsaEncoding: "ieee-p1363" }, fromB64url(s));
  assert.equal(ok, true, "VAPID signature");
  return JSON.parse(fromB64url(c).toString());
}
