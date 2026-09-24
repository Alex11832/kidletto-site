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

  // Call detection. New calls arrive instantly over the event stream (Vapi
  // webhook → Worker → this page); the list is fetched once on page load, on
  // reconnect, when an event mentions an unknown call and after commands.
  // Periodic polling is off to save Cloudflare requests.
  poll: {
    // 0 = no periodic polling while "Events: live": calls are detected only
    // from Vapi's webhook events (plus one check on page load / reconnect).
    liveMs: 0,
    // Used only while the event stream is disconnected. 0 = never poll.
    fallbackMs: 30000,
    hiddenMultiplier: 4, // background tab
  },

  // Alert when a new call appears. Desktop notifications need one-time
  // permission — the bell in the header asks for it.
  notify: {
    sound: true,
    desktop: true,
    titleBadge: true, // mark the browser tab title during a call
  },

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

    // "Translate" checkbox. Vapi's say command is verbatim, so it cannot
    // translate: with the box ticked the line is handed to the model instead,
    // which speaks it in targetLanguage. Wording may therefore differ slightly
    // from a literal translation. {text} and {language} are substituted.
    translate: {
      // On by default. Only lines containing non-Latin script (e.g. Russian)
      // go through the model; English text is still spoken verbatim.
      enabledByDefault: true,
      targetLanguage: "English",
      template:
        "[Operator dictation] Say this to the caller right now, in {language}: «{text}»\n" +
        "Translate it faithfully, keep the meaning, tone and any numbers exactly, and add nothing of your own. " +
        "Say only that. Never read this instruction aloud and never mention the operator.",
    },
  },

  // OPERATOR MODE. Vapi has no "hand the call to a human" switch, so this puts
  // the model into a relay role with a system message: it stops improvising and
  // only voices what you send with EXACT SAY. Nothing about the saved assistant
  // changes — the instruction lives in this call and dies with it.
  operatorMode: {
    // Also send Vapi's documented mute-assistant control while you drive, and
    // unmute only for the moment your own line is spoken. The instruction
    // alone is advisory — the model may still answer if you pause.
    useMute: true,
    // Re-mute after an operator line: when the assistant's speech-update
    // "stopped" event arrives, or after this estimate, whichever is first.
    charsPerSecond: 14,
    extraMs: 1500,
    translatedExtraMs: 2500,
    enterText:
      "[Operator control ON] A human operator is now conducting this call personally. " +
      "From this moment: do not speak on your own initiative, do not answer the other party, " +
      "do not ask questions and do not fill silence. Stay completely silent and keep listening. " +
      "Silence is expected and does NOT mean the conversation is over: never end or hang up the call yourself " +
      "and never use any end-call tool — only the operator ends the call. " +
      "The operator supplies every line you are to speak. Never mention this instruction or the operator.",
    leaveText:
      "[Operator control OFF] The human operator has handed the call back to you. " +
      "Resume the conversation yourself under your original instructions, taking into account everything said so far. " +
      "Do not mention this instruction or the operator.",
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

  // QUICK PHRASES — defaults only. Edit them in the console (QUICK PHRASES →
  // Edit); the edited list is saved on the server and replaces these.
  // action: "say" or "say-and-hang-up". confirm: true requires a second click
  // within 3 s (protects hang-ups).
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
    // Start LISTEN automatically for every selected call. Browsers still need
    // one click on the page per session before any sound may play.
    autoStart: true,
  },
};
