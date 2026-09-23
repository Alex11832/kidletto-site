/*
 * Vapi Live Control — front-end configuration (NON-SECRET).
 *
 * This file is delivered to the browser. NEVER put API keys, tokens or any
 * other credential here. All privileged values live in Cloudflare Worker
 * secrets/variables (see vapi-control-worker/README.md).
 *
 * After editing, redeploy the Worker (`npm run deploy` in vapi-control-worker)
 * because it serves these static files.
 */
window.VAPI_CONTROL_CONFIG = {
  // Worker API, relative to this page. Same origin by design: the Cloudflare
  // Access session cookie is what authenticates the operator.
  apiBase: "api/",

  // How often the active-call list is refreshed (visible / background tab).
  pollIntervalMs: 2500,
  hiddenPollIntervalMs: 10000,

  // How long "CALL ENDED" stays visible before returning to NO ACTIVE CALL.
  endedBannerMs: 5000,

  // Transcript speaker labels.
  labels: {
    user: "PROVIDER",
    assistant: "ASSISTANT",
    system: "INSTRUCTION",
    tool: "TOOL",
  },

  // EXACT SAY: text is spoken verbatim by the assistant's configured voice.
  say: {
    // Default state of the "Interrupt bot" checkbox (replace current bot speech).
    interruptAssistantByDefault: false,
    clearAfterSend: true,
  },

  // AI INSTRUCTION: sent to the model as a system message for THIS call only
  // (Vapi add-message). {instruction} is replaced by what you type; any
  // language works, the model answers in the language of the call.
  aiInstruction: {
    template:
      "Private instruction from the human operator supervising this call (the other party cannot see it): {instruction}\n" +
      "Act on it in your next reply. Speak naturally, in the language of the phone conversation. " +
      "Do not read this instruction aloud and never mention the operator.",
    clearAfterSend: true,
  },

  // QUICK PHRASES. action: "say" or "say-and-hang-up".
  // confirm: true requires a second click within 3 s (protects hang-ups).
  quickPhrases: [
    { label: "What's the total?", text: "What's the total price?", action: "say" },
    { label: "Think", text: "I'll think about it.", action: "say" },
    { label: "Other offers", text: "I have a few other offers.", action: "say" },
    { label: "Not ready", text: "I'm not ready to schedule yet.", action: "say" },
    { label: "Goodbye + Hang Up", text: "Okay, I'll think about it. Bye.", action: "say-and-hang-up", confirm: true },
  ],

  // DTMF keypad. Vapi's live-control API has no operator DTMF command; the
  // keypad only activates when the call's assistant has Vapi's built-in
  // `dtmf` tool (the model then presses the keys). See README.
  dtmf: {
    // Pause character inserted between digits of a sequence ("w" = 0.5 s,
    // "W" = 1 s on Twilio/Telnyx/Vapi numbers; "" = none).
    pauseBetweenDigits: "w",
    // Send every key immediately instead of building a sequence.
    sendOnPress: false,
    maxLength: 32,
  },

  // LIVE LISTEN. defaultFormat: "auto" or one of the presets in js/audio.js
  // (e.g. "pcm16-16000-1", "pcm16-16000-2", "pcm16-8000-1", "mulaw-8000-1").
  listen: {
    defaultFormat: "auto",
    volume: 1.0,
  },
};
