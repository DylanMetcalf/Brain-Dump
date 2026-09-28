// What this device can do, and asking for what it needs.
//
// Runs the same in a browser and inside the Brain Dump iPhone app. In the app, the page
// talks to native code (EventKit, AlarmKit, Contacts, speech, App Intents) through a
// small message bridge; in a browser it uses the web platform. Either way the rest of
// Brain Dump sees one interface.

import { api, LOCAL } from './api.js';

// ---- Native bridge (present only inside the Brain Dump iPhone app) -------------------

const pending = new Map();
let seq = 0;
const listeners = new Map();

/** The iPhone app injects window.BrainDumpNative = { version } and a message handler. */
export const native = (() => {
  const handler = window.webkit?.messageHandlers?.brainDump;
  if (!handler || !window.BrainDumpNative) return null;
  window.__bdNativeReply = (id, ok, result) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(typeof result === 'string' ? result : 'The iPhone app couldn’t do that.'));
  };
  window.__bdNativeEvent = (name, data) => (listeners.get(name) ?? []).forEach((fn) => fn(data));
  return {
    version: window.BrainDumpNative.version,
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        handler.postMessage({ id, method, args });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error('The iPhone app didn’t answer.'));
          }
        }, method === 'requestPermission' ? 120_000 : 30_000);
      });
    },
    on(name, fn) {
      listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      return () => listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn));
    },
  };
})();

export const isNative = !!native;

// ---- Discovery ------------------------------------------------------------------------

function platform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return 'ios';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ipados';
  if (/Android/.test(ua)) return 'android';
  if (/Mac OS X/.test(ua)) return 'macos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

function osVersion() {
  const m = navigator.userAgent.match(/OS (\d+)[._](\d+)/) ?? navigator.userAgent.match(/Android (\d+(?:\.\d+)?)/) ?? navigator.userAgent.match(/Mac OS X (\d+)[._](\d+)/);
  return m ? m.slice(1).filter(Boolean).join('.') : undefined;
}

export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

async function webMicPermission() {
  try {
    const s = await navigator.permissions.query({ name: 'microphone' });
    return s.state; // granted | denied | prompt
  } catch {
    try { return localStorage.getItem('bd.mic') ?? 'prompt'; } catch { return 'prompt'; }
  }
}

function webNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission === 'default' ? 'prompt' : Notification.permission;
}

/** A full, honest picture of this device. */
export async function discover() {
  if (native) {
    const c = await native.call('capabilities').catch(() => null);
    if (c) return { shell: 'ios', standalone: true, ...c };
  }
  const p = platform();
  const iphone = p === 'ios' || p === 'ipados';
  const push = 'serviceWorker' in navigator && 'PushManager' in window && (!iphone || isStandalone());
  const voice = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  return {
    shell: 'web',
    platform: p,
    osVersion: osVersion(),
    standalone: isStandalone(),
    permissions: {
      notifications: webNotificationPermission(),
      microphone: voice ? await webMicPermission() : 'unsupported',
    },
    features: [voice && 'voice-input', push && 'push', 'speechSynthesis' in window && 'speech-synthesis', navigator.share && 'share-sheet'].filter(Boolean),
  };
}

let lastReport = null;
let lastSent = '';

/** Tell Brain Dump what this device can do; returns the orchestrator's view (statuses, problems, choices). */
export async function reportDevice({ force = false } = {}) {
  if (LOCAL) return null;
  const caps = await discover();
  const sig = JSON.stringify(caps);
  if (!force && sig === lastSent && lastReport) return lastReport;
  lastReport = await api('/api/device/caps', { body: caps }).catch(() => lastReport);
  lastSent = sig;
  return lastReport;
}

// ---- Asking for permissions (always from a tap) ---------------------------------------

/** Returns the new state: granted | denied | prompt | unsupported. */
export async function requestPermission(name) {
  if (native) return native.call('requestPermission', { name });
  if (name === 'microphone') {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      try { localStorage.setItem('bd.mic', 'granted'); } catch {}
      return 'granted';
    } catch (err) {
      const denied = err?.name === 'NotAllowedError';
      try { if (denied) localStorage.setItem('bd.mic', 'denied'); } catch {}
      return denied ? 'denied' : 'unsupported';
    }
  }
  if (name === 'notifications') {
    if (!('Notification' in window)) return 'unsupported';
    const r = await Notification.requestPermission();
    return r === 'default' ? 'prompt' : r;
  }
  return 'unsupported';
}

/** Only the Settings app can turn a refused permission back on. */
export async function openSystemSettings() {
  if (native) return native.call('openSettings');
  return false;
}

// ---- The iPhone app's device agent ------------------------------------------------------

/** Carry out anything waiting for this phone (create/update/cancel/complete), verified. */
export async function runPhoneAgent() {
  if (!native) return null;
  return native.call('runOutbox').catch(() => null);
}

export async function shareCalendar() {
  if (!native) return null;
  return native.call('syncCalendar').catch(() => null);
}

/** A real read from the platform for the setup test ("I can see 12 events this week"). */
export async function probe(name) {
  if (!native) return { ok: true };
  return native.call('probe', { name }).catch((err) => ({ ok: false, error: err.message }));
}

export async function findContact(name) {
  if (!native) return [];
  return native.call('findContact', { name }).catch(() => []);
}

/** Give the iPhone app the sign-in and address, so Siri, widgets and the agent work on their own. */
export async function linkNative(token) {
  if (!native || !token) return;
  await native.call('setSession', { token, server: location.origin }).catch(() => {});
}
