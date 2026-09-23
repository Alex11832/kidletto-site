// Live Call Listen player.
//
// Vapi documents call.monitor.listenUrl as a WebSocket carrying raw PCM
// binary frames (plus occasional JSON text frames) but does not document the
// sample rate or channel count. The player therefore:
//   1. uses format hints from JSON text frames if Vapi sends any;
//   2. otherwise auto-detects from the stream itself: byte rate over ~1.5 s
//      gives rate x channels, and the sample-correlation pattern tells mono
//      from interleaved stereo;
//   3. lets the operator override the format (persisted locally).
// Output is mixed to mono so both sides of the call are heard in both ears.
// The microphone is never requested.

export const STANDARD_RATES = [8000, 16000, 24000, 32000, 44100, 48000];

export const FORMAT_PRESETS = {
  auto: null,
  "pcm16-16000-1": { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  "pcm16-16000-2": { encoding: "pcm_s16le", sampleRate: 16000, channels: 2 },
  "pcm16-8000-1": { encoding: "pcm_s16le", sampleRate: 8000, channels: 1 },
  "pcm16-8000-2": { encoding: "pcm_s16le", sampleRate: 8000, channels: 2 },
  "pcm16-24000-1": { encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  "pcm16-48000-1": { encoding: "pcm_s16le", sampleRate: 48000, channels: 1 },
  "mulaw-8000-1": { encoding: "mulaw", sampleRate: 8000, channels: 1 },
};

export function describeFormat(f) {
  if (!f) return "detecting…";
  const enc = f.encoding === "mulaw" ? "μ-law" : "PCM16";
  return `${enc} ${f.sampleRate / 1000} kHz ${f.channels === 2 ? "stereo" : "mono"}`;
}

export function snapRate(rate) {
  let best = STANDARD_RATES[0];
  for (const r of STANDARD_RATES) if (Math.abs(r - rate) < Math.abs(best - rate)) best = r;
  return best;
}

// Evidence for interleaved stereo in a block of int16 samples.
//   ratio   = mean|s[i]-s[i+1]| / mean|s[i]-s[i+2]|
//             mono speech: neighbours are close  -> ratio < 1
//             stereo: s[i], s[i+1] are different channels -> ratio > 1
//   balance = min(E_even, E_odd) / max(E_even, E_odd)
//             stereo with one silent side -> ~0; mono -> ~1
export function channelEvidence(samples) {
  let d1 = 0;
  let d2 = 0;
  let eEven = 0;
  let eOdd = 0;
  let n = 0;
  for (let i = 0; i + 2 < samples.length; i += 2) {
    const a = samples[i];
    const b = samples[i + 1];
    const c = samples[i + 2];
    d1 += Math.abs(a - b);
    d2 += Math.abs(a - c);
    eEven += a * a;
    eOdd += b * b;
    n++;
  }
  if (n === 0) return { verdict: "unknown" };
  const rms = Math.sqrt((eEven + eOdd) / (2 * n));
  if (rms < 60) return { verdict: "silent", rms };
  const ratio = d1 / Math.max(1, d2);
  const balance = Math.min(eEven, eOdd) / Math.max(1, Math.max(eEven, eOdd));
  let verdict = "unknown";
  if (balance < 0.15 || ratio > 1.15) verdict = "stereo";
  else if (ratio < 0.9 && balance > 0.35) verdict = "mono";
  return { verdict, ratio, balance, rms };
}

// bytesPerSecond: measured stream byte rate. samples: Int16Array of stream data.
export function detectFormat({ bytesPerSecond, samples, fallback = { sampleRate: 16000, channels: 1 } }) {
  const evidence = samples && samples.length > 64 ? channelEvidence(samples) : { verdict: "unknown" };
  const channels = evidence.verdict === "stereo" ? 2 : evidence.verdict === "mono" ? 1 : null;
  if (!(bytesPerSecond > 0)) {
    return { encoding: "pcm_s16le", sampleRate: fallback.sampleRate, channels: channels || fallback.channels, confidence: "low", evidence };
  }
  if (channels) {
    return { encoding: "pcm_s16le", sampleRate: snapRate(bytesPerSecond / (2 * channels)), channels, confidence: "high", evidence };
  }
  // No channel evidence (e.g. silence): pick the most plausible voice format
  // matching the byte rate; 16 kHz PCM is Vapi's documented default.
  const hit = PREFERRED_FORMATS.find(([rate, ch]) => Math.abs(rate * ch * 2 - bytesPerSecond) / bytesPerSecond < 0.12);
  if (hit) return { encoding: "pcm_s16le", sampleRate: hit[0], channels: hit[1], confidence: "medium", evidence };
  return { encoding: "pcm_s16le", sampleRate: snapRate(bytesPerSecond / 2), channels: 1, confidence: "low", evidence };
}

const PREFERRED_FORMATS = [
  [16000, 1],
  [16000, 2],
  [8000, 1],
  [8000, 2],
  [24000, 1],
  [24000, 2],
  [48000, 1],
  [44100, 1],
  [48000, 2],
  [32000, 1],
];

// Looks for sample-rate / channel hints in a JSON text frame.
export function extractFormatHint(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return null;
  const rate = Number(obj.sampleRate ?? obj.sample_rate ?? obj.sampleRateHz);
  const channels = Number(obj.channels ?? obj.numChannels ?? obj.channelCount ?? obj.num_channels);
  if (STANDARD_RATES.includes(rate)) {
    const enc = String(obj.encoding ?? obj.format ?? "").toLowerCase();
    return {
      encoding: enc.includes("mulaw") || enc.includes("ulaw") ? "mulaw" : "pcm_s16le",
      sampleRate: rate,
      channels: channels === 2 ? 2 : channels === 1 ? 1 : null,
    };
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const hint = extractFormatHint(value, depth + 1);
      if (hint) return hint;
    }
  }
  return null;
}

const MULAW_TABLE = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    table[i] = (sign ? -sample : sample) / 32768;
  }
  return table;
})();

// Decodes a byte block into mono float samples (channels mixed together).
export function decodeToMono(bytes, format) {
  if (format.encoding === "mulaw") {
    const frames = Math.floor(bytes.length / format.channels);
    const out = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let c = 0; c < format.channels; c++) sum += MULAW_TABLE[bytes[f * format.channels + c]];
      out[f] = Math.max(-1, Math.min(1, sum));
    }
    return out;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frameBytes = 2 * format.channels;
  const frames = Math.floor(bytes.byteLength / frameBytes);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < format.channels; c++) sum += view.getInt16(f * frameBytes + c * 2, true) / 32768;
    out[f] = Math.max(-1, Math.min(1, sum));
  }
  return out;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const DETECT_SECONDS = 1.5;
const DETECT_MAX_SECONDS = 6;
const TARGET_LATENCY_S = 0.12;
const MAX_BACKLOG_S = 0.6;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000];

export class ListenPlayer {
  // url: WebSocket URL (same-origin Worker endpoint)
  // formatKey: key of FORMAT_PRESETS; shouldReconnect(): false once the call ended
  constructor({ url, formatKey = "auto", volume = 1, onState = () => {}, onFormat = () => {}, shouldReconnect = () => true }) {
    this.url = url;
    this.formatKey = formatKey;
    this.volume = volume;
    this.onState = onState;
    this.onFormat = onFormat;
    this.shouldReconnect = shouldReconnect;
    this.stopped = true;
    this.attempt = 0;
    this.ws = null;
    this.ctx = null;
    this.gain = null;
    this.timer = null;
    this.format = null;
    this.resetStream();
  }

  resetStream() {
    this.format = FORMAT_PRESETS[this.formatKey] ? { ...FORMAT_PRESETS[this.formatKey], source: "manual" } : null;
    this.detectChunks = [];
    this.detectBytes = 0;
    this.detectFirstAt = 0;
    this.detectFirstBytes = 0;
    this.lastDetectEval = 0;
    this.remainder = null;
    this.nextTime = 0;
    if (this.format) this.onFormat(this.format);
  }

  setState(state, detail) {
    this.state = state;
    this.onState(state, detail);
  }

  async start() {
    this.stopped = false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: "interactive" });
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        // Browser autoplay policy; LISTEN is a click so this normally resolves.
      }
    }
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(this.ctx.destination);
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    this.setState(this.attempt > 0 ? "reconnecting" : "connecting");
    this.resetStream();
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect("error");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.setState("connected");
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data === "string") this.onText(event.data);
      else this.onBinary(new Uint8Array(event.data));
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.scheduleReconnect(event.code === 1000 ? "closed" : "lost");
    };
  }

  scheduleReconnect(reason) {
    if (this.stopped) return;
    if (!this.shouldReconnect() || this.attempt >= RECONNECT_DELAYS_MS.length) {
      this.stopped = true;
      this.closeAudio();
      this.setState(reason === "closed" ? "disconnected" : "error", reason === "closed" ? "Stream closed" : "Listen stream lost");
      return;
    }
    const delay = RECONNECT_DELAYS_MS[this.attempt++];
    this.setState("reconnecting", `retry in ${Math.round(delay / 1000)}s`);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  onText(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return;
    }
    if (this.format && this.format.source !== "auto") return;
    const hint = extractFormatHint(obj);
    if (hint) {
      this.format = { encoding: hint.encoding, sampleRate: hint.sampleRate, channels: hint.channels || 1, source: "stream" };
      this.onFormat(this.format);
      this.flushDetection();
    }
  }

  onBinary(bytes) {
    if (!bytes.length) return;
    if (!this.format) {
      const now = performance.now();
      if (!this.detectFirstAt) {
        this.detectFirstAt = now;
        this.detectFirstBytes = bytes.length;
      }
      this.detectChunks.push(bytes);
      this.detectBytes += bytes.length;
      const elapsed = (now - this.detectFirstAt) / 1000;
      if (elapsed >= DETECT_SECONDS && now - this.lastDetectEval >= 250) {
        this.lastDetectEval = now;
        const all = concat(this.detectChunks, this.detectBytes);
        const bytesPerSecond = (this.detectBytes - this.detectFirstBytes) / elapsed;
        // Channel evidence from the most recent ~1 s (speech after silence).
        const start = Math.max(0, all.length - Math.floor(bytesPerSecond)) & ~3;
        const samples = new Int16Array(all.buffer, start, (all.length - start) >> 1);
        const detected = detectFormat({ bytesPerSecond, samples });
        // While the line is silent nothing is lost by waiting for real audio.
        if (detected.confidence !== "high" && elapsed < DETECT_MAX_SECONDS) return;
        this.detectChunks = [all];
        this.format = { ...detected, source: "auto" };
        this.onFormat(this.format);
        this.flushDetection();
      }
      return;
    }
    this.play(bytes);
  }

  // Plays only the tail of what was buffered while detecting (low latency).
  flushDetection() {
    if (!this.detectChunks.length || !this.format) return;
    const all = concat(this.detectChunks, this.detectBytes);
    this.detectChunks = [];
    this.detectBytes = 0;
    const bytesPerSecond = this.format.sampleRate * this.format.channels * (this.format.encoding === "mulaw" ? 1 : 2);
    const frame = this.format.channels * (this.format.encoding === "mulaw" ? 1 : 2);
    let keep = Math.floor((bytesPerSecond * TARGET_LATENCY_S) / frame) * frame;
    keep = Math.min(keep, all.length - (all.length % frame));
    if (keep > 0) this.play(all.subarray(all.length - (all.length % frame) - keep, all.length - (all.length % frame)));
  }

  play(bytes) {
    if (!this.ctx || !this.format) return;
    const frame = this.format.channels * (this.format.encoding === "mulaw" ? 1 : 2);
    let data = bytes;
    if (this.remainder) {
      data = concat([this.remainder, bytes], this.remainder.length + bytes.length);
      this.remainder = null;
    }
    const extra = data.length % frame;
    if (extra) {
      this.remainder = data.slice(data.length - extra);
      data = data.subarray(0, data.length - extra);
    }
    if (!data.length) return;
    const mono = decodeToMono(data, this.format);
    const buffer = this.ctx.createBuffer(1, mono.length, this.format.sampleRate);
    buffer.copyToChannel(mono, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const now = this.ctx.currentTime;
    // Re-anchor when starved or when the backlog grows (keeps latency low).
    if (this.nextTime < now + 0.02 || this.nextTime > now + MAX_BACKLOG_S) this.nextTime = now + TARGET_LATENCY_S;
    source.start(this.nextTime);
    this.nextTime += buffer.duration;
  }

  setVolume(volume) {
    this.volume = volume;
    if (this.gain) this.gain.gain.value = volume;
  }

  setFormatKey(formatKey) {
    this.formatKey = formatKey;
    this.resetStream();
  }

  closeAudio() {
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
      this.gain = null;
    }
  }

  stop(reason = "stopped") {
    this.stopped = true;
    clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, "operator stopped listening");
      } catch {
        // ignore
      }
    }
    this.closeAudio();
    this.setState("disconnected", reason);
  }
}
