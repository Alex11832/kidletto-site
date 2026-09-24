// Test-only front door: lets one local `wrangler dev` process serve both
// Workers (so the webhook -> CallHub Durable Object call stays in-process).
// /vapi/events goes to the webhook Worker, everything else to the console.
//
// Like Cloudflare Access at the edge, it turns the CF_Authorization cookie
// into the Cf-Access-Jwt-Assertion header. That matters for requests a test
// cannot add headers to, such as the browser fetching the service worker.
export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/vapi/events") return env.HOOK.fetch(request);
    const cookie = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get("Cookie") || "");
    if (cookie && !request.headers.has("Cf-Access-Jwt-Assertion")) {
      const headers = new Headers(request.headers);
      headers.set("Cf-Access-Jwt-Assertion", cookie[1]);
      request = new Request(request, { headers });
    }
    return env.MAIN.fetch(request);
  },
};
