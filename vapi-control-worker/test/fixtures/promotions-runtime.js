// Test-only entry point. Requests still use workerd's native global fetch, but
// Miniflare routes every outbound request to the synthetic test service.
import { proxyPromotions } from "../../src/promotions.js";

export default {
  async fetch(request) {
    try {
      return await proxyPromotions(request, {ALLOWED_EMAILS: "owner@example.invalid", POLICY_AUD: "synthetic-audience"}, {email: "owner@example.invalid"});
    } catch (error) {
      return Response.json({error: error.code || "unexpected_failure"}, {status: error.status || 500});
    }
  },
};
