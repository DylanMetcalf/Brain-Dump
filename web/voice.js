// Voice: tap, talk as long as you like, and stop. Brain Dump waits for a natural pause
// (about two seconds of quiet) before it treats what you said as one thought, then
// answers. It only listens again if it asked you something. No "that's all" needed.
//
// Works with the browser's own speech recognition, started only by a tap. When the
// phone takes the microphone away (you switch apps), nothing you said is lost.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

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
    // Only keep listening when Brain Dump asked something.
    if (reply?.question && !reply.sessionEnded && active) {
      heardAnything = false;
      listen();
      silenceTimer = setTimeout(() => !heardAnything && stop(), NOTHING_SAID_MS * 2);
    } else stop();
  }

  function speak(text) {
    return new Promise((resolve) => {
      if (!ttsSupported) return resolve();
      h.onState('speaking');
      const u = new SpeechSynthesisUtterance(text);
      u.lang = navigator.language || 'en-GB';
      u.rate = 1.05;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      // Safety net: some browsers never fire onend.
      setTimeout(resolve, Math.min(20000, 1500 + text.length * 70));
    });
  }

  function start() {
    if (!voiceSupported) return false;
    if (ttsSupported) speechSynthesis.cancel();
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
    if (ttsSupported && speechSynthesis.speaking) {
      speechSynthesis.cancel();
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
