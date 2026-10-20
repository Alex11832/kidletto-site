// Unit tests for the browser modules in ../vapi-control/js (pure logic only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHubMessage, createTranscriptStore, speakingRoles, transcriptView } from "../../../vapi-control/js/transcript.js";
import { channelEvidence, decodeToMono, detectFormat, extractFormatHint } from "../../../vapi-control/js/audio.js";
import { callElapsedMs, formatDuration, shortId, statusLabel } from "../../../vapi-control/js/format.js";

const ID = "7420f27a-30fd-4f49-a995-5549ae7cc00d";
const texts = (store) => transcriptView(store.calls.get(ID)).map((i) => `${i.kind}:${i.role}:${i.text}`);

// ------------------------------------------------------------ transcript ---

test("partial -> final -> commit shows each line exactly once", () => {
  const s = createTranscriptStore();
  applyHubMessage(s, { type: "live", callId: ID, role: "user", transcriptType: "partial", text: "How", at: 100 });
  applyHubMessage(s, { type: "live", callId: ID, role: "user", transcriptType: "partial", text: "How many", at: 110 });
  assert.deepEqual(texts(s), ["partial:user:How many"]);
  applyHubMessage(s, { type: "live", callId: ID, role: "user", transcriptType: "final", text: "How many TVs?", at: 120 });
  assert.deepEqual(texts(s), ["pending:user:How many TVs?"]);
  // Duplicate final delivery is ignored
  applyHubMessage(s, { type: "live", callId: ID, role: "user", transcriptType: "final", text: "How many TVs?", at: 121 });
  assert.deepEqual(texts(s), ["pending:user:How many TVs?"]);
  // Stale partial after the final is ignored
  applyHubMessage(s, { type: "live", callId: ID, role: "user", transcriptType: "partial", text: "How many T", at: 115 });
  assert.deepEqual(texts(s), ["pending:user:How many TVs?"]);
  applyHubMessage(s, {
    type: "state",
    call: { callId: ID, status: "in-progress", conversationAt: 130, messages: [{ role: "user", text: "How many TVs?", time: 100 }] },
  });
  assert.deepEqual(texts(s), ["final:user:How many TVs?"]);
  applyHubMessage(s, { type: "live", callId: ID, role: "assistant", transcriptType: "partial", text: "On", at: 140 });
  assert.deepEqual(texts(s), ["final:user:How many TVs?", "partial:assistant:On"]);
  applyHubMessage(s, {
    type: "state",
    call: {
      callId: ID,
      status: "in-progress",
      conversationAt: 150,
      messages: [
        { role: "user", text: "How many TVs?", time: 100 },
        { role: "assistant", text: "One.", time: 140 },
      ],
    },
  });
  assert.deepEqual(texts(s), ["final:user:How many TVs?", "final:assistant:One."]);
});

test("commit racing the transcript event does not duplicate", () => {
  const s = createTranscriptStore();
  applyHubMessage(s, { type: "state", call: { callId: ID, status: "in-progress", conversationAt: 100, messages: [{ role: "assistant", text: "Drywall.", time: 90 }] } });
  // final arrives *after* the commit with a later timestamp
  applyHubMessage(s, { type: "live", callId: ID, role: "assistant", transcriptType: "final", text: "Drywall", at: 105 });
  assert.deepEqual(texts(s), ["final:assistant:Drywall."]);
});

test("older conversation snapshots never overwrite newer ones", () => {
  const s = createTranscriptStore();
  applyHubMessage(s, { type: "state", call: { callId: ID, status: "in-progress", conversationAt: 200, messages: [{ role: "user", text: "a" }, { role: "assistant", text: "b" }] } });
  applyHubMessage(s, { type: "state", call: { callId: ID, status: "in-progress", conversationAt: 100, messages: [{ role: "user", text: "a" }] } });
  assert.deepEqual(texts(s), ["final:user:a", "final:assistant:b"]);
});

test("ended call drops partials and speaking indicators", () => {
  const s = createTranscriptStore();
  applyHubMessage(s, { type: "speech", callId: ID, role: "user", status: "started", at: Date.now() });
  assert.deepEqual(speakingRoles(s.calls.get(ID)), ["user"]);
  applyHubMessage(s, { type: "live", callId: ID, role: "user", transcriptType: "partial", text: "bye", at: 10 });
  applyHubMessage(s, { type: "state", call: { callId: ID, status: "ended", endedReason: "customer-ended-call", conversationAt: 5, messages: [] } });
  assert.deepEqual(texts(s), []);
  assert.deepEqual(speakingRoles(s.calls.get(ID)), []);
  assert.equal(applyHubMessage(s, { type: "live", callId: ID, role: "user", transcriptType: "partial", text: "late", at: 20 }), null);
});

test("snapshot replaces state", () => {
  const s = createTranscriptStore();
  applyHubMessage(s, { type: "snapshot", calls: [{ callId: ID, status: "in-progress", conversationAt: 1, messages: [{ role: "user", text: "hi" }] }] });
  assert.deepEqual(texts(s), ["final:user:hi"]);
  applyHubMessage(s, { type: "removed", callId: ID });
  assert.equal(s.calls.has(ID), false);
});

// ----------------------------------------------------------------- audio ---

function speech(rate, seconds, seed = 1) {
  const n = Math.floor(rate * seconds);
  const out = new Int16Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    const t = i / rate;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t);
    const v = env * (0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 470 * t) + 0.15 * Math.sin(2 * Math.PI * 910 * t)) + 0.02 * (x / 2147483648 - 0.5);
    out[i] = Math.round(v * 12000);
  }
  return out;
}

function interleave(left, right) {
  const out = new Int16Array(left.length * 2);
  for (let i = 0; i < left.length; i++) {
    out[2 * i] = left[i];
    out[2 * i + 1] = right[i];
  }
  return out;
}

test("detects 16 kHz mono PCM", () => {
  const f = detectFormat({ bytesPerSecond: 32000, samples: speech(16000, 1) });
  assert.deepEqual([f.sampleRate, f.channels, f.confidence], [16000, 1, "high"]);
});

test("detects 8 kHz mono PCM", () => {
  const f = detectFormat({ bytesPerSecond: 16000, samples: speech(8000, 1) });
  assert.deepEqual([f.sampleRate, f.channels], [8000, 1]);
});

test("detects 16 kHz stereo with one silent side (and not 32 kHz mono)", () => {
  const samples = interleave(speech(16000, 1), new Int16Array(16000));
  const f = detectFormat({ bytesPerSecond: 64000, samples });
  assert.deepEqual([f.sampleRate, f.channels], [16000, 2]);
});

test("detects 8 kHz stereo with both parties talking (not 16 kHz mono)", () => {
  const samples = interleave(speech(8000, 1, 7), speech(8000, 1, 99).map((v, i) => (i % 3000 < 1500 ? v : 0)));
  const f = detectFormat({ bytesPerSecond: 32000, samples });
  assert.deepEqual([f.sampleRate, f.channels], [8000, 2]);
});

test("silence falls back to Vapi's documented 16 kHz PCM default", () => {
  const f = detectFormat({ bytesPerSecond: 32000, samples: new Int16Array(16000) });
  assert.equal(channelEvidence(new Int16Array(1000)).verdict, "silent");
  assert.deepEqual([f.sampleRate, f.channels, f.confidence], [16000, 1, "medium"]);
});

test("format hints in JSON frames are honoured", () => {
  assert.deepEqual(extractFormatHint({ type: "start", audioFormat: { sampleRate: 8000, channels: 2, encoding: "pcm_s16le" } }), {
    encoding: "pcm_s16le",
    sampleRate: 8000,
    channels: 2,
  });
  assert.equal(extractFormatHint({ type: "hello" }), null);
});

test("decodeToMono mixes stereo and decodes little-endian", () => {
  const bytes = new Uint8Array(new Int16Array([16384, 0, -16384, 0]).buffer);
  const mono = decodeToMono(bytes, { encoding: "pcm_s16le", channels: 2, sampleRate: 16000 });
  assert.deepEqual([...mono], [0.5, -0.5]);
  const mu = decodeToMono(new Uint8Array([0xff, 0x7f]), { encoding: "mulaw", channels: 1, sampleRate: 8000 });
  assert.ok(Math.abs(mu[0]) < 0.001 && Math.abs(mu[1]) < 0.001);
});

// ---------------------------------------------------------------- format ---

test("timer uses the real call start time and corrects clock skew", () => {
  const started = Date.parse("2026-09-23T10:00:00.000Z");
  const call = { startedAt: "2026-09-23T10:00:00.000Z" };
  assert.equal(formatDuration(callElapsedMs(call, started + 222_000, 0)), "03:42");
  // Browser clock 5 s behind the server
  assert.equal(formatDuration(callElapsedMs(call, started + 38_000, 5_000)), "00:43");
  assert.equal(callElapsedMs({ startedAt: null }, Date.now()), null);
  assert.equal(formatDuration(3_725_000), "1:02:05");
  assert.equal(shortId("7420f27a-30fd-4f49-a995-5549ae7cc00d"), "7420f27a…c00d");
  assert.equal(statusLabel("in-progress"), "ACTIVE");
});
