// Operator dictation recorder: the operator's own microphone, recorded only
// between an explicit tap on DICTATE and the tap that stops it. The recording
// is sent to the Worker for speech recognition; nothing is kept locally and
// the microphone is released as soon as recording stops.

// Compressed formats every current browser can record (Safari: mp4/AAC).
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];

export function dictationSupported() {
  return Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

export function pickMimeType() {
  if (typeof MediaRecorder.isTypeSupported !== "function") return "";
  return MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

export class Recorder {
  constructor({ maxMs = 45_000, onLimit } = {}) {
    this.maxMs = maxMs;
    this.onLimit = onLimit;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.limitTimer = null;
    this.done = null;
  }

  get recording() {
    return Boolean(this.recorder && this.recorder.state === "recording");
  }

  elapsedMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const mimeType = pickMimeType();
    try {
      this.recorder = new MediaRecorder(this.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
    } catch (error) {
      this.release();
      throw error;
    }
    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data?.size) this.chunks.push(event.data);
    };
    this.done = new Promise((resolve) => {
      this.recorder.onstop = resolve;
    });
    // A timeslice keeps data flowing, so a long take is not lost at stop.
    this.recorder.start(500);
    this.startedAt = Date.now();
    this.limitTimer = setTimeout(() => this.onLimit?.(), this.maxMs);
  }

  // Stops and returns the recording (a Blob), or null if nothing was captured.
  async stop() {
    clearTimeout(this.limitTimer);
    const recorder = this.recorder;
    if (!recorder) return null;
    if (recorder.state !== "inactive") recorder.stop();
    await this.done;
    const type = recorder.mimeType || this.chunks[0]?.type || "audio/webm";
    const blob = this.chunks.length ? new Blob(this.chunks, { type }) : null;
    this.release();
    return blob;
  }

  cancel() {
    clearTimeout(this.limitTimer);
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      // already stopped
    }
    this.release();
  }

  release() {
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
  }
}
