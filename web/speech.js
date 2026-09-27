// Spoken replies. Natural voice (ChatGPT) when it's set up; otherwise the best voice
// installed on the phone (Enhanced/Premium voices sound far less robotic).
//
// iPhone only lets a page play sound after a tap, so unlockAudio() runs on the Talk tap;
// the same audio element is then reused for every reply.

import { api, LOCAL } from './api.js';

/** A tenth of a second of silence as a WAV, built here so it's always valid. */
function silentWav() {
  const samples = 800; // 0.1 s at 8 kHz, 8-bit mono
  const buf = new Uint8Array(44 + samples);
  const dv = new DataView(buf.buffer);
  const str = (o, t) => [...t].forEach((c, i) => (buf[o + i] = c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + samples, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);
  str(36, 'data'); dv.setUint32(40, samples, true);
  buf.fill(128, 44);
  let bin = '';
  buf.forEach((b) => (bin += String.fromCharCode(b)));
  return `data:audio/wav;base64,${btoa(bin)}`;
}
const SILENT = silentWav();
let audio;
let unlocked = false;
let voiceInfo = null; // { natural, voice }
let speakingNow = false;

export function audioEl() {
  if (!audio) {
    audio = new Audio();
    audio.setAttribute('playsinline', '');
    audio.preload = 'auto';
  }
  return audio;
}

/** Call inside a tap handler. */
export function unlockAudio() {
  if (unlocked) return;
  const a = audioEl();
  a.src = SILENT;
  a.play().then(() => { unlocked = true; }).catch(() => {});
  // Also wake speech synthesis (iOS needs a first utterance inside a gesture).
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance('');
    speechSynthesis.speak(u);
  }
}

export async function loadVoiceInfo() {
  if (LOCAL) return (voiceInfo = { natural: false });
  voiceInfo = await api('/api/voice').catch(() => ({ natural: false }));
  return voiceInfo;
}

export function setVoiceInfo(v) {
  voiceInfo = { ...(voiceInfo ?? {}), ...v };
}

export function isSpeaking() {
  return speakingNow;
}

export function stopSpeaking() {
  speakingNow = false;
  try { audio?.pause(); } catch {}
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// ---- the phone's own voices ------------------------------------------------

const PREFERRED = /(premium|enhanced|natural|neural|siri)/i;
const GOOD_NAMES = ['Serena', 'Stephanie', 'Kate', 'Martha', 'Arthur', 'Daniel', 'Samantha', 'Ava', 'Allison', 'Karen', 'Moira', 'Tessa', 'Zoe', 'Evan', 'Nathan', 'Google UK English Female', 'Google US English'];

export function deviceVoices() {
  if (!('speechSynthesis' in window)) return [];
  const lang = (navigator.language || 'en-GB').slice(0, 2);
  return speechSynthesis.getVoices().filter((v) => v.lang.startsWith(lang));
}

function chosenDeviceVoice() {
  const all = deviceVoices();
  let saved = null;
  try { saved = localStorage.getItem('bd.deviceVoice'); } catch {}
  if (saved) {
    const v = all.find((x) => x.voiceURI === saved);
    if (v) return v;
  }
  const exact = all.filter((v) => v.lang === (navigator.language || 'en-GB'));
  const pool = exact.length ? exact : all;
  return pool.find((v) => PREFERRED.test(v.name))
    ?? GOOD_NAMES.map((n) => pool.find((v) => v.name.startsWith(n))).find(Boolean)
    ?? pool.find((v) => v.localService)
    ?? pool[0];
}

export function setDeviceVoice(uri) {
  try { localStorage.setItem('bd.deviceVoice', uri); } catch {}
}

function speakOnDevice(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const v = chosenDeviceVoice();
    if (v) u.voice = v;
    u.lang = v?.lang || navigator.language || 'en-GB';
    u.rate = 1;
    u.pitch = 1;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    setTimeout(resolve, Math.min(25000, 2000 + text.length * 75)); // some browsers never fire onend
  });
}

// ---- natural voice ---------------------------------------------------------

async function speakNatural(text, voice) {
  const res = await api('/api/tts', { body: { text, voice }, raw: true });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = audioEl();
  return new Promise((resolve, reject) => {
    const done = () => { URL.revokeObjectURL(url); resolve(); };
    a.onended = done;
    a.onerror = () => { URL.revokeObjectURL(url); reject(new Error('playback')); };
    a.src = url;
    a.play().catch(reject);
  });
}

/** Speak a reply. Resolves when finished (or stopped). */
export async function speak(text, { voice } = {}) {
  if (!text) return;
  speakingNow = true;
  try {
    if (voiceInfo === null) await loadVoiceInfo();
    if (voiceInfo?.natural) {
      try {
        await speakNatural(text, voice ?? voiceInfo.voice);
        return;
      } catch {
        /* fall back to the phone's voice */
      }
    }
    if (speakingNow) await speakOnDevice(text);
  } finally {
    speakingNow = false;
  }
}

// Voices load asynchronously in some browsers.
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => {};
