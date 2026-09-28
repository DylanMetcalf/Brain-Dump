// Voice: tap, talk as long as you like, and stop. Brain Dump waits for a natural pause
// (about two seconds of quiet) before it treats what you said as one thought, then
// answers. It only listens again if it asked you something. No "that's all" needed.
//
// Works with the browser's own speech recognition, started only by a tap. When the
// phone takes the microphone away (you switch apps), nothing you said is lost.

import { speak as speakReply, stopSpeaking, isSpeaking, unlockAudio } from './speech.js';
import { native } from './device.js';

/**
 * Inside the Brain Dump iPhone app, speech comes from Apple's own recogniser (on-device where
 * available) through the bridge, shaped like the browser's SpeechRecognition so the rest of
 * this file doesn't care which one it's talking to.
 */
class NativeRecognition {
  constructor() {
    this.lang = 'en-GB';
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.offs = [];
  }
  start() {
    const off = () => { this.offs.forEach((f) => f()); this.offs = []; };
    this.offs.push(native.on('speech', (d) => this.onresult?.({ results: [Object.assign([{ transcript: d.text }], { isFinal: !!d.isFinal })] })));
    this.offs.push(native.on('speecherror', (d) => this.onerror?.({ error: d.error })));
    this.offs.push(native.on('speechend', () => { off(); this.onend?.(); }));
    native.call('startListening', { lang: this.lang }).catch((err) => { this.onerror?.({ error: /permission|denied|authori/i.test(err.message) ? 'not-allowed' : 'aborted' }); off(); this.onend?.(); });
  }
  stop() { native.call('stopListening').catch(() => {}); }
  abort() { native.call('stopListening', { discard: true }).catch(() => {}); }
}

const Recognition = native ? NativeRecognition : window.SpeechRecognition || window.webkitSpeechRecognition;

export const voiceSupported = !!Recognition;
export const ttsSupported = 'speechSynthesis' in window;

/**
 * @param {object} h
 * @param {(text: string) => Promise<{text: string, question?: object, sessionEnded?: boolean}>} h.onUtterance
 * @param {(state: 'idle'|'listening'|'thinking'|'speaking', note?: string) => void} h.onState
 * @param {(text: string) => void} h.onTranscript  live words while listening
 * @param {() => boolean} h.speakReplies
 */
export function createVoice(h) {
  const PAUSE_MS = 2000; // quiet after speech = you're done
  const NOTHING_SAID_MS = 9000; // tapped but said nothing
  let rec = null;
  let active = false;
  let busy = false;
  let carried = ''; // words from earlier recognition runs in this turn (browsers restart often)
  let finalText = ''; // finished words in the current run
  let interim = '';
  let pauseTimer = null;
  let silenceTimer = null;
  let heardAnything = false;

  const transcript = () => `${carried} ${finalText} ${interim}`.replace(/\s+/g, ' ').trim();

  function clearTimers() {
    clearTimeout(pauseTimer);
    clearTimeout(silenceTimer);
  }

  function build() {
    const r = new Recognition();
    r.lang = navigator.language || 'en-GB';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      // Rebuild from the whole result list: some browsers (iOS) resend earlier results.
      let fin = '';
      let inter = '';
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript;
        if (res.isFinal) fin += ` ${text}`;
        else inter += ` ${text}`;
      }
      finalText = fin.trim();
      interim = inter.trim();
      if (transcript()) {
        heardAnything = true;
        clearTimeout(silenceTimer);
        h.onTranscript(transcript());
        clearTimeout(pauseTimer);
        pauseTimer = setTimeout(finishTurn, PAUSE_MS);
      }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        stop();
        h.onState('idle', 'Microphone access is off. Allow it for this app in your iPhone Settings, or type instead.');
      } else if (e.error === 'network') {
        stop();
        h.onState('idle', 'Voice needs a connection right now. Type instead and I’ll keep it.');
      }
      // "no-speech" and "aborted" are handled by onend.
    };
    r.onend = () => {
      // Browsers stop recognition every so often. Keep what was said and carry on.
      if (!active || busy) return;
      carried = `${carried} ${finalText} ${interim}`.trim();
      finalText = '';
      interim = '';
      if (document.visibilityState === 'visible') setTimeout(listen, 150);
    };
    return r;
  }

  function listen() {
    if (!active || busy) return;
    try {
      rec = build();
      rec.start();
      h.onState('listening');
    } catch {
      /* already running */
    }
  }

  async function finishTurn() {
    if (!active || busy) return;
    const text = transcript();
    clearTimers();
    if (!text) return;
    busy = true;
    try {
      rec?.stop();
    } catch {}
    carried = '';
    finalText = '';
    interim = '';
    h.onTranscript('');
    h.onState('thinking');
    let reply;
    try {
      reply = await h.onUtterance(text);
    } catch {
      busy = false;
      stop();
      h.onState('idle', 'Something went wrong — tap to try again.');
      return;
    }
    if (reply?.text && h.speakReplies()) await speak(reply.text);
    busy = false;
    h.afterReply?.(reply);
    // Only keep listening when Brain Dump asked something.
    if (reply?.question && !reply.sessionEnded && active) {
      heardAnything = false;
      listen();
      silenceTimer = setTimeout(() => !heardAnything && stop(), NOTHING_SAID_MS * 2);
    } else stop();
  }

  async function speak(text) {
    h.onState('speaking');
    await speakReply(text);
  }

  function start() {
    if (!voiceSupported) return false;
    stopSpeaking();
    active = true;
    busy = false;
    carried = '';
    finalText = '';
    interim = '';
    heardAnything = false;
    listen();
    silenceTimer = setTimeout(() => !heardAnything && stop('nothing'), NOTHING_SAID_MS);
    return true;
  }

  function stop(reason) {
    active = false;
    clearTimers();
    try {
      rec?.abort();
    } catch {}
    h.onTranscript('');
    h.onState('idle', reason === 'nothing' ? 'I didn’t hear anything — tap when you’re ready.' : undefined);
  }

  /** Tap while listening: send what you've said now. Tap while speaking: stop talking. */
  function tap() {
    unlockAudio(); // inside the tap, so iPhone lets the reply play later
    if (isSpeaking()) {
      stopSpeaking();
      return 'interrupted';
    }
    if (active && !busy) {
      if (transcript()) {
        finishTurn();
        return 'sent';
      }
      stop();
      return 'stopped';
    }
    return start() ? 'started' : 'unsupported';
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && active && !busy) {
      // The phone takes the microphone away: send what was said rather than lose it.
      if (transcript()) finishTurn();
      else stop();
    }
  });

  return {
    tap,
    start,
    stop,
    speak,
    get active() {
      return active;
    },
  };
}
