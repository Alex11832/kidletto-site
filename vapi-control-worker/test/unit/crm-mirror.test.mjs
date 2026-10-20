import test from 'node:test';
import assert from 'node:assert/strict';
import webhook from '../../src/webhook.js';

const callId = '11111111-1111-4111-8111-111111111111';
const request = secret => new Request('https://ingress.example/vapi/vivpod-events', {
  method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: { type: 'conversation-update', call: { id: callId }, messages: [{ role: 'assistant', message: 'Hello' }] } }),
});
test('CRM mirror uses its own credential and never the legacy credential', async () => {
  const response = await webhook.fetch(request('legacy'), { VAPI_WEBHOOK_SECRET: 'legacy', VIVPOD_EVENTS_SECRET: 'crm' });
  assert.equal(response.status, 401);
});
test('CRM mirror publishes live conversation once without legacy forwarding', async () => {
  const seen = [];
  const response = await webhook.fetch(request('crm'), {
    VAPI_WEBHOOK_SECRET: 'legacy', VIVPOD_EVENTS_SECRET: 'crm',
    WEBHOOK_FORWARD_URL: 'https://must-not-be-called.invalid/',
    HUB: { idFromName: () => 'hub', get: () => ({ fetch: async (_url, init) => { seen.push(JSON.parse(init.body)); return new Response('{}'); } }) },
  });
  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].callId, callId);
  assert.deepEqual(seen[0].messages.map(m => m.text), ['Hello']);
});
