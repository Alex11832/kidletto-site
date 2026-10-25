import { test } from "node:test";
import assert from "node:assert/strict";
import { createPromotionController } from "../../../vapi-control/js/promotions.js";
const snapshot = (extra = {}) => ({enabled: false, revision: 8, configured: true, priceCount: 2, ...extra});
const defer = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};

test("discount checkbox persists one CRM revision without needing or naming a selected call", async () => {
  const writes = [];
  const controller = createPromotionController({promotions: async () => snapshot(), savePromotions: async (...args) => {writes.push(args); return snapshot({enabled: true, revision: 9, live: {updated: 1, failed: 0}, sync: {synced: 1, errors: 0}});}});
  assert.equal(controller.canChange(), false);
  await controller.load();
  assert.equal(controller.canChange(), true);
  await controller.change(true);
  assert.deepEqual(writes, [[true, 8]]);
  assert.equal(controller.state.snapshot.enabled, true);
  assert.match(controller.state.notice, /1 active call received/);
});

test("an uncertain save reads persisted state instead of reversing it or silently retrying POST", async () => {
  let reads = 0, writes = 0;
  const controller = createPromotionController({promotions: async () => snapshot(++reads === 1 ? {} : {enabled: true, revision: 9}), savePromotions: async () => {writes++; throw new Error("Could not confirm change.");}});
  await controller.load();
  assert.equal(await controller.change(true), false);
  assert.equal(writes, 1);
  assert.equal(reads, 2);
  assert.equal(controller.state.snapshot.enabled, true);
  assert.equal(controller.state.error, "Could not confirm change.");
});

test("a failed reconciliation leaves the stale flag disabled and offers a readable error", async () => {
  let reads = 0;
  const controller = createPromotionController({promotions: async () => {if (++reads === 1) return snapshot(); throw new Error("CRM unreachable.");}, savePromotions: async () => {throw new Error("Unknown save outcome.");}});
  await controller.load();
  await controller.change(true);
  assert.equal(controller.canChange(), false);
  assert.equal(controller.state.error, "CRM unreachable.");
});

test("concurrent refresh and duplicate clicks cannot race a pending pricing change", async () => {
  const pending = defer();
  let writes = 0, reads = 0;
  const controller = createPromotionController({promotions: async () => {reads++; return snapshot();}, savePromotions: async () => {writes++; return pending.promise;}});
  await controller.load();
  const first = controller.change(true);
  assert.equal(controller.canChange(), false);
  assert.equal(await controller.change(true), false);
  assert.equal(await controller.load(), false);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  pending.resolve(snapshot({enabled: true, revision: 9}));
  await first;
  assert.equal(controller.state.snapshot.enabled, true);
});

test("not-configured prices cannot be enabled but an already-enabled flag can be switched off", async () => {
  const values = [];
  const controller = createPromotionController({promotions: async () => snapshot({configured: false, enabled: false, priceCount: 0}), savePromotions: async (...args) => {values.push(args); return snapshot({configured: false, enabled: false, priceCount: 0, revision: 9});}});
  await controller.load();
  assert.equal(await controller.change(true), false);
  controller.state.snapshot.enabled = true;
  assert.equal(controller.canChange(), true);
  await controller.change(false);
  assert.deepEqual(values, [[false, 8]]);
});

test("saved setting with failed live or assistant updates is shown as pending delivery", async () => {
  const controller = createPromotionController({promotions: async () => snapshot(), savePromotions: async () => snapshot({enabled: true, revision: 9, live: {updated: 1, failed: 2}, sync: {synced: 1, errors: 1}})});
  await controller.load();
  await controller.change(true);
  assert.equal(controller.state.snapshot.enabled, true);
  assert.equal(controller.state.warning, true);
  assert.match(controller.state.notice, /pending for 2 active calls and 1 assistant updates/);
});
