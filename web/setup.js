// Brain Dump sets itself up.
//
// INSTALL → CONNECT → TEST → TALK
//
// First run: choose what to connect (only what this device supports) → a setup queue in
// which each integration runs DISCOVER → CONNECT → AUTHORISE → CONFIGURE → TEST → VERIFY,
// stopping only where Apple (or Google) needs the person → a real end-to-end voice test →
// "You're all set" → Talk.
//
// Every status on screen comes from a real check: the device's own report and the
// server's orchestrator. Nothing is animated for show.
//
// Also here: Integration Health (with repair), the Home repair card, and Advanced.

import { api, auth, LOCAL } from './api.js';
import { h, icon, brandMark, toast, sheet } from './ui.js';
import { ui, app, page, loadState, refreshAll } from './app.js';
import { native, isNative, reportDevice, requestPermission, openSystemSettings, runPhoneAgent, shareCalendar, probe, linkNative, discover } from './device.js';
import { createVoice, voiceSupported } from './voice.js';
import { calendarSubscribe } from './settings.js';

export const APP_VERSION = '2.0.0';
const FLOW_KEY = 'bd.setupFlow';

const ICONS = {
  voice: 'mic', notifications: 'bell', calendar: 'calendar', reminders: 'check', alarms: 'timer', contacts: 'users', notes: 'note',
  mail: 'mail', messages: 'message', music: 'music', meetings: 'video', siri: 'sparkle', brain: 'sparkle', 'natural-voice': 'speaker',
};
/** What the setup agent says while it works on each one. */
const WORKING = {
  voice: 'I’m checking your voice setup now.', notifications: 'Setting up notifications.', calendar: 'Connecting your calendar.',
  reminders: 'Connecting Reminders.', alarms: 'Setting up alarms and timers.', contacts: 'Connecting Contacts.', notes: 'Setting up notes.',
  mail: 'Connecting your email.', messages: 'Getting messages ready.', music: 'Getting music ready.', meetings: 'Getting meetings ready.', siri: 'Registering Siri.',
};

// ---------------------------------------------------------------------------
// Flow state (survives a trip to Google sign-in or the Settings app)
// ---------------------------------------------------------------------------

let flow = null;

function saveFlow() {
  try { sessionStorage.setItem(FLOW_KEY, JSON.stringify({ stage: flow.stage, selected: [...flow.selected], done: flow.done })); } catch {}
}
function loadFlow() {
  try { return JSON.parse(sessionStorage.getItem(FLOW_KEY) ?? 'null'); } catch { return null; }
}
function clearFlow() {
  try { sessionStorage.removeItem(FLOW_KEY); } catch {}
}

export function setupNeeded() {
  if (LOCAL) return false;
  return !ui.state?.setup?.completedAt;
}

export async function renderSetup() {
  const saved = loadFlow();
  if (!flow) flow = { stage: saved?.stage ?? 'intro', selected: new Set(saved?.selected ?? []), done: saved?.done ?? {}, rows: new Map(), report: null };
  if (isNative) linkNative(auth.token);
  if (flow.stage === 'intro') return renderIntro();
  if (flow.stage === 'choose') return renderChoose();
  if (flow.stage === 'queue') return renderQueue();
  if (flow.stage === 'test') return renderTest();
  return renderReady();
}

function shell(...content) {
  app.className = 'app setup-page';
  app.replaceChildren(h('div', { class: 'setup-wrap' }, ...content));
  window.scrollTo(0, 0);
}

// ---- 1. Intro -----------------------------------------------------------------

function renderIntro() {
  shell(
    h('div', { class: 'setup-mark' }, brandMark(64, { onDark: true })),
    h('h1', { class: 'setup-title' }, 'Let’s set up Brain Dump'),
    h('p', { class: 'setup-lead' }, 'I work best when I can connect to the tools you already use. Choose what you’d like me to work with — I’ll handle the setup. If Apple needs you to approve something, I’ll let you know.'),
    h('button', { class: 'btn primary big', onclick: async () => { flow.stage = 'choose'; saveFlow(); await renderChoose(); } }, 'Let’s go'),
    h('button', { class: 'btn text', onclick: skipSetup }, 'Skip for now'));
}

async function skipSetup() {
  await api('/api/setup/start', { body: { selected: [] } }).catch(() => {});
  await api('/api/setup/complete', { body: { tested: false } }).catch(() => {});
  clearFlow();
  flow = null;
  await loadState();
  location.hash = '#home';
}

// ---- 2. Choose (discovered, not assumed) --------------------------------------

async function renderChoose() {
  shell(h('p', { class: 'setup-lead center' }, 'Looking at what this phone can do…'));
  flow.report = await reportDevice({ force: true });
  const choices = flow.report?.choices ?? [];
  if (!flow.selected.size) choices.filter((c) => c.suggested).forEach((c) => flow.selected.add(c.id));
  const list = h('div', { class: 'choose-list' }, choices.map((c) => {
    const on = flow.selected.has(c.id);
    const b = h('button', { class: `choose ${on ? 'on' : ''}`, role: 'checkbox', 'aria-checked': on ? 'true' : 'false', onclick: () => {
      const now = !flow.selected.has(c.id);
      now ? flow.selected.add(c.id) : flow.selected.delete(c.id);
      b.classList.toggle('on', now);
      b.setAttribute('aria-checked', now ? 'true' : 'false');
    } },
      h('span', { class: 'choose-ic' }, icon(ICONS[c.id] ?? 'sparkle', 20)),
      h('span', { class: 'choose-main' }, h('span', { class: 'choose-title' }, c.label), h('span', { class: 'choose-sub' }, c.via)),
      h('span', { class: 'choose-box' }, icon('check', 16)));
    return b;
  }));
  shell(
    h('p', { class: 'eyebrow' }, 'Your apps & services'),
    h('h1', { class: 'setup-title' }, 'What should I work with?'),
    h('p', { class: 'setup-lead' }, 'Only things this phone supports are shown. You can change these any time.'),
    list,
    h('button', { class: 'btn primary big sticky', onclick: startQueue }, 'Set it up'));
}

async function startQueue() {
  const selected = [...flow.selected];
  flow.report = await api('/api/setup/start', { body: { selected } }).catch(() => flow.report);
  flow.stage = 'queue';
  flow.done = {};
  saveFlow();
  await renderQueue();
}

// ---- 3. The setup queue -----------------------------------------------------------

const STATUS = {
  waiting: ['Waiting', 'waiting'], working: ['Connecting…', 'working'], ok: ['Connected', 'ok'], ready: ['Ready', 'ok'],
  needs: ['Needs you', 'needs'], later: ['Later', 'later'], skipped: ['Skipped', 'later'],
};

let running = false;

async function renderQueue() {
  const order = ['voice', 'notifications', 'calendar', 'reminders', 'alarms', 'contacts', 'notes', 'mail', 'messages', 'music', 'meetings', 'siri'];
  const ids = [...flow.selected].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const labelOf = (id) => flow.report?.statuses?.find((s) => s.id === id)?.label ?? id;
  const say = h('p', { class: 'setup-say', 'aria-live': 'polite' }, 'Let’s get everything connected.');
  const list = h('div', { class: 'queue' });
  flow.rows = new Map();
  for (const id of ids) {
    const status = h('span', { class: 'q-status waiting' }, 'Waiting');
    const note = h('div', { class: 'q-note' });
    const row = h('div', { class: 'q-row' }, h('span', { class: 'q-ic' }, icon(ICONS[id] ?? 'sparkle', 19)), h('div', { class: 'q-main' }, h('span', { class: 'q-title' }, labelOf(id)), note), status);
    flow.rows.set(id, { row, status, note });
    if (flow.done[id]) setRow(id, flow.done[id]);
    list.append(row);
  }
  shell(h('p', { class: 'eyebrow' }, 'Brain Dump is setting itself up'), h('h1', { class: 'setup-title' }, 'Setting up'), say, list);
  flow.say = say;
  if (!running) processQueue(ids).catch((err) => { say.textContent = `Something went wrong: ${err.message}`; running = false; });
}

function setRow(id, state, text) {
  const r = flow.rows.get(id);
  if (!r) return;
  const [label, cls] = STATUS[state] ?? STATUS.waiting;
  r.status.className = `q-status ${cls}`;
  r.status.replaceChildren(state === 'ok' || state === 'ready' ? icon('check', 14) : null, state === 'working' ? h('span', { class: 'spinner' }) : null, label);
  if (text !== undefined) r.note.replaceChildren(text ? h('span', { class: 'q-sub' }, text) : '');
  r.row.classList.toggle('needs', state === 'needs');
}

function statusOf(id) {
  return flow.report?.statuses?.find((s) => s.id === id);
}

/** Wait for a tap on one of the given buttons inside the row; resolves with its value. */
function ask(id, message, buttons) {
  const r = flow.rows.get(id);
  return new Promise((resolve) => {
    r.note.replaceChildren(h('span', { class: 'q-sub' }, message),
      h('div', { class: 'q-actions' }, buttons.map(([label, value, primary]) => h('button', { class: `pill-btn ${primary ? 'accent' : ''}`, onclick: () => resolve(value) }, label))));
    r.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}

/** Resolves when the person comes back to the app (after the Settings app). */
function whenBack() {
  return new Promise((resolve) => {
    const on = () => {
      if (document.visibilityState === 'visible') {
        document.removeEventListener('visibilitychange', on);
        setTimeout(resolve, 400);
      }
    };
    document.addEventListener('visibilitychange', on);
  });
}

async function refreshReport() {
  flow.report = (await reportDevice({ force: true })) ?? flow.report;
}

async function processQueue(ids) {
  running = true;
  let needed = 0;
  for (const id of ids) {
    if (flow.done[id]) continue;
    setRow(id, 'working', '');
    flow.say.textContent = WORKING[id] ?? 'Setting up.';
    const result = await runAgent(id);
    flow.done[id] = result;
    saveFlow();
    setRow(id, result, result === 'later' ? statusOf(id)?.message ?? '' : result === 'skipped' ? 'You can turn this on later in Health.' : statusOf(id)?.via ?? '');
    if (result === 'ok' || result === 'ready') flow.say.textContent = `${statusOf(id)?.label ?? 'That’s'} ${result === 'ok' ? 'connected' : 'ready'}.`;
    if (result === 'later' || result === 'skipped') needed++;
  }
  running = false;
  flow.say.textContent = needed ? 'Nearly there. Let’s test it.' : 'Everything’s connected. Let’s test it.';
  flow.stage = 'test';
  saveFlow();
  setTimeout(() => renderTest(), 900);
}

/**
 * One integration: DISCOVER (the orchestrator's status) → CONNECT/AUTHORISE (only when the
 * platform needs her) → CONFIGURE → TEST (a real read or round trip) → VERIFY (status again).
 */
async function runAgent(id) {
  // DISCOVER
  await refreshReport();
  let s = statusOf(id);
  if (!s || s.health === 'unavailable') return 'later';

  // CONFIGURE steps that need no one.
  if (id === 'siri' && isNative) await native.call('registerShortcuts').catch(() => {});
  if (id === 'calendar' && isNative && s.health === 'ok') await shareCalendar();

  for (let attempt = 0; attempt < 4; attempt++) {
    await refreshReport();
    s = statusOf(id);
    if (s.health === 'ok' || s.health === 'off') break;
    const fix = s.fix;
    if (!fix) break;
    // AUTHORISE: stop only here, at exactly what's needed.
    if (fix.kind === 'permission') {
      flow.say.textContent = 'One permission needs you.';
      setRow(id, 'needs');
      const v = await ask(id, s.message, [[fix.label, 'go', true], ['Not now', 'skip']]);
      if (v === 'skip') return 'skipped';
      setRow(id, 'working', '');
      await requestPermission(fix.target);
      if (fix.target === 'notifications' && !isNative) await subscribePush();
      continue;
    }
    if (fix.kind === 'settings') {
      setRow(id, 'needs');
      const v = await ask(id, s.message, isNative ? [['Open Settings', 'go', true], ['Not now', 'skip']] : [['I’ve turned it on', 'go', true], ['Not now', 'skip']]);
      if (v === 'skip') return 'skipped';
      if (isNative) {
        await openSystemSettings();
        await whenBack(); // carries on by itself when she comes back
      }
      setRow(id, 'working', '');
      continue;
    }
    if (fix.kind === 'retry') {
      if (fix.target === 'notifications') await subscribePush();
      if (fix.target === 'siri' && isNative) await native.call('registerShortcuts').catch(() => {});
      continue;
    }
    if (fix.kind === 'reconnect') {
      const optional = id === 'calendar';
      setRow(id, 'needs');
      const v = await ask(id, optional ? 'Use Google Calendar, or keep your calendar in Brain Dump?' : s.message,
        optional ? [[fix.label, 'go', true], ['Keep it in Brain Dump', 'skip']] : [[fix.label, 'go', true], ['Not now', 'skip']]);
      if (v === 'skip') return optional ? 'ready' : 'skipped';
      saveFlow();
      const [, service] = fix.target.split(':');
      const r = await api('/api/integrations/google/start', { body: { services: [service === 'gmail' ? 'gmail' : 'calendar'], returnTo: '#setup' } }).catch((err) => ({ error: err.message }));
      if (r.url) {
        location.href = r.url; // Google sign-in, then straight back here to carry on
        await new Promise(() => {});
      }
      return 'skipped';
    }
    if (fix.kind === 'install') {
      setRow(id, 'needs');
      const v = await ask(id, s.message, [['Show me how', 'how', true], ['Later', 'skip']]);
      if (v === 'how') installSheet(fix.target);
      return 'later';
    }
    break;
  }

  // TEST: a real read where the platform allows it.
  if (isNative && ['calendar', 'reminders', 'contacts', 'alarms'].includes(id)) {
    const p = await probe(id);
    if (p && p.ok === false) {
      setRow(id, 'needs', p.error ?? 'That didn’t work.');
      return 'skipped';
    }
    if (p?.detail) flow.rows.get(id)?.note.replaceChildren(h('span', { class: 'q-sub' }, p.detail));
  }
  if (id === 'notifications' && !isNative) {
    const r = await api('/api/health/repair', { body: { push: true } }).catch(() => null);
    if (r) flow.report = r;
  }

  // VERIFY
  await refreshReport();
  s = statusOf(id);
  if (s?.health === 'ok') return READY_IDS.includes(id) || /^Brain Dump|^Notifications$|^This browser/.test(s.via) ? 'ready' : 'ok';
  if (s?.health === 'off') return 'ready';
  return 'skipped';
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** Link this device for notifications (permission must already be granted). Quiet: no toasts. */
export async function subscribePush() {
  if (isNative || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  try {
    const { publicKey } = await api('/api/push/key');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
    await api('/api/push/subscribe', { body: { subscription: sub.toJSON() } });
    return true;
  } catch {
    return false;
  }
}

function installSheet(target) {
  if (target === 'home-screen') {
    sheet('Add Brain Dump to your Home Screen',
      h('ol', { class: 'recipe' },
        h('li', {}, h('strong', {}, 'Tap the Share button'), h('span', { class: 'row-sub' }, 'The square with an arrow, at the bottom of Safari.')),
        h('li', {}, h('strong', {}, 'Choose “Add to Home Screen”'), h('span', { class: 'row-sub' }, 'Scroll down if you don’t see it.')),
        h('li', {}, h('strong', {}, 'Open Brain Dump from the new icon'), h('span', { class: 'row-sub' }, 'I’ll carry on from where we left off.'))));
  } else {
    sheet('The Brain Dump iPhone app',
      h('p', {}, 'The iPhone app is what lets me set real alarms, put reminders in Reminders, manage your calendar, find people in Contacts and answer “Hey Siri, Brain Dump” — all with nothing for you to build.'),
      h('p', { class: 'muted-text' }, 'Whoever looks after your Brain Dump installs it from TestFlight (see docs/IOS_APP.md). Everything you’ve already told me carries over.'),
      h('a', { class: 'btn', href: '#shortcut' }, 'Or use the optional Shortcut'));
  }
}

// ---- 4. The real end-to-end test ------------------------------------------------

async function renderTest() {
  flow.stage = 'test';
  saveFlow();
  const checks = h('div', { class: 'queue' });
  const steps = new Map();
  const add = (id, label) => {
    const status = h('span', { class: 'q-status waiting' }, 'Waiting');
    const row = h('div', { class: 'q-row' }, h('span', { class: 'q-ic' }, icon(ICONS[id] ?? 'check', 19)), h('div', { class: 'q-main' }, h('span', { class: 'q-title' }, label)), status);
    steps.set(id, status);
    checks.append(row);
  };
  const mark = (id, ok, text) => {
    const st = steps.get(id);
    if (!st) return;
    st.className = `q-status ${ok === null ? 'working' : ok ? 'ok' : 'needs'}`;
    st.replaceChildren(ok ? icon('check', 14) : ok === null ? h('span', { class: 'spinner' }) : null, text);
  };
  const canTalk = voiceSupported || isNative;
  if (canTalk) add('voice', 'I hear you');
  add('understand', 'I understand you');
  add('reminders', 'It’s saved');
  if (isNative) add('phone', 'It’s in your Reminders app');

  const live = h('p', { class: 'live', 'aria-live': 'polite' });
  const say = h('p', { class: 'setup-say', 'aria-live': 'polite' }, canTalk ? 'Tap the button and say: “Remind me to buy milk.”' : 'Type: “Remind me to buy milk.”');
  const after = h('div', { class: 'setup-after' });
  let voice;

  async function run(text) {
    if (canTalk) mark('voice', true, 'Heard');
    live.textContent = `“${text}”`;
    mark('understand', null, 'Checking');
    const before = Date.now() - 5000;
    let reply;
    try {
      reply = await api('/api/utterance', { body: { text } });
    } catch (err) {
      mark('understand', false, 'Didn’t work');
      say.textContent = `I couldn’t reach Brain Dump (${err.message}). Check your connection and try again.`;
      return null;
    }
    const understood = (reply.actions ?? []).length > 0;
    mark('understand', understood, understood ? 'Understood' : 'Not quite');
    await loadState();
    const created = [...(ui.state.reminders ?? []), ...(ui.state.shopping ?? [])].find((x) => /milk/i.test(x.text ?? x.name ?? '') && Date.parse(x.createdAt ?? x.addedAt) >= before);
    mark('reminders', !!created, created ? 'Saved' : 'Not found');
    let phoneOk = true;
    if (isNative) {
      mark('phone', null, 'Checking');
      const r = await runPhoneAgent();
      phoneOk = !!r && !r.failed;
      mark('phone', phoneOk, phoneOk ? 'Verified' : 'Needs a permission');
    }
    const passed = understood && !!created && phoneOk;
    say.textContent = passed ? 'Everything works.' : 'Something didn’t work — you can try again, or carry on and fix it later in Health.';
    after.replaceChildren(
      passed ? h('button', { class: 'btn primary big', onclick: () => finish(true) }, 'Finish') : h('button', { class: 'btn primary big', onclick: () => renderTest() }, 'Try again'),
      passed && reply.actions?.some((a) => a.undoable) ? h('button', { class: 'btn text', onclick: async (e) => {
        for (const a of reply.actions.filter((x) => x.undoable)) await api(`/api/undo/${a.id}`, { body: {} }).catch(() => {});
        if (isNative) await runPhoneAgent();
        e.target.textContent = 'Removed the test reminder';
        e.target.disabled = true;
      } }, 'Remove the test reminder') : null,
      !passed ? h('button', { class: 'btn text', onclick: () => finish(false) }, 'Carry on anyway') : null);
    return { text: passed ? 'Done — that works.' : 'Hmm, something didn’t work.' };
  }

  const typeBox = h('form', { class: 'hero-type setup-type', onsubmit: (e) => { e.preventDefault(); const v = e.target.elements.t.value.trim(); if (v) run(v); } },
    h('input', { name: 't', placeholder: 'Remind me to buy milk', 'aria-label': 'Type it' }), h('button', { class: 'icon-btn accent', 'aria-label': 'Send' }, icon('send', 18)));

  const orb = canTalk ? h('button', { id: 'orb', class: 'orb small', 'aria-label': 'Tap to talk', onclick: () => {
    if (!voice) {
      voice = createVoice({
        onUtterance: (t) => run(t),
        onState: (st, note) => { orb.className = `orb small ${st}`; if (note) say.textContent = note; if (st === 'listening') mark('voice', null, 'Listening'); },
        onTranscript: (t) => { if (t) live.textContent = t; },
        speakReplies: () => true,
      });
    }
    voice.tap();
  } }, h('span', { class: 'orb-ring' }), brandMark(56, { onDark: true })) : null;

  shell(
    h('p', { class: 'eyebrow' }, 'Setup test'),
    h('h1', { class: 'setup-title' }, 'Let’s make sure everything works'),
    say, orb, live, checks, after,
    h('details', { class: 'setup-typeit' }, h('summary', {}, canTalk ? 'Or type it' : 'Type it'), typeBox),
    h('button', { class: 'btn text', onclick: () => finish(false) }, 'Skip the test'));
}

async function finish(tested) {
  const r = await api('/api/setup/complete', { body: { tested } }).catch(() => null);
  if (r) flow.report = r;
  flow.stage = 'ready';
  saveFlow();
  await loadState();
  renderReady();
}

// ---- 5. Ready -------------------------------------------------------------------

function renderReady() {
  const connected = (flow?.report?.statuses ?? []).filter((s) => flow.selected.has(s.id) && s.health === 'ok');
  const later = (flow?.report?.statuses ?? []).filter((s) => flow.selected.has(s.id) && s.health !== 'ok');
  clearFlow();
  shell(
    h('div', { class: 'setup-mark' }, brandMark(64, { onDark: true })),
    h('h1', { class: 'setup-title' }, 'Brain Dump is ready'),
    h('div', { class: 'ready-list' }, connected.map((s) => h('div', { class: 'ready-item' }, icon('check', 16), s.label))),
    later.length ? h('p', { class: 'muted-text center' }, `${later.map((s) => s.label).join(', ')} can be finished any time in Settings → Health.`) : null,
    h('p', { class: 'setup-lead center' }, 'You don’t need to organise anything. Just tell me what you need.'),
    h('a', { class: 'btn primary big talk-cta', href: '#talk', onclick: () => { flow = null; } }, icon('mic', 20), 'Talk to Brain Dump'),
    h('a', { class: 'btn text', href: '#home', onclick: () => { flow = null; } }, 'Go to Home'));
}

// ---------------------------------------------------------------------------
// Integration Health
// ---------------------------------------------------------------------------

const READY_IDS = ['messages', 'music', 'meetings', 'notes'];
const HEALTH_LABEL = { ok: ['Connected', 'ok'], 'needs-you': ['Needs you', 'needs'], broken: ['Not working', 'needs'], off: ['Off', 'later'], unavailable: ['Not on this device', 'later'] };

/** Carry out a fix from a status, then re-check. Used by Health and the Home card. */
export async function performFix(s, { returnTo = '#health' } = {}) {
  const f = s.fix;
  if (!f) return;
  if (f.kind === 'permission') {
    await requestPermission(f.target);
    if (f.target === 'notifications') await subscribePush();
  } else if (f.kind === 'settings') {
    if (isNative) {
      await openSystemSettings();
      await whenBack();
    } else {
      toast(`Turn ${s.label} on in your phone’s Settings, then come back — I’ll check again.`, [], 10000);
      await whenBack();
    }
  } else if (f.kind === 'retry') {
    if (f.target === 'notifications') await subscribePush();
    if (f.target === 'siri' && isNative) await native.call('registerShortcuts').catch(() => {});
  } else if (f.kind === 'reconnect') {
    const [, service] = f.target.split(':');
    const r = await api('/api/integrations/google/start', { body: { services: [service === 'gmail' ? 'gmail' : 'calendar'], returnTo } }).catch((err) => ({ error: err.message }));
    if (r.url) location.href = r.url;
    else toast(r.error);
    return;
  } else if (f.kind === 'install') {
    installSheet(f.target);
    return;
  } else if (f.kind === 'open') {
    location.hash = f.target;
    return;
  }
  await checkHealth({ repair: true });
}

/** Lightweight check: report the device, re-run server checks when asked, repair what can be repaired. */
export async function checkHealth({ repair = false } = {}) {
  if (LOCAL) return null;
  const report = await reportDevice({ force: true });
  let fixed = [];
  if (repair) {
    // Device-side repairs first: relink notifications, retry anything waiting for the phone, reshare the calendar.
    const caps = report?.device;
    if (!isNative && caps?.permissions?.notifications === 'granted' && report.problems?.some((p) => p.id === 'notifications')) {
      if (await subscribePush()) fixed.push('Notifications relinked');
    }
    if (isNative) {
      const r = await runPhoneAgent();
      if (r?.done) fixed.push(`${r.done} change${r.done > 1 ? 's' : ''} made on your phone`);
      await shareCalendar();
    }
    const r = await api('/api/health/repair', { body: {} }).catch(() => null);
    if (r) {
      fixed = [...fixed, ...r.repaired];
      ui.health = r;
      return { ...r, repaired: fixed };
    }
  }
  const r = await api(`/api/health/integrations${repair ? '?check=1' : ''}`).catch(() => report);
  ui.health = r;
  return { ...r, repaired: fixed };
}

export async function renderHealth() {
  const body = h('div', {}, h('p', { class: 'muted-text' }, 'Checking…'));
  page('sub', h('a', { class: 'back', href: '#settings' }, icon('back', 18), 'Settings'), h('h1', { class: 'sub-title' }, 'Health'), body);
  const r = await checkHealth();
  drawHealth(body, r);
}

function drawHealth(body, r) {
  if (!r) return body.replaceChildren(h('p', { class: 'empty' }, 'Couldn’t reach Brain Dump. Check your connection.'));
  const selected = new Set(r.setup?.selected ?? []);
  const shown = r.statuses.filter((s) => s.health !== 'unavailable');
  const mine = shown.filter((s) => !s.selectable || selected.has(s.id) || s.health === 'ok');
  const others = shown.filter((s) => !mine.includes(s));
  const issues = r.problems?.length ?? 0;
  const row = (s, optional) => {
    let [label, cls] = HEALTH_LABEL[s.health];
    // Honest words: hand-offs and Brain Dump's own features are "Ready", not "Connected";
    // things she didn't choose are "Available", never "Needs you".
    if (s.health === 'ok' && (READY_IDS.includes(s.id) || /^Brain Dump|^Notifications$|^This browser/.test(s.via))) label = 'Ready';
    if (optional && s.health !== 'ok') [label, cls] = ['Available', 'later'];
    return h('div', { class: 'h-row' },
      h('span', { class: 'q-ic' }, icon(ICONS[s.id] ?? 'sparkle', 19)),
      h('div', { class: 'q-main' }, h('span', { class: 'q-title' }, s.label), h('span', { class: 'q-sub' }, s.health === 'ok' ? s.via : s.message),
        s.fix && s.health !== 'ok' ? h('div', { class: 'q-actions' }, h('button', { class: 'pill-btn accent', onclick: async (e) => { e.target.disabled = true; e.target.textContent = 'Working…'; await performFix(s); drawHealth(body, ui.health); } }, s.fix.label)) : null),
      h('span', { class: `q-status ${cls}` }, s.health === 'ok' ? icon('check', 14) : null, label));
  };
  body.replaceChildren(
    h('section', { class: `card health-sum ${issues ? 'warn' : ''}` },
      h('h2', {}, issues ? `${issues} thing${issues > 1 ? 's' : ''} need${issues > 1 ? '' : 's'} you` : 'Everything’s working'),
      h('p', { class: 'muted-text' }, issues ? 'Tap the button next to each one and I’ll finish the rest.' : 'I check this in the background and after updates, and I’ll tell you if anything stops working.'),
      h('div', { class: 'row-actions' }, h('button', { class: 'pill-btn', onclick: async (e) => {
        e.target.disabled = true;
        e.target.textContent = 'Checking…';
        const res = await checkHealth({ repair: true });
        if (res?.repaired?.length) toast(`Fixed: ${res.repaired.join('. ')}.`);
        drawHealth(body, res);
      } }, 'Check again'), h('a', { class: 'pill-btn', href: '#setup', onclick: () => { clearFlow(); flow = null; } }, 'Set up again'))),
    h('section', { class: 'group' }, h('div', { class: 'group-body' }, mine.map((s) => row(s, false)))),
    others.length ? h('section', { class: 'group' }, h('h2', { class: 'group-title' }, 'Also available'), h('div', { class: 'group-body' }, others.map((s) => row(s, true)))) : null,
    h('a', { class: 'btn text', href: '#advanced' }, 'Advanced'));
}

/** The one card Home shows when something needs her, or something new can be connected. */
export function healthCard() {
  const r = ui.health;
  if (!r || LOCAL) return null;
  const p = r.problems?.find((x) => x.fix);
  if (p) {
    return h('section', { class: 'card setup' },
      h('div', { class: 'card-head' }, h('h2', {}, `${p.label} needs you`)),
      h('p', {}, p.message),
      h('div', { class: 'row-actions' }, h('button', { class: 'pill-btn accent', onclick: async (e) => { e.target.disabled = true; await performFix(p, { returnTo: '#health' }); location.hash = '#home'; } }, p.fix.label), h('a', { class: 'pill-btn', href: '#health' }, 'Health')));
  }
  const n = r.newlyAvailable?.[0];
  if (n) {
    const dismiss = async (add) => {
      await api('/api/setup/offered', { body: { ids: [n.id], ...(add ? { add: [n.id] } : {}) } }).catch(() => {});
      ui.health = { ...r, newlyAvailable: r.newlyAvailable.slice(1) };
    };
    return h('section', { class: 'card muted' },
      h('div', { class: 'card-head' }, h('h2', {}, 'New integration available')),
      h('p', {}, `${n.label} can now be connected to Brain Dump (${n.via}).`),
      h('div', { class: 'row-actions' },
        h('button', { class: 'pill-btn accent', onclick: async () => { await dismiss(true); location.hash = '#health'; } }, 'Connect'),
        h('button', { class: 'pill-btn', onclick: async (e) => { await dismiss(false); e.target.closest('section').remove(); } }, 'Not now')));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Advanced (kept away from the normal experience)
// ---------------------------------------------------------------------------

export async function renderAdvanced() {
  const [r, phone, intents, caps] = await Promise.all([
    checkHealth(),
    api('/api/phone').catch(() => null),
    isNative ? native.call('intents').catch(() => []) : Promise.resolve([]),
    discover(),
  ]);
  const kv = (k, v) => h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('span', {}, k)), h('span', { class: 'muted-text adv-v' }, v ?? '—'));
  const diag = JSON.stringify({ app: APP_VERSION, device: caps, statuses: r?.statuses?.map(({ id, health, via, detail }) => ({ id, health, via, detail })), phone, devices: r?.devices }, null, 2);
  page('sub', h('a', { class: 'back', href: '#health' }, icon('back', 18), 'Health'), h('h1', { class: 'sub-title' }, 'Advanced'),
    h('section', { class: 'group' }, h('h2', { class: 'group-title' }, 'This device'), h('div', { class: 'group-body' },
      kv('Runs as', caps.shell === 'ios' ? 'Brain Dump iPhone app' : caps.standalone ? 'Home Screen web app' : 'Browser'),
      kv('Platform', `${caps.platform} ${caps.osVersion ?? ''}`),
      kv('Features', (caps.features ?? []).join(', ') || 'none'),
      ...Object.entries(caps.permissions ?? {}).map(([k, v]) => kv(`Permission: ${k}`, v)))),
    h('section', { class: 'group' }, h('h2', { class: 'group-title' }, 'Integrations'), h('div', { class: 'group-body' },
      (r?.statuses ?? []).map((s) => kv(s.label, `${s.health} · ${s.via}${s.detail ? ` · ${s.detail}` : ''}`)))),
    h('section', { class: 'group' }, h('h2', { class: 'group-title' }, 'Phone agent'), h('div', { class: 'group-body' },
      kv('Keeping phone apps in step', phone?.enabled ? 'On' : 'Off'),
      kv('Waiting', phone ? String(phone.pending) : '—'),
      kv('Last run', phone?.lastRunAt ? new Date(phone.lastRunAt).toLocaleString() : 'never'))),
    isNative ? h('section', { class: 'group' }, h('h2', { class: 'group-title' }, 'Siri & Shortcuts actions'), h('div', { class: 'group-body' },
      (intents.length ? intents : ['—']).map((i) => kv(typeof i === 'string' ? i : i.title, typeof i === 'string' ? '' : i.phrase ?? '')))) : null,
    h('section', { class: 'group' }, h('h2', { class: 'group-title' }, 'Devices on this account'), h('div', { class: 'group-body' },
      (r?.devices ?? []).map((d) => kv(d.name ?? d.deviceId, `${d.shell} · ${d.platform} · ${new Date(d.reportedAt).toLocaleDateString()}`)))),
    h('section', { class: 'group' }, h('div', { class: 'group-body' },
      h('a', { class: 'set-row link-row', href: '#shortcut' }, h('span', { class: 'row-ic' }, icon('link', 19)), h('div', { class: 'set-label' }, h('span', {}, 'Legacy Siri Shortcut'), h('span', { class: 'row-sub' }, 'Optional, for the web app without the iPhone app')), icon('chevron', 18)),
      !isNative ? h('button', { class: 'set-row link-row', onclick: () => calendarSubscribe() }, h('span', { class: 'row-ic' }, icon('calendar', 19)), h('div', { class: 'set-label' }, h('span', {}, 'Calendar subscription'), h('span', { class: 'row-sub' }, 'Show Brain Dump’s events in any calendar app')), icon('chevron', 18)) : null,
      h('a', { class: 'set-row link-row', href: '#history' }, h('span', { class: 'row-ic' }, icon('note', 19)), h('div', { class: 'set-label' }, h('span', {}, 'Action history')), icon('chevron', 18)),
      h('button', { class: 'set-row link-row', onclick: async (e) => { try { await navigator.clipboard.writeText(diag); e.currentTarget.querySelector('span span').textContent = 'Copied'; } catch {} } },
        h('span', { class: 'row-ic' }, icon('link', 19)), h('div', { class: 'set-label' }, h('span', {}, 'Copy diagnostics')), icon('chevron', 18)))));
}

// ---------------------------------------------------------------------------
// Background health: after updates, on return to the app, and daily
// ---------------------------------------------------------------------------

export async function backgroundHealth() {
  if (LOCAL || !auth.token) return;
  let last = null;
  let lastAt = 0;
  try { last = localStorage.getItem('bd.appVersion'); lastAt = Number(localStorage.getItem('bd.healthAt') ?? 0); } catch {}
  const updated = last !== APP_VERSION;
  const due = Date.now() - lastAt > 24 * 3600_000;
  const r = await checkHealth({ repair: updated || due });
  try { localStorage.setItem('bd.appVersion', APP_VERSION); if (updated || due) localStorage.setItem('bd.healthAt', String(Date.now())); } catch {}
  if (r?.repaired?.length && (updated || due)) toast(`I checked your connections: ${r.repaired.join('. ')}.`);
  return r;
}
