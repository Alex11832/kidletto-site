// Test identity provider: an RSA key pair that signs Cloudflare-Access-shaped
// JWTs and publishes its public key as a JWKS, like
// https://<team>.cloudflareaccess.com/cdn-cgi/access/certs does.

const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

export async function createTestIdp({ kid = "test-kid-1" } = {}) {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  const jwks = { keys: [{ kid, kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] };

  async function sign(claims, { header = {} } = {}) {
    const h = enc({ alg: "RS256", kid, typ: "JWT", ...header });
    const p = enc(claims);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${Buffer.from(sig).toString("base64url")}`;
  }

  function claimsFor({ teamDomain, aud, email, ttlS = 600, extra = {} }) {
    const now = Math.floor(Date.now() / 1000);
    return { iss: teamDomain, aud: [aud], email, sub: "user-1", iat: now, nbf: now - 1, exp: now + ttlS, type: "app", ...extra };
  }

  return { kid, jwks, sign, claimsFor };
}
