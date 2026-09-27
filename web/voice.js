// Voice session: TAP → TALK → CONTINUE → FINISH.
// Uses the browser's own speech recognition and synthesis, only after an explicit tap.
// When the OS suspends the microphone (app switched, screen locked) the conversation
// stays open on the server; listening resumes when the user comes back.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const voiceSupported = !!Recognition;
export const ttsSupported = 'speechSynthesis' in window;

/**
 * @param {object} h
 * @param {(text: string) => Promise<{text: string, settled: boolean, sessionEnded: boolean}>} h.onUtterance
 * @param {(state: 'idle'|'listening'|'thinking'|'speaking', note?: string) => void} h.onState
 * @param {(text: string) => void} h.onInterim
 * @param {() => boolean} h.speakReplies
 */
export function createVoice(h) {
  let rec = null;
  let active = false; // the user has an open voice session
  let busy = false; // waiting for the server or speaking
  let silenceTimer = null;
  let lastSettled = true;
  let resumeOnReturn = false;
  let restarts = 0;

  const SETTLED_SILENCE_MS = 9000; // nothing pending: close after a short quiet spell
  const OPEN_SILENCE_MS = 45000; // a question is pending: give the user time

  function armSilence() {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => stop('quiet'), lastSettled ? SETTLED_SILENCE_MS : OPEN_SILENCE_MS);
  }

  function build() {
    const r = new Recognition();
    r.lang = navigator.language || 'en-GB';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = async (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const text = res[0].transcript.trim();
        if (!res.isFinal) {
          interim += text + ' ';
          continue;
        }
        // Noise handling: ignore near-empty or very low-confidence fragments.
        if (text.length < 2 || (res[0].confidence > 0 && res[0].confidence < 0.25)) continue;
        h.onInterim('');
        await handleFinal(text);
      }
      if (interim) {
        h.onInterim(interim.trim());
        armSilence();
      }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        active = false;
        h.onState('idle', 'Microphone access is off — you can type instead, or allow the microphone in your browser settings.');
      } else if (e.error === 'network') {
        h.onState('idle', "Voice recognition needs a connection — type instead and I'll save it.");
        active = false;
      }
      // 'no-speech' and 'aborted' are recovered by onend.
    };
    r.onend = () => {
      // Browsers end recognition periodically; keep the session going while it's active.
      if (active && !busy && document.visibilityState === 'visible') {
        if (restarts++ < 50) setTimeout(() => safeStart(), 250);
      }
    };
    return r;
  }

  function safeStart() {
    if (!active || busy) return;
    try {
      rec = rec ?? build();
      rec.start();
      h.onState('listening');
    } catch {
      /* already started */
    }
  }

  async function handleFinal(text) {
    busy = true;
    try {
      rec?.stop();
    } catch {}
    h.onState('thinking');
    let reply;
    try {
      reply = await h.onUtterance(text);
    } catch {
      busy = false;
      h.onState('listening', "Sorry — something went wrong. Say that again?");
      safeStart();
      return;
    }
    lastSettled = !!reply?.settled;
    if (reply?.text && h.speakReplies()) await speak(reply.text);
    busy = false;
    if (reply?.sessionEnded) {
      stop('ended');
      return;
    }
    restarts = 0;
    safeStart();
    armSilence();
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
    });
  }

  function start() {
    if (!voiceSupported) return false;
    active = true;
    lastSettled = true;
    restarts = 0;
    safeStart();
    armSilence();
    return true;
  }

  function stop(reason = 'user') {
    active = false;
    busy = false;
    clearTimeout(silenceTimer);
    try {
      rec?.abort();
    } catch {}
    if (ttsSupported) speechSynthesis.cancel();
    h.onInterim('');
    h.onState('idle', reason === 'quiet' ? 'Paused — tap to keep talking.' : undefined);
  }

  /** Tap while speaking = interrupt and listen. */
  function interrupt() {
    if (ttsSupported && speechSynthesis.speaking) {
      speechSynthesis.cancel();
      return true;
    }
    return false;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // The OS takes the microphone away; the conversation stays open server-side.
      if (active) {
        resumeOnReturn = true;
        clearTimeout(silenceTimer);
        try {
          rec?.abort();
        } catch {}
      }
    } else if (resumeOnReturn) {
      resumeOnReturn = false;
      if (active) {
        h.onState('listening', "I'm still here — carry on.");
        safeStart();
        armSilence();
      }
    }
  });

  return {
    start,
    stop,
    interrupt,
    speak,
    get active() {
      return active;
    },
  };
}
