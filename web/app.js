// Brain Dump web/PWA client. Deliberately small: one place to talk, a few lists,
// and full control in settings. The assistant does the sorting.

import { api, auth, enqueue, flushQueue, openStream, queued, say, NetworkError, LOCAL } from './api.js';
import { createVoice, voiceSupported as voiceAvailable } from './voice.js';

// The phone test build runs inside a frame that refuses the microphone.
const voiceSupported = voiceAvailable && !LOCAL;

const params = new URLSearchParams(location.search);
const MINI = params.has('mini');
if (MINI) document.body.classList.add('mini');

const ui = {
  sessionId: (() => { try { return sessionStorage.getItem('bd.session'); } catch { return null; } })(),
  convo: [],
  overview: null,
  state: null,
  voiceState: 'idle',
  status: '',
  interim: '',
  online: navigator.onLine,
  version: 0,
};

// ---------------------------------------------------------------------------
// tiny DOM helper (never uses innerHTML for data → no XSS)
// ---------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const MIC = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3']) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
};

function toast(text, actions = [], timeout = 7000) {
  const box = h('div', { class: 'toast', role: 'status' }, h('div', {}, text));
  if (actions.length) {
    box.append(h('div', { class: 'chips' }, actions.map((a) => h('button', { class: 'chip', onclick: () => { a.run(); box.remove(); } }, a.label))));
  }
  document.getElementById('toasts').append(box);
  if (timeout) setTimeout(() => box.remove(), timeout);
}

// Optional pieces of the UI are written as `condition ? element : null`. The DOM would
// print those as the text "null", so optional children are always skipped instead.
for (const method of ['append', 'replaceChildren']) {
  const original = Element.prototype[method];
  Element.prototype[method] = function (...kids) {
    return original.apply(this, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  };
}

const app = document.getElementById('app');

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

const voice = createVoice({
  onUtterance: (text) => send(text, { fromVoice: true }),
  onState: (s, note) => {
    ui.voiceState = s;
    if (note !== undefined) ui.status = note;
    else ui.status = { idle: '', listening: 'Listening…', thinking: 'Sorting…', speaking: '' }[s] ?? '';
    renderOrb();
  },
  onInterim: (t) => {
    ui.interim = t;
    const el = document.getElementById('interim');
    if (el) el.textContent = t;
  },
  speakReplies: () => ui.state?.profile?.preferences?.voiceReplies !== false,
});

async function startSession() {
  try {
    const r = await api('/api/session/start', { body: { sessionId: ui.sessionId } });
    setSession(r.sessionId);
    if (r.text && (r.question || !ui.convo.length)) pushAssistant(r);
    return r;
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
    return null;
  }
}

function setSession(id) {
  ui.sessionId = id;
  try {
    if (id) sessionStorage.setItem('bd.session', id);
    else sessionStorage.removeItem('bd.session');
  } catch {}
}

function pushAssistant(r) {
  ui.convo.push({ role: 'assistant', text: r.text, question: r.question, links: r.links ?? [], actions: r.actions ?? [] });
  renderConvo();
}

async function send(text, { fromVoice = false } = {}) {
  text = text.trim();
  if (!text) return null;
  ui.convo.push({ role: 'user', text });
  renderConvo();
  const r = await say(text, ui.sessionId);
  if (r.offline) {
    ui.online = false;
    renderTop();
  }
  if (r.sessionEnded) setSession(null);
  else if (r.sessionId) setSession(r.sessionId);
  pushAssistant(r);
  if (!fromVoice && r.sessionEnded) ui.status = '';
  refreshOverview();
  return r;
}

async function answer(option) {
  // Tapping a chip is the same as saying the answer.
  return send(option.value.startsWith('option:') ? option.value : option.value, {});
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function route() {
  return (location.hash.replace('#', '') || 'home').split('?')[0];
}

function navLink(id, label) {
  return h('a', { href: `#${id}`, 'aria-current': route() === id ? 'page' : undefined }, label);
}

function renderTop() {
  const top = document.getElementById('top');
  if (!top) return;
  top.replaceChildren();
  const name = ui.overview?.assistantName || ui.state?.profile?.assistantName;
  top.append(h('div', { class: 'brand' }, 'Brain Dump', name ? h('small', {}, `· ${name}`) : null));
  const pills = h('div', { class: 'pills' });
  const q = queued().length;
  if (!ui.online || q) pills.append(h('span', { class: 'offline' }, q ? `${q} saved offline` : 'Offline'));
  const needs = ui.overview?.needsMe?.items?.length ?? 0;
  pills.append(h('button', { class: `pill ${needs ? 'hot' : ''}`, onclick: () => send('What still needs me?') }, needs ? `Needs you · ${needs}` : 'Nothing needs you'));
  pills.append(h('button', { class: 'pill', onclick: () => send('What did you handle today?') }, 'Handled'));
  top.append(pills);
}

function renderOrb() {
  const orb = document.getElementById('orb');
  if (!orb) return;
  orb.className = `orb ${ui.voiceState}`;
  orb.setAttribute('aria-label', ui.voiceState === 'idle' ? 'Tap to talk' : 'Stop listening');
  orb.setAttribute('aria-pressed', ui.voiceState === 'idle' ? 'false' : 'true');
  const st = document.getElementById('status');
  if (st) st.textContent = ui.status || (voiceSupported ? '' : LOCAL ? 'Test version: type your thoughts below. Voice works in the full app.' : 'Voice isn’t available in this browser — type instead.');
}

function renderConvo() {
  const box = document.getElementById('convo');
  if (!box) return;
  box.replaceChildren();
  const recent = ui.convo.slice(-12);
  recent.forEach((t, i) => {
    box.append(h('div', { class: `bubble ${t.role}` }, t.text));
    const isLast = i === recent.length - 1;
    if (t.role !== 'assistant') return;
    if (t.links?.length) box.append(h('div', { class: 'chips' }, t.links.map((l) => h('a', { class: 'linkbtn', href: l.url, target: '_blank', rel: 'noopener' }, l.label))));
    if (isLast && t.question?.options?.length) {
      box.append(h('div', { class: 'chips' }, t.question.options.map((o, j) => h('button', { class: `chip ${j === 0 ? 'primary' : ''}`, onclick: () => answer(o) }, o.label))));
    }
    const undoable = (t.actions ?? []).filter((a) => a.undoable);
    if (isLast && undoable.length) {
      box.append(h('div', { class: 'receipts' }, h('div', { class: 'receipt' }, h('span', {}, `${undoable.length} change${undoable.length > 1 ? 's' : ''} made`), h('button', { onclick: () => send('undo') }, 'Undo'))));
    }
  });
  box.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderHomeCards() {
  const box = document.getElementById('cards');
  if (!box || !ui.overview || MINI) return;
  box.replaceChildren();
  box.append(setupCard() ?? installHint());
  const o = ui.overview;
  if (o.needsMe.items.length) {
    box.append(h('section', { class: 'card' }, h('h2', {}, 'Needs you'), h('ul', { class: 'list' }, o.needsMe.items.slice(0, 6).map((i) => h('li', {}, h('span', { class: 'grow' }, i.text))))));
  }
  if (o.upcoming.length) {
    box.append(
      h('section', { class: 'card' }, h('h2', {}, 'Coming up'),
        h('ul', { class: 'list' }, o.upcoming.slice(0, 6).map((e) => h('li', {}, h('span', { class: 'grow' }, e.title, h('div', { class: 'sub' }, e.when)), e.meeting ? h('a', { class: 'linkbtn', href: e.meeting.url, target: '_blank', rel: 'noopener' }, 'Join') : null)))),
    );
  }
}

function renderHome() {
  app.replaceChildren(
    h('header', { class: 'top', id: 'top' }),
    h('section', { class: 'hero' }, h('h1', {}, "What's on your mind?"), h('p', {}, LOCAL ? 'Type it the way you’d say it. Say “that’s all” when you’re done.' : 'Tap and talk, or type. Say “that’s all” when you’re done.')),
    h('div', { class: 'orb-wrap' }, h('button', { id: 'orb', class: 'orb idle', onclick: onOrb, 'aria-label': 'Tap to talk' }, MIC())),
    h('div', { class: 'status-line', id: 'status', 'aria-live': 'polite' }),
    h('div', { class: 'interim', id: 'interim' }),
    h('form', { class: 'composer', onsubmit: onSubmit },
      h('label', { class: 'sr', for: 'say' }, 'Type a thought'),
      h('input', { id: 'say', autocomplete: 'off', enterkeyhint: 'send', placeholder: 'I need to…' }),
      h('button', { type: 'submit' }, 'Send')),
    h('div', { class: 'convo', id: 'convo', 'aria-live': 'polite' }),
    h('div', { id: 'cards' }),
    nav(),
  );
  renderTop();
  renderOrb();
  renderConvo();
  renderHomeCards();
}

function nav() {
  return h('nav', { class: 'nav' }, navLink('home', 'Talk'), navLink('lists', 'Lists'), navLink('history', 'History'), navLink('settings', 'Settings'));
}

async function onOrb() {
  if (voice.interrupt()) return;
  if (voice.active) {
    voice.stop();
    return;
  }
  if (!ui.sessionId) await startSession();
  if (!voiceSupported || !voice.start()) {
    document.getElementById('say')?.focus();
  }
}

async function onSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('say');
  const text = input.value;
  input.value = '';
  if (!ui.sessionId) await startSession();
  await send(text);
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

async function itemAction(kind, id, action = 'complete') {
  await api(`/api/items/${kind}/${id}`, { body: { action } });
  await loadState();
  renderRoute();
}

function renderLists() {
  const s = ui.state;
  const now = Date.now();
  const fmt = (iso, allDay) => {
    const d = new Date(iso);
    return allDay ? d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  };
  const events = s.events.filter((e) => e.status === 'confirmed' && Date.parse(e.end) > now).slice(0, 20);
  const shopping = s.shopping.filter((i) => i.status === 'needed');
  const reminders = s.reminders.filter((r) => r.status === 'open').sort((a, b) => (a.dueAt ?? '9') < (b.dueAt ?? '9') ? -1 : 1);
  const waiting = s.waiting.filter((w) => w.status === 'waiting');
  const drafts = s.drafts.filter((d) => d.status === 'draft');
  const contact = (id) => s.contacts.find((c) => c.id === id)?.name ?? 'someone';
  app.replaceChildren(
    h('header', { class: 'top', id: 'top' }),
    section('Coming up', events, (e) => h('li', {}, h('span', { class: 'grow' }, e.title, h('div', { class: 'sub' }, fmt(e.start, e.allDay), e.source !== 'local' ? ` · ${e.source}` : '')), e.meeting ? h('a', { class: 'linkbtn', href: e.meeting.url, target: '_blank', rel: 'noopener' }, 'Join') : null), 'Nothing coming up.'),
    section('Shopping', shopping, (i) => h('li', {}, h('button', { class: 'tick', 'aria-label': `Got ${i.name}`, onclick: () => itemAction('shopping', i.id) }), h('span', { class: 'grow' }, i.quantity ? `${i.quantity} × ${i.name}` : i.name)), 'Your list is empty.'),
    section('Reminders', reminders, (r) => h('li', {}, h('button', { class: 'tick', 'aria-label': `Done: ${r.text}`, onclick: () => itemAction('reminder', r.id) }), h('span', { class: 'grow' }, r.text, r.dueAt ? h('div', { class: 'sub' }, fmt(r.dueAt)) : null)), 'Nothing to remember.'),
    section('Ready to send', drafts, (d) => h('li', {}, h('span', { class: 'grow' }, `To ${contact(d.to)}`, h('div', { class: 'sub' }, d.body)),
      d.handoffUrl ? h('a', { class: 'linkbtn', href: d.handoffUrl, target: '_blank', rel: 'noopener', onclick: () => setTimeout(() => itemAction('draft', d.id, 'sent'), 500) }, 'Send') : null,
      h('button', { class: 'btn ghost small', onclick: () => itemAction('draft', d.id, 'discard') }, 'Discard')), 'No drafts.'),
    section('Waiting', waiting, (w) => h('li', {}, h('button', { class: 'tick', 'aria-label': 'Resolved', onclick: () => itemAction('waiting', w.id) }), h('span', { class: 'grow' }, w.direction === 'them' ? `Waiting on ${w.who}` : `${w.who} is waiting on you`, w.about ? h('div', { class: 'sub' }, w.about) : null)), 'Not waiting on anyone.'),
    section('Notes & ideas', s.notes.slice(-10).reverse(), (n) => h('li', {}, h('span', { class: 'grow' }, n.text, h('div', { class: 'sub' }, n.kind))), 'No notes yet.'),
    nav(),
  );
  renderTop();
}

function section(title, items, row, empty) {
  return h('section', { class: 'card' }, h('h2', {}, title), items.length ? h('ul', { class: 'list' }, items.map(row)) : h('p', { class: 'empty' }, empty));
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function renderHistory() {
  const hist = await api('/api/history');
  app.replaceChildren(
    h('header', { class: 'top', id: 'top' }),
    h('section', { class: 'card' }, h('h2', {}, 'What I did'),
      hist.ledger.length
        ? h('ul', { class: 'list' }, hist.ledger.slice(0, 60).map((l) => h('li', {},
          h('span', { class: 'grow' }, l.summary, h('div', { class: 'sub' }, new Date(l.at).toLocaleString(), l.auto ? ' · handled for you' : ' · you approved', l.verified ? '' : ' · not verified')),
          l.undoneAt ? h('span', { class: 'tag' }, 'undone') : l.undoable ? h('button', { class: 'btn ghost small', onclick: async () => { const r = await api(`/api/undo/${l.id}`, { body: {} }); toast(r.message); renderHistory(); } }, 'Undo') : null)))
        : h('p', { class: 'empty' }, 'Nothing yet.')),
    h('section', { class: 'card' }, h('h2', {}, 'Conversations'),
      hist.sessions.length
        ? hist.sessions.slice(0, 15).map((s) => h('details', {}, h('summary', {}, new Date(s.startedAt).toLocaleString(), ` · ${s.turns.length} turns`), h('div', { class: 'convo' }, s.turns.map((t) => h('div', { class: `bubble ${t.role}` }, t.text)))))
        : h('p', { class: 'empty' }, 'No conversations yet.')),
    nav(),
  );
  renderTop();
}

// ---------------------------------------------------------------------------
// Settings — the user is always in control
// ---------------------------------------------------------------------------

const SCOPES = {
  calendar: 'Calendar', reminders: 'Reminders', shopping: 'Shopping list', notes: 'Notes', memory: 'Memory', contacts: 'People',
  messaging: 'Messages', email: 'Email', meetings: 'Meetings', bookings: 'Bookings', purchases: 'Purchases', music: 'Music', fitness: 'Fitness',
};
const LEVELS = { none: 'Off', read: 'Read only', draft: 'Prepare / draft', act: 'Handle for me' };

async function patchProfile(body) {
  await api('/api/profile', { method: 'PATCH', body });
  await loadState();
}

async function renderSettings() {
  const s = ui.state;
  const p = s.profile;
  const [devices, integrations, ai] = await Promise.all([api('/api/devices'), api('/api/integrations').catch(() => null), api('/api/ai').catch(() => null)]);
  const select = (value, options, onchange) => h('select', { onchange: (e) => onchange(e.target.value) }, Object.entries(options).map(([v, l]) => h('option', { value: v, selected: v === value ? true : undefined }, l)));

  const pairBox = h('div');
  app.replaceChildren(
    h('header', { class: 'top', id: 'top' }),
    h('section', { class: 'card' }, h('h2', {}, 'Assistant'),
      h('div', { class: 'row' }, h('label', { for: 'aname' }, 'Name'), h('input', { id: 'aname', type: 'text', value: p.assistantName ?? '', onchange: (e) => patchProfile({ assistantName: e.target.value }) })),
      h('div', { class: 'row' }, h('label', {}, 'Your time zone'), h('input', { type: 'text', value: p.timeZone, onchange: (e) => patchProfile({ timeZone: e.target.value }) })),
      h('div', { class: 'row' }, h('label', {}, 'Speak replies'), select(String(p.preferences.voiceReplies), { true: 'On', false: 'Off' }, (v) => patchProfile({ preferences: { voiceReplies: v === 'true' } }))),
      h('div', { class: 'row' }, h('label', {}, 'Suggestions'), select(p.preferences.proactivity, { normal: 'When genuinely useful', quiet: 'Only essentials' }, (v) => patchProfile({ preferences: { proactivity: v } }))),
      h('div', { class: 'row' }, h('label', {}, '“Clear” emails means'), select(p.preferences.clearMeans, { archive: 'Archive (undoable)', delete: 'Delete' }, (v) => patchProfile({ preferences: { clearMeans: v } }))),
      h('div', { class: 'row' }, h('label', {}, 'Remind me before events (min)'), h('input', { type: 'number', min: 0, max: 240, value: p.preferences.defaultEventLeadMin, onchange: (e) => patchProfile({ preferences: { defaultEventLeadMin: Number(e.target.value) } }) })),
      h('div', { class: 'row' }, h('label', {}, 'Sunday briefing'), select(String(p.preferences.weeklyBriefing.enabled), { true: 'On', false: 'Off' }, (v) => patchProfile({ preferences: { weeklyBriefing: { ...p.preferences.weeklyBriefing, enabled: v === 'true' } } }))),
      LOCAL ? null : h('div', { class: 'row' }, h('label', {}, 'Notifications on this phone', h('div', { class: 'sub' }, 'Reminders arrive even when the app is closed.')), h('button', { class: 'btn ghost small', onclick: enablePush }, 'Turn on'))),

    h('section', { class: 'card' }, h('h2', {}, 'What I can do'),
      h('p', { class: 'empty' }, 'I only act within what you allow. Anything involving money, or that can’t be undone, always comes back to you.'),
      s.permissions.map((perm) => h('div', { class: 'row' }, h('label', {}, SCOPES[perm.scope] ?? perm.scope), select(perm.level, LEVELS, async (v) => { await api(`/api/permissions/${perm.scope}`, { method: 'PUT', body: { level: v } }); await loadState(); })))),

    claudeCard(ai),
    LOCAL ? null : h('section', { class: 'card' }, h('h2', {}, 'Talk with one tap'),
      h('p', { class: 'empty' }, 'A Home Screen widget, the Action Button, or a double-tap on the back of your phone that listens straight away.'),
      h('a', { class: 'btn', href: '#shortcut' }, 'Set up one-tap talking')),

    s.trust.length ? h('section', { class: 'card' }, h('h2', {}, 'Things I don’t ask about any more'),
      s.trust.map((t) => h('div', { class: 'row' }, h('label', {}, t.actionType.replace('.', ' → '), h('div', { class: 'sub' }, t.trustedVia === 'earned' ? `after ${t.confirmed} approvals` : t.trustedVia === 'explicit' ? 'you told me' : `${t.confirmed} approvals`)),
        select(String(t.trusted), { true: 'Just do it', false: 'Ask me' }, async (v) => { await api(`/api/trust/${encodeURIComponent(t.actionType)}`, { method: 'PATCH', body: { trusted: v === 'true' } }); await loadState(); })))) : null,

    h('section', { class: 'card' }, h('h2', {}, 'What I remember'),
      s.memories.length
        ? h('ul', { class: 'list' }, s.memories.map((m) => h('li', {}, h('span', { class: 'grow' }, `${m.subject}: ${m.value}`, h('div', { class: 'sub' }, `${m.provenance} · ${new Date(m.learnedAt).toLocaleDateString()}${m.automationAllowed ? ' · automation allowed' : ''}`)),
          !m.confirmed ? h('button', { class: 'btn ghost small', onclick: async () => { await api(`/api/memories/${m.id}`, { method: 'PATCH', body: { confirmed: true } }); await loadState(); renderSettings(); } }, 'Confirm') : null,
          h('button', { class: 'btn ghost small', onclick: async () => { await api(`/api/memories/${m.id}`, { method: 'DELETE' }); await loadState(); renderSettings(); } }, 'Forget'))))
        : h('p', { class: 'empty' }, 'Nothing yet. I’ll always tell you what I pick up.')),

    h('section', { class: 'card' }, h('h2', {}, 'Routines'),
      s.routines.length
        ? h('ul', { class: 'list' }, s.routines.map((r) => h('li', {}, h('span', { class: 'grow' }, r.title, h('div', { class: 'sub' }, `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.weekday]} ${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}${r.items ? ` · ${r.items.join(', ')}` : ''}`)),
          select(r.status, { confirmed: 'Remind me', automated: 'Handle it', paused: 'Paused' }, async (v) => { await api(`/api/routines/${r.id}`, { method: 'PATCH', body: { status: v } }); await loadState(); }),
          h('button', { class: 'btn ghost small', onclick: async () => { await api(`/api/routines/${r.id}`, { method: 'DELETE' }); await loadState(); renderSettings(); } }, 'Remove'))))
        : h('p', { class: 'empty' }, 'When I notice something you do regularly, I’ll ask before remembering it.')),

    LOCAL ? null : h('section', { class: 'card' }, h('h2', {}, 'Connected services'),
      integrations?.available?.google
        ? [
          h('p', { class: 'empty' }, s.integrations.google ? `Google connected: ${s.integrations.google.scopes.join(', ')}` : 'Connect the tools you already use. You choose exactly what I can reach.'),
          h('div', { class: 'chips' },
            h('button', { class: 'chip', onclick: () => connectGoogle(['calendar']) }, 'Google Calendar'),
            h('button', { class: 'chip', onclick: () => connectGoogle(['gmail']) }, 'Gmail'),
            h('button', { class: 'chip', onclick: () => connectGoogle(['gmail-send']) }, 'Let me send email'),
            s.integrations.google ? h('button', { class: 'chip', onclick: async () => { await api('/api/integrations/google', { method: 'DELETE' }); await loadState(); renderSettings(); } }, 'Disconnect Google') : null),
        ]
        : h('p', { class: 'empty' }, 'This server has no Google credentials configured. Your Brain Dump calendar can still be subscribed to from any calendar app:'),
      h('div', { class: 'chips' }, h('button', { class: 'chip', onclick: async () => { const r = await api('/api/calendar/feed', { body: {} }); prompt('Subscribe to this private calendar link in Apple/Google/Outlook Calendar:', r.url.startsWith('http') ? r.url : location.origin + r.url); } }, 'Calendar subscription link'))),

    LOCAL ? null : h('section', { class: 'card' }, h('h2', {}, 'Backup code'),
      h('p', { class: 'empty' }, 'Your way back in if you lose or change your phone.'),
      h('a', { class: 'btn', href: '#backup' }, 'Get my backup code')),
    LOCAL ? null : h('section', { class: 'card' }, h('h2', {}, 'Devices'),
      h('ul', { class: 'list' }, devices.devices.map((d) => h('li', {}, h('span', { class: 'grow' }, d.name, d.current ? ' (this device)' : '', h('div', { class: 'sub' }, `last seen ${new Date(d.lastSeenAt).toLocaleString()}`)),
        !d.current ? h('button', { class: 'btn ghost small', onclick: async () => { await api(`/api/devices/${d.id}`, { method: 'DELETE' }); renderSettings(); } }, 'Remove') : null))),
      h('div', { class: 'chips' }, h('button', { class: 'chip', onclick: async () => { const r = await api('/api/auth/pair/start', { body: {} }); pairBox.replaceChildren(h('p', { class: 'empty' }, 'On your other device choose “I already use Brain Dump” and enter:'), h('div', { class: 'code' }, r.code), h('p', { class: 'empty' }, 'Valid for 10 minutes, once.')); } }, 'Add another device')),
      pairBox),

    LOCAL ? h('section', { class: 'card' }, h('h2', {}, 'Test data'),
      h('p', { class: 'empty' }, 'This test version keeps everything in this browser on this phone only. Nothing is sent anywhere.'),
      resetButton()) : h('section', { class: 'card' }, h('h2', {}, 'Your data'),
      h('p', { class: 'empty' }, 'Encrypted at rest. Nothing is recorded unless you tap to talk.'),
      h('div', { class: 'chips' },
        h('button', { class: 'chip', onclick: exportData }, 'Export everything'),
        h('a', { class: 'chip', href: '#history' }, 'History'),
        h('button', { class: 'chip', onclick: deleteAccount }, 'Delete account'))),
    nav(),
  );
  renderTop();
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

async function enablePush() {
  if (isIOS() && !isStandalone()) {
    toast('On iPhone, first add Brain Dump to your Home Screen (Share → Add to Home Screen), open it from there, then turn notifications on.', [], 12000);
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('This browser can’t receive notifications.');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast('Notifications are off. You can allow them in your phone’s settings.');
      return;
    }
    const { publicKey } = await api('/api/push/key');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
    await api('/api/push/subscribe', { body: { subscription: sub.toJSON() } });
    await api('/api/push/test', { body: {} });
    toast('Notifications are on. You should see a test one now.');
  } catch (err) {
    toast(`Couldn’t turn on notifications: ${err.message}`);
  }
}

function installHint() {
  let dismissed = false;
  try { dismissed = localStorage.getItem('bd.installHint') === 'no'; } catch {}
  if (LOCAL || isStandalone() || dismissed || !isIOS()) return null;
  const card = h('section', { class: 'card' }, h('h2', {}, 'Make it an app'),
    h('p', {}, 'Tap the Share button, then “Add to Home Screen”. Brain Dump then opens like an app and can send you reminders.'),
    h('div', { class: 'chips' }, h('button', { class: 'chip', onclick: () => { try { localStorage.setItem('bd.installHint', 'no'); } catch {} card.remove(); } }, 'Got it')));
  return card;
}

function claudeCard(ai) {
  const card = h('section', { class: 'card' }, h('h2', {}, 'Claude'));
  if (LOCAL) {
    const on = ai?.enabled !== false;
    card.append(
      h('p', { class: 'empty' }, ai?.state === 'unavailable'
        ? 'Claude isn’t available here. Open this page inside the Claude app or claude.ai to use it.'
        : 'When I can’t work out what you meant, I ask Claude to help. This uses your own Claude account, so there’s no key to set up. The first time, you’ll be asked to allow it.'),
      h('div', { class: 'row' }, h('label', {}, 'Help from Claude'),
        h('select', { onchange: async (e) => { await api('/api/ai', { method: e.target.value === 'on' ? 'PUT' : 'DELETE', body: {} }); renderSettings(); } },
          h('option', { value: 'on', selected: on || undefined }, 'On'), h('option', { value: 'off', selected: !on || undefined }, 'Off'))));
    return card;
  }
  const status = h('p', { class: 'empty' }, ai?.connected
    ? `Connected ${ai.hint ? `with your key ${ai.hint}` : ai.source === 'server' ? 'with the key set on Render. Nothing to paste here.' : ''} When I can’t work out what you meant, Claude helps, and everything still goes through the same safety checks.`
    : 'Optional. Add an Anthropic API key and Claude will help with anything I can’t work out on my own. Get a key at console.anthropic.com.');
  const input = h('input', { type: 'password', id: 'aikey', placeholder: 'sk-ant-…', autocomplete: 'off', 'aria-label': 'Anthropic API key' });
  const msg = h('p', { class: 'empty', 'aria-live': 'polite' });
  card.append(status,
    h('form', { class: 'composer', onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = 'Checking the key…';
      try {
        await api('/api/ai', { method: 'PUT', body: { apiKey: input.value } });
        renderSettings();
      } catch (err) {
        msg.textContent = err.message;
      }
    } }, input, h('button', { type: 'submit' }, 'Save')),
    msg,
    h('div', { class: 'chips' },
      h('button', { class: 'btn ghost small', onclick: async () => {
        msg.textContent = 'Asking Claude…';
        const r = await api('/api/ai/test', { body: {} }).catch((e) => ({ message: e.message }));
        msg.textContent = r.message;
      } }, 'Test Claude'),
      ai?.hint ? h('button', { class: 'btn ghost small', onclick: async () => { await api('/api/ai', { method: 'DELETE' }); renderSettings(); } }, 'Remove key') : null));
  return card;
}

function resetButton() {
  const btn = h('button', { class: 'btn ghost small', onclick: async () => {
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.textContent = 'Tap again to erase everything';
      return;
    }
    await api('/api/account', { method: 'DELETE', body: { confirm: 'delete everything' } });
    try { sessionStorage.clear(); } catch {}
    location.hash = '';
    location.reload();
  } }, 'Start over');
  return btn;
}

async function connectGoogle(services) {
  try {
    const r = await api('/api/integrations/google/start', { body: { services } });
    location.href = r.url;
  } catch (err) {
    toast(err.message);
  }
}

async function exportData() {
  const data = await api('/api/export');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'brain-dump-export.json' });
  document.body.append(a);
  a.click();
  a.remove();
}

async function deleteAccount() {
  if (!confirm('Delete your Brain Dump account and everything in it? This cannot be undone.')) return;
  await api('/api/account', { method: 'DELETE', body: { confirm: 'delete everything' } });
  auth.token = null;
  localStorage.clear();
  location.hash = '';
  location.reload();
}

// ---------------------------------------------------------------------------
// Onboarding (no passwords: this device gets its own key; others pair with a code)
// ---------------------------------------------------------------------------

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Electron/.test(ua)) return 'Desktop app';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Browser';
}

async function renderWelcome() {
  const config = await api('/api/auth/config').catch(() => ({}));
  const msg = h('p', { class: 'empty', 'aria-live': 'polite' });
  const invite = h('input', { id: 'invite', autocomplete: 'off', placeholder: 'Invite code', 'aria-label': 'Invite code', class: 'plain' });
  const startForm = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/auth/register', { body: { deviceName: deviceLabel(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, inviteCode: invite.value } });
      auth.token = r.token;
      boot();
    } catch (err) {
      msg.textContent = err.message;
    }
  } }, config.inviteRequired ? invite : null, h('button', { class: 'btn', type: 'submit' }, 'Start'));
  const codeInput = h('input', { id: 'pair', autocomplete: 'off', placeholder: '6-digit code or backup code', 'aria-label': 'Pairing code or backup code', class: 'plain' });
  const pairForm = h('form', { class: 'stack', hidden: true, onsubmit: async (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    const isPairing = /^\d{6}$/.test(code.replace(/\s/g, ''));
    try {
      const r = await api(isPairing ? '/api/auth/pair/complete' : '/api/auth/recover', { body: { code, deviceName: deviceLabel() } });
      auth.token = r.token;
      boot();
    } catch (err) {
      msg.textContent = err.message;
    }
  } }, h('p', { class: 'empty' }, 'Enter the 6-digit code from Settings → Devices on your other device, or your backup code.'), codeInput, h('button', { class: 'btn', type: 'submit' }, 'Connect this device'));
  app.replaceChildren(
    h('div', { class: 'onboard' },
      h('h1', {}, 'Get it out of your head.'),
      h('p', {}, 'Tell me what’s on your mind — I’ll help with the rest.'),
      startForm,
      h('div', { class: 'stack' },
        h('button', { class: 'btn ghost', onclick: () => { pairForm.hidden = false; codeInput.focus(); } }, 'I already use Brain Dump'),
        pairForm),
      msg),
  );
}

// ---------------------------------------------------------------------------
// Guided setup screens
// ---------------------------------------------------------------------------

function copyButton(text, label = 'Copy') {
  return h('button', { class: 'btn small', type: 'button', onclick: async (e) => {
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = 'Copied ✓';
    } catch {
      e.target.textContent = 'Press and hold the text to copy';
    }
  } }, label);
}

function screen(title, ...body) {
  app.replaceChildren(
    h('header', { class: 'top', id: 'top' }),
    h('a', { class: 'back', href: '#settings' }, '‹ Settings'),
    h('h1', { class: 'screen-title' }, title),
    ...body,
    nav(),
  );
  renderTop();
  window.scrollTo(0, 0);
}

function renderBackupScreen() {
  const out = h('div', { class: 'card' },
    h('p', {}, 'Brain Dump has no password. If you lose this phone, get a new one, or clear Safari’s data, this code is how you get back in, with everything still there.'),
    h('p', { class: 'empty' }, 'Save it in your Notes app, a password manager, or somewhere safe. Anyone with the code can open your Brain Dump, so keep it private.'),
    h('button', { class: 'btn big', onclick: async () => {
      const r = await api('/api/auth/recovery', { body: {} });
      out.replaceChildren(
        h('p', {}, 'Your backup code:'),
        h('div', { class: 'code', 'aria-label': 'Backup code' }, r.code),
        h('div', { class: 'chips center' }, copyButton(r.code, 'Copy code')),
        h('p', { class: 'empty' }, 'It won’t be shown again. Making a new code later replaces this one.'),
        h('p', { class: 'empty' }, 'To use it on a new phone: open Brain Dump, tap “I already use Brain Dump”, and type the code.'),
        h('a', { class: 'btn big', href: '#home', onclick: () => refreshSetup() }, 'I’ve saved it'));
    } }, 'Show my backup code'));
  screen('Backup code', out);
}

async function renderShortcutScreen() {
  const status = h('div');
  const make = h('button', { class: 'btn big', onclick: async () => {
    make.disabled = true;
    try {
      const r = await api('/api/auth/shortcut', { body: {} });
      showLink(r.link);
    } catch (err) {
      status.replaceChildren(h('p', { class: 'error' }, `Couldn’t create the link: ${err.message}`));
      make.disabled = false;
    }
  } }, 'Create my Shortcut link');

  const showLink = (link) => {
    const test = h('p', { class: 'empty', 'aria-live': 'polite' });
    status.replaceChildren(
      h('p', {}, 'Your personal link. Copy it now; you’ll paste it in step 3.'),
      h('div', { class: 'linkbox mono' }, link),
      h('div', { class: 'chips' }, copyButton(link, 'Copy link'),
        h('button', { class: 'btn ghost small', onclick: async () => {
          test.textContent = 'Testing…';
          try {
            const res = await fetch(link + encodeURIComponent('What still needs me?'));
            test.textContent = res.ok ? `It works. Brain Dump replied: “${await res.text()}”` : `The link didn’t work (${res.status}).`;
          } catch {
            test.textContent = 'Couldn’t reach Brain Dump.';
          }
        } }, 'Test the link')),
      test,
      h('p', { class: 'empty' }, 'Keep this link private: it works like a key. You can switch it off any time in Settings → Devices (“Siri Shortcut”).'));
    make.remove();
  };

  const step = (n, title, detail) => h('li', {}, h('strong', {}, title), detail ? h('div', { class: 'sub' }, detail) : null);

  screen('Talk with one tap',
    h('div', { class: 'card' },
      h('p', {}, 'Talk to Brain Dump without opening it. A Siri Shortcut listens, sends what you say, and reads the answer out loud. Then you can put it on your Home Screen as a widget, on the Action Button, or behind a double-tap on the back of your phone.'),
      status, make),
    h('section', { class: 'card' }, h('h2', {}, 'Make the Shortcut (about 2 minutes)'),
      h('ol', { class: 'steps big' },
        step(1, 'Open the Shortcuts app and tap +', 'It’s Apple’s app with the pink and blue icon. The + is at the top right.'),
        step(2, 'Add “Dictate Text”', 'Tap “Add Action” (or the search bar at the bottom), type Dictate, and tap Dictate Text.'),
        step(3, 'Add “Get Contents of URL” and paste your link', 'Search “Get Contents”, tap it, then tap the blue “URL” and paste.'),
        step(4, 'Put “Dictated Text” on the end of the link', 'With the cursor at the very end of the link, tap “Dictated Text” in the bar above the keyboard. It appears as a blue bubble.'),
        step(5, 'Add “Speak Text”', 'Search “Speak”, tap Speak Text. It reads Brain Dump’s answer.'),
        step(6, 'Name it “Brain Dump”', 'Tap the name at the top, rename it, then tap Done.'))),
    h('section', { class: 'card' }, h('h2', {}, 'Put it one tap away'),
      h('ul', { class: 'steps' },
        h('li', {}, h('strong', {}, 'Home Screen widget: '), 'press and hold an empty spot on your Home Screen → Edit → Add Widget → Shortcuts → choose Brain Dump.'),
        h('li', {}, h('strong', {}, 'Control Centre / Lock Screen (iOS 18): '), 'open Control Centre → + → Add a Control → Shortcut → Brain Dump.'),
        h('li', {}, h('strong', {}, 'Double-tap the back of the phone: '), 'Settings → Accessibility → Touch → Back Tap → Double Tap → Brain Dump.'),
        h('li', {}, h('strong', {}, 'Action Button (iPhone 15 Pro and newer): '), 'Settings → Action Button → Shortcut → Brain Dump.'),
        h('li', {}, h('strong', {}, 'Siri: '), 'say “Hey Siri, Brain Dump”.'))),
    h('section', { class: 'card' }, h('h2', {}, 'The first time you run it'),
      h('p', {}, 'Your iPhone asks whether Brain Dump may use dictation and whether it may connect to your Brain Dump address. Choose Allow, then Always Allow, so it doesn’t ask again.'),
      h('p', { class: 'empty' }, 'If Brain Dump asks you a question back (like “What time?”), run the Shortcut again within 10 minutes to answer.')),
  );
}

// ---------------------------------------------------------------------------
// "Finish setting up" checklist on the Home screen
// ---------------------------------------------------------------------------

let setup = null;
async function refreshSetup() {
  if (LOCAL) return;
  try {
    setup = await api('/api/setup');
  } catch {
    setup = null;
  }
  if (route() === 'home') renderHomeCards();
}

function setupCard() {
  if (LOCAL || !setup) return null;
  let hidden = false;
  try { hidden = localStorage.getItem('bd.setupHidden') === 'yes'; } catch {}
  const items = [];
  if (isIOS() && !isStandalone()) {
    items.push({ label: 'Add Brain Dump to your Home Screen', detail: 'Tap Share (the square with an arrow), then “Add to Home Screen”. Open it from there from now on.' });
  }
  if (!setup.push && (!isIOS() || isStandalone())) items.push({ label: 'Turn on reminders', detail: 'So reminders reach you when the app is closed.', action: () => enablePush().then(refreshSetup), cta: 'Turn on' });
  if (!setup.backupCode) items.push({ label: 'Save a backup code', detail: 'Your way back in if you change phones.', href: '#backup', cta: 'Set up' });
  if (!setup.shortcutCreated) items.push({ label: 'Talk with one tap', detail: 'A widget or button that listens straight away.', href: '#shortcut', cta: 'Set up' });
  if (!items.length || hidden) return null;
  return h('section', { class: 'card setup' }, h('h2', {}, 'Finish setting up'),
    h('ul', { class: 'list' }, items.map((i) => h('li', {},
      h('span', { class: 'grow' }, i.label, h('div', { class: 'sub' }, i.detail)),
      i.href ? h('a', { class: 'btn small', href: i.href }, i.cta) : i.action ? h('button', { class: 'btn small', onclick: i.action }, i.cta) : null))),
    h('button', { class: 'link', onclick: () => { try { localStorage.setItem('bd.setupHidden', 'yes'); } catch {} renderHomeCards(); } }, 'Hide this'));
}

// ---------------------------------------------------------------------------
// Data & boot
// ---------------------------------------------------------------------------

async function loadState() {
  ui.state = await api('/api/state');
  ui.version = ui.state.version;
}

async function refreshOverview() {
  try {
    ui.overview = await api('/api/overview');
    renderTop();
    if (route() === 'home') renderHomeCards();
  } catch {
    /* offline */
  }
}

async function renderRoute() {
  const r = route();
  if (MINI || r === 'home') return renderHome();
  if (!ui.state) await loadState();
  if (r === 'lists') return renderLists();
  if (r === 'settings') return renderSettings();
  if (r === 'history') return renderHistory();
  if (r === 'backup') return renderBackupScreen();
  if (r === 'shortcut') return renderShortcutScreen();
  return renderHome();
}

function onNotification(n) {
  const actions = (n.actions ?? []).map((a) => ({
    label: a.label,
    run: async () => {
      if (/^https?:/.test(a.value)) return window.open(a.value, '_blank', 'noopener');
      const r = await api(`/api/notifications/${n.id}/act`, { body: { value: a.value } });
      if (r?.text) {
        pushAssistant(r);
        if (r.question && r.sessionId) setSession(r.sessionId);
      }
    },
  }));
  toast(n.text, actions, actions.length ? 20000 : 8000);
  if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(ui.overview?.assistantName ?? 'Brain Dump', { body: n.text, tag: n.id });
    } catch {}
  }
}

let closeStream = () => {};

async function boot() {
  app.setAttribute('aria-busy', 'true');
  if (!auth.token) {
    app.removeAttribute('aria-busy');
    return renderWelcome();
  }
  try {
    await loadState();
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
    ui.online = false;
  }
  await flushQueue().then((replies) => replies.length && toast(`Sorted ${replies.length} thing${replies.length > 1 ? 's' : ''} you captured offline.`));
  refreshOverview();
  refreshSetup();
  closeStream();
  closeStream = openStream(async (type, data) => {
    if (type === 'sync' && data.version !== ui.version) {
      await loadState().catch(() => {});
      refreshOverview();
      if (route() === 'lists') renderLists();
    }
    if (type === 'notification') onNotification(data);
  });
  app.removeAttribute('aria-busy');
  await renderRoute();
  if (ui.state?.profile?.onboarding !== 'done') {
    const r = await startSession();
    if (r && !ui.convo.length) pushAssistant(r);
  }
  if (params.has('talk')) onOrb();
}

window.addEventListener('hashchange', renderRoute);
window.addEventListener('online', async () => {
  ui.online = true;
  const replies = await flushQueue();
  if (replies.length) toast(`Back online — sorted ${replies.length} thing${replies.length > 1 ? 's' : ''} you captured.`);
  renderTop();
  refreshOverview();
});
window.addEventListener('offline', () => {
  ui.online = false;
  renderTop();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    document.getElementById('say')?.focus();
  }
});

if (!LOCAL && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

boot().catch((err) => {
  app.replaceChildren(h('p', { class: 'boot' }, `Couldn't start: ${err.message}`));
});

export { enqueue };
