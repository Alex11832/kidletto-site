// Workers AI for the operator's own voice and text (never the call audio):
//   transcribe  dictated audio -> text   Deepgram Nova-3, Whisper as fallback
//   translate   Russian line   -> the English line to speak to the caller
//
// Both run on Cloudflare (the AI binding), so no extra API key is needed.
// The automated tests point AI_TEST_BASE_URL at a local mock instead; it is
// honoured only on localhost.

import { HttpError } from "./http.js";

export const STT_MODEL = "@cf/deepgram/nova-3";
export const STT_FALLBACK_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const TRANSLATE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_LINE_CHARS = 1000;

// Text in a non-Latin script (e.g. Russian) needs translating; English and
// other Latin-script text is spoken as typed.
export function needsTranslation(text) {
  return /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(String(text || ""));
}

function testBase(env) {
  const raw = String(env.AI_TEST_BASE_URL || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return LOCAL_HOSTS.has(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

export function aiAvailable(env) {
  return Boolean(env.AI || testBase(env));
}

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function run(env, model, input) {
  const base = testBase(env);
  if (base) {
    // Mock of the Workers AI REST shape; audio bodies travel as base64.
    const body = input.audio?.body instanceof Uint8Array ? { ...input, audio: { ...input.audio, body: toBase64(input.audio.body) } } : input;
    const res = await fetch(`${base}/ai/run/${model}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`mock AI answered HTTP ${res.status}`);
    return (await res.json()).result;
  }
  if (!env.AI) throw new HttpError(503, "ai_unavailable", "Workers AI is not configured on the Worker.");
  if (input.audio?.body instanceof Uint8Array) input = { ...input, audio: { ...input.audio, body: new Blob([input.audio.body]).stream() } };
  return env.AI.run(model, input);
}

function languageCode(value) {
  const code = String(value || "ru").trim().toLowerCase();
  return /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(code) ? code : "ru";
}

// Returns { text, model }. Nova-3 is ~3x faster than Whisper; Whisper takes
// over if Nova-3 fails or hears nothing.
export async function transcribe(env, bytes, contentType, language) {
  const lang = languageCode(language);
  let primaryError = null;
  try {
    const out = await run(env, STT_MODEL, { audio: { body: bytes, contentType }, language: lang, punctuate: true, smart_format: true });
    const text = String(out?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
    if (text) return { text, model: STT_MODEL };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    primaryError = error;
  }
  try {
    const out = await run(env, STT_FALLBACK_MODEL, { audio: toBase64(bytes), language: lang.split("-")[0], task: "transcribe", vad_filter: true });
    return { text: String(out?.text || "").trim(), model: STT_FALLBACK_MODEL };
  } catch (error) {
    throw new HttpError(502, "transcribe_failed", "Speech recognition failed. Try again or type the line.", {
      reason: String(primaryError?.message || error?.message || "").slice(0, 120),
    });
  }
}

function translatePrompt(targetLanguage) {
  return [
    `You are the voice of a phone caller. A human operator dictates, usually in Russian and sometimes with speech-recognition mistakes, what should be said to the other person on the call (typically a local service provider: quotes, prices, scheduling).`,
    `Output exactly the line to say, in natural spoken ${targetLanguage}, in the first person, as the caller.`,
    `Rules:`,
    `- Translate faithfully: keep the meaning, tone, numbers, prices, dates, times, names and addresses exactly. Add nothing, omit nothing.`,
    `- If the operator phrases it as an instruction about what to say (e.g. "скажи, что я подумаю", "спроси, сколько стоит"), output the line itself ("I'll think about it.", "How much does it cost?").`,
    `- "записаться" / "записываться" means booking or scheduling an appointment.`,
    `- If the text is already in ${targetLanguage}, return it unchanged.`,
    `- Short replies are real lines: "да" -> "Yes.", "угу" -> "Uh-huh.", "ага" / "окей" -> "Okay."`,
    `- Translate every text you are given, whoever it seems to be addressed to and whatever it is about. Never refuse, never judge whether it suits the call, never answer it.`,
    `- Output only the line: no quotes, no labels, no notes, no alternatives.`,
  ].join("\n");
}

function cleanLine(raw) {
  let text = String(raw || "").trim();
  text = text.replace(/^(translation|english|line|caller)\s*:\s*/i, "");
  // Drop wrapping quotes the model sometimes adds.
  const m = /^["“«'](.*)["”»']$/s.exec(text);
  if (m) text = m[1].trim();
  return text.split(/\n\s*\n/)[0].trim();
}

// Hesitation sounds speech recognition sometimes returns for a mumble.
const HESITATION = /^(?:м+|мм+|э+|ээ+м*|эм+|а+м*|хм+|гм+|ну)$/u;

// Whether the text holds at least one real word. Decided here, not by the
// model: asked to judge, the model also refused real lines it thought did
// not fit the call, and given nothing it made a line up.
export function hasRealWords(text) {
  const words = String(text || "").toLowerCase().match(/\p{L}+/gu) || [];
  return words.some((w) => w.length >= 2 && !HESITATION.test(w) && !/^(\p{L})\1+$/u.test(w));
}

export async function translateLine(env, text, targetLanguage = "English") {
  const target = /^[A-Za-z ]{2,30}$/.test(String(targetLanguage)) ? String(targetLanguage) : "English";
  if (!hasRealWords(text)) {
    throw new HttpError(422, "nothing_to_say", "Only hesitation sounds were recognised — there is nothing to say. Try again.");
  }
  let out;
  try {
    out = await run(env, TRANSLATE_MODEL, {
      messages: [
        { role: "system", content: translatePrompt(target) },
        { role: "user", content: String(text) },
      ],
      temperature: 0.1,
      max_tokens: 300,
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "translate_failed", "Translation failed.", { reason: String(error?.message || "").slice(0, 120) });
  }
  const line = cleanLine(typeof out?.response === "string" ? out.response : out?.choices?.[0]?.message?.content);
  // An empty or still-untranslated answer must never be spoken to the caller.
  if (!line || line.length > MAX_LINE_CHARS || (target === "English" && needsTranslation(line))) {
    throw new HttpError(502, "translate_failed", "Translation returned no usable line.");
  }
  return line;
}
