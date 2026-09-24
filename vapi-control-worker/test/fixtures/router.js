// Test-only front door: lets one local `wrangler dev` process serve both
// Workers (so the webhook -> CallHub Durable Object call stays in-process).
// /vapi/events goes to the webhook Worker, everything else to the console.
export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    return pathname === "/vapi/events" ? env.HOOK.fetch(request) : env.MAIN.fetch(request);
  },
};
