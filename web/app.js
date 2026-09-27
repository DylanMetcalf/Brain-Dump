// Brain Dump — the app shell and the four main screens: Home, Talk, Chat, Organise.
// Settings and setup screens live in settings.js.

import { api, auth, flushQueue, openStream, queued, say, NetworkError, LOCAL } from './api.js';
import { createVoice, voiceSupported as voiceAvailable } from './voice.js';
import { h, icon, brandMark, toast, sheet, linkIcon, greeting, fmtDay, fmtTime, isoDate } from './ui.js';
import { loadVoiceInfo } from './speech.js';
import { renderSettings, renderBackupScreen, renderShortcutScreen, renderHistory, renderWelcome, enablePush, isIOS, isStandalone } from './settings.js';

const voiceSupported = voiceAvailable && !LOCAL;
const params = new URLSearchParams(location.search);
const MINI = params.has('mini');
if (MINI) document.body.classList.add('mini');

export const ui = {
  sessionId: (() => { try { return sessionStorage.getItem('bd.session'); } catch { return null; } })(),
  convo: [],
  overview: null,
  state: null,
  setup: null,
  voiceState: 'idle',
  voiceNote: '',
  liveText: '',
  lastReply: null,
  online: navigator.onLine,
  version: 0,
  thinking: false,
  phone: null, // iPhone apps sync status
};

/** Runs the Brain Dump Shortcut, which adds anything new to Clock, Reminders, Calendar and Notes. */
export const PHONE_SYNC_URL = 'shortcuts://run-shortcut?name=Brain%20Dump&input=text&text=sync';

export function autoPhone() {
  try { return localStorage.getItem('bd.autoPhone') !== 'no'; } catch { return true; }
}

export async function refreshPhone() {
  if (LOCAL) return null;
  ui.phone = await api('/api/phone').catch(() => ui.phone);
  return ui.phone;
}

export const app = document.getElementById('app');

// ---------------------------------------------------------------------------
// Conversation (shared by Talk and Chat)
// ---------------------------------------------------------------------------

const voice = createVoice({
  onUtterance: (text) => send(text, { fromVoice: true }),
  onState: (s, note) => {
    ui.voiceState = s;
    ui.voiceNote = note ?? '';
    if (route() === 'talk') renderTalkState();
  },
  onTranscript: (t) => {
    ui.liveText = t;
    const el = document.getElementById('live');
    if (el) el.textContent = t;
  },
  speakReplies: () => ui.state?.profile?.preferences?.voiceReplies !== false,
  afterReply: (r) => {
    if (!r?.question && autoPhone() && isIOS() && r?.links?.some((l) => l.url === PHONE_SYNC_URL)) location.href = PHONE_SYNC_URL;
  },
});

function setSession(id) {
  ui.sessionId = id;
  try {
    if (id) sessionStorage.setItem('bd.session', id);
    else sessionStorage.removeItem('bd.session');
  } catch {}
}

async function startSession() {
  try {
    const r = await api('/api/session/start', { body: { sessionId: ui.sessionId } });
    setSession(r.sessionId);
    if (r.text && (r.question || !ui.convo.length)) addAssistant(r);
    return r;
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
    return null;
  }
}

function addAssistant(r) {
  ui.convo.push({ role: 'assistant', text: r.text, question: r.question, links: r.links ?? [], actions: r.actions ?? [], at: Date.now() });
  ui.lastReply = r;
  if (route() === 'chat') renderMessages();
  if (route() === 'talk') renderTalkState();
}

export async function send(text, { fromVoice = false } = {}) {
  text = text.trim();
  if (!text) return null;
  if (!ui.sessionId) await startSession();
  ui.convo.push({ role: 'user', text, at: Date.now() });
  ui.thinking = true;
  if (route() === 'chat') renderMessages();
  let r;
  try {
    r = await say(text, ui.sessionId);
  } finally {
    ui.thinking = false;
  }
  if (r.offline) ui.online = false;
  setSession(r.sessionEnded ? null : r.sessionId);
  // Anything that should also go into the iPhone's own apps?
  if (ui.phone?.enabled && r.actions?.length) {
    const p = await refreshPhone();
    if (p?.pending) {
      r.links = [...(r.links ?? []), { label: `Add ${p.summary} to your iPhone`, url: PHONE_SYNC_URL }];
      // Typed in the app: hand over straight away. Spoken: after the reply has been read out.
      if (autoPhone() && !fromVoice && isIOS()) setTimeout(() => { location.href = PHONE_SYNC_URL; }, 700);
    }
  }
  addAssistant(r);
  refreshOverview();
  return r;
}

// ---------------------------------------------------------------------------
// Shell: routing and the tab bar
// ---------------------------------------------------------------------------

export function route() {
  return (location.hash.replace('#', '') || 'home').split('?')[0];
}

const TABS = [
  ['home', 'Home', 'home'],
  ['chat', 'Chat', 'chat'],
  ['talk', 'Talk', 'mic'],
  ['organise', 'Organise', 'grid'],
  ['settings', 'Settings', 'gear'],
];

export function tabBar() {
  const r = route();
  return h('nav', { class: 'tabbar', 'aria-label': 'Main' },
    TABS.map(([id, label, ic]) => id === 'talk'
      ? h('a', { href: '#talk', class: `tab tab-talk ${r === 'talk' ? 'on' : ''}`, 'aria-label': 'Talk', 'aria-current': r === 'talk' ? 'page' : undefined }, h('span', { class: 'talk-dot' }, brandMark(30, { onDark: true })))
      : h('a', { href: `#${id}`, class: `tab ${r === id || (id === 'settings' && ['backup', 'shortcut', 'history'].includes(r)) ? 'on' : ''}`, 'aria-current': r === id ? 'page' : undefined }, icon(ic, 23), h('span', {}, label))));
}

export function page(cls, ...content) {
  app.className = `app ${cls}`;
  app.replaceChildren(...content, tabBar());
}

function header(title, sub, right) {
  return h('header', { class: 'page-head' }, h('div', {}, sub ? h('p', { class: 'eyebrow' }, sub) : null, h('h1', {}, title)), right ?? null);
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

const SECTIONS = { next: 'Up next', needs: 'Needs you', reminders: 'Reminders', shopping: 'Shopping', notes: 'Notes' };
export function homeSections() {
  try {
    const v = JSON.parse(localStorage.getItem('bd.sections') ?? 'null');
    if (Array.isArray(v)) return v;
  } catch {}
  return ['next', 'needs', 'reminders', 'shopping'];
}
export function setHomeSections(list) {
  try { localStorage.setItem('bd.sections', JSON.stringify(list)); } catch {}
}

function renderHome() {
  const name = ui.state?.profile?.displayName;
  const s = ui.state;
  const now = Date.now();
  const typed = h('input', { id: 'home-say', placeholder: 'Or type it…', autocomplete: 'off', enterkeyhint: 'send', 'aria-label': 'Type a thought' });

  const quick = [
    ['calendar', 'Event', () => addSheet('event')],
    ['bell', 'Reminder', () => addSheet('reminder')],
    ['note', 'Note', () => addSheet('note')],
    ['message', 'Message', () => messageSheet()],
    ['timer', 'Timer', () => timerSheet()],
    ['bag', 'Shopping', () => addSheet('shopping')],
  ];

  const cards = [];
  const setup = setupCard();
  if (setup) cards.push(setup);
  for (const key of homeSections()) {
    if (!s) break;
    if (key === 'next') {
      const events = s.events.filter((e) => e.status === 'confirmed' && Date.parse(e.end) > now).slice(0, 4);
      cards.push(card('Up next', '#organise?calendar', events.length
        ? events.map((e) => row({ icon: 'calendar', title: e.title, sub: `${fmtDay(e.start)}${e.allDay ? '' : ` · ${fmtTime(e.start)}`}`, onClick: () => eventSheet(e) }))
        : empty('Nothing coming up. Say “Dinner with Sam on Friday at 7”.')));
    }
    if (key === 'needs' && ui.overview?.needsMe?.items?.length) {
      cards.push(card('Needs you', null, ui.overview.needsMe.items.slice(0, 4).map((i) => row({ icon: 'sparkle', title: i.text }))));
    }
    if (key === 'reminders') {
      const rem = s.reminders.filter((r) => r.status === 'open').sort((a, b) => (a.dueAt ?? '9') < (b.dueAt ?? '9') ? -1 : 1).slice(0, 4);
      if (rem.length) cards.push(card('Reminders', '#organise?reminders', rem.map((r) => row({ check: () => itemAction('reminder', r.id), title: r.text, sub: r.dueAt ? `${fmtDay(r.dueAt)} · ${fmtTime(r.dueAt)}` : null }))));
    }
    if (key === 'shopping') {
      const items = s.shopping.filter((i) => i.status === 'needed');
      if (items.length) cards.push(card('Shopping', '#organise?shopping', items.slice(0, 5).map((i) => row({ check: () => itemAction('shopping', i.id), title: i.quantity ? `${i.quantity} × ${i.name}` : i.name }))));
    }
    if (key === 'notes' && s.notes.length) {
      cards.push(card('Notes', '#organise?notes', s.notes.slice(-3).reverse().map((n) => row({ icon: 'note', title: n.text, onClick: () => noteSheet(n) }))));
    }
  }

  page('home',
    h('header', { class: 'home-head' },
      h('div', { class: 'brand' }, brandMark(26), h('span', {}, 'Brain Dump')),
      h('p', { class: 'eyebrow' }, new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }))),
    h('h1', { class: 'greeting' }, `${greeting()}${name ? `, ${name}` : ''}.`),
    h('section', { class: 'hero' },
      h('button', { class: 'hero-talk', onclick: () => { location.hash = '#talk'; setTimeout(() => talkTap(), 80); } },
        h('span', { class: 'hero-mark' }, brandMark(44, { onDark: true })),
        h('span', { class: 'hero-text' }, h('strong', {}, 'What’s on your mind?'), h('span', {}, voiceSupported ? 'Tap and say it any way you like' : 'Tell me anything'))),
      h('form', { class: 'hero-type', onsubmit: async (e) => {
        e.preventDefault();
        const t = typed.value;
        typed.value = '';
        location.hash = '#chat';
        await send(t);
      } }, typed, h('button', { class: 'icon-btn accent', type: 'submit', 'aria-label': 'Send' }, icon('send', 20)))),
    h('div', { class: 'quick' }, quick.map(([ic, label, fn]) => h('button', { class: 'quick-btn', onclick: fn }, h('span', { class: 'quick-ic' }, icon(ic, 22)), h('span', {}, label)))),
    ...cards,
  );
}

function card(title, href, content) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, title), href ? h('a', { href, class: 'see-all' }, 'See all') : null),
    h('div', { class: 'rows' }, content));
}

function row({ icon: ic, check, title, sub, onClick, trailing }) {
  const left = check
    ? h('button', { class: 'check', 'aria-label': `Done: ${title}`, onclick: (e) => { e.stopPropagation(); e.currentTarget.classList.add('done'); setTimeout(check, 250); } })
    : ic ? h('span', { class: 'row-ic' }, icon(ic, 19)) : null;
  return h(onClick ? 'button' : 'div', { class: 'row', onclick: onClick }, left, h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, title), sub ? h('span', { class: 'row-sub' }, sub) : null), trailing ?? (onClick ? icon('chevron', 18) : null));
}

function empty(text) {
  return h('p', { class: 'empty' }, text);
}

// ---------------------------------------------------------------------------
// Talk
// ---------------------------------------------------------------------------

function talkTap() {
  if (!voiceSupported) {
    ui.voiceNote = LOCAL ? 'Voice isn’t available in this test version — use Chat to type.' : 'Voice isn’t available in this browser — use Chat to type.';
    renderTalkState();
    return;
  }
  voice.tap();
}

function spokenRepliesOn() {
  return ui.state?.profile?.preferences?.voiceReplies !== false;
}

function voiceToggle() {
  const on = spokenRepliesOn();
  return h('button', { id: 'voice-toggle', class: `pill-btn talk-voice ${on ? 'on' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: async () => {
    const next = !spokenRepliesOn();
    ui.state.profile.preferences.voiceReplies = next;
    document.getElementById('voice-toggle')?.replaceWith(voiceToggle());
    if (!next) stopSpeakingNow();
    await api('/api/profile', { method: 'PATCH', body: { preferences: { voiceReplies: next } } }).catch(() => {});
  } }, icon(on ? 'speaker' : 'speakerOff', 17), on ? 'Replies out loud' : 'Replies on screen');
}

function stopSpeakingNow() {
  import('./speech.js').then((m) => m.stopSpeaking());
}

function renderTalk() {
  page('talk',
    h('div', { class: 'talk-top' }, voiceToggle()),
    h('div', { class: 'talk' },
      h('p', { class: 'eyebrow center' }, ui.state?.profile?.assistantName ?? 'Brain Dump'),
      h('p', { id: 'talk-prompt', class: 'talk-prompt' }),
      h('button', { id: 'orb', class: 'orb', onclick: talkTap, 'aria-label': 'Tap to talk' }, h('span', { class: 'orb-ring' }), brandMark(84, { onDark: true })),
      h('p', { id: 'talk-hint', class: 'talk-hint' }),
      h('p', { id: 'live', class: 'live', 'aria-live': 'polite' }, ui.liveText),
      h('div', { id: 'talk-reply', class: 'talk-reply', 'aria-live': 'polite' })));
  renderTalkState();
}

function renderTalkState() {
  const orb = document.getElementById('orb');
  if (!orb) return;
  const st = ui.voiceState;
  orb.className = `orb ${st}`;
  orb.setAttribute('aria-label', st === 'listening' ? 'Done talking' : 'Tap to talk');
  document.getElementById('talk-prompt').textContent =
    st === 'listening' ? 'I’m listening…' : st === 'thinking' ? 'Sorting that out…' : st === 'speaking' ? '' : 'What’s on your mind?';
  document.getElementById('talk-hint').textContent = ui.voiceNote ||
    (st === 'listening' ? 'Take your time. I’ll know when you’ve finished — or tap to send now.' : st === 'idle' ? (voiceSupported ? 'Tap and say it however it comes out.' : 'Use Chat to type.') : '');
  const box = document.getElementById('talk-reply');
  box.replaceChildren();
  const r = ui.lastReply;
  if (r && st !== 'listening') {
    const last = [...ui.convo].reverse().find((m) => m.role === 'user');
    if (last) box.append(h('p', { class: 'you-said' }, `“${last.text}”`));
    box.append(h('p', { class: 'reply-text' }, r.text));
    box.append(actionCards(r));
    if (r.question?.options?.length) box.append(h('div', { class: 'chips' }, r.question.options.map((o) => h('button', { class: 'chip', onclick: () => send(o.value) }, o.label))));
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async function renderChat() {
  if (!ui.convo.length && !LOCAL) {
    // Show where the last conversation left off.
    const hist = await api('/api/history').catch(() => null);
    const last = hist?.sessions?.[0];
    if (last && !ui.convo.length) {
      for (const t of last.turns.slice(-12)) ui.convo.push({ role: t.role, text: t.text, links: [], actions: [], at: Date.parse(t.at) });
    }
  }
  const input = h('textarea', { id: 'chat-input', rows: 1, placeholder: 'Message Brain Dump…', 'aria-label': 'Message', enterkeyhint: 'send',
    oninput: (e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } } });
  const submit = async () => {
    const t = input.value;
    input.value = '';
    input.style.height = 'auto';
    await send(t);
  };
  page('chat',
    h('header', { class: 'chat-head' }, h('div', { class: 'brand' }, brandMark(26), h('span', {}, ui.state?.profile?.assistantName ?? 'Brain Dump')),
      h('button', { class: 'pill-btn', onclick: () => { ui.convo = []; setSession(null); renderMessages(); } }, 'New chat')),
    h('div', { id: 'messages', class: 'messages', 'aria-live': 'polite' }),
    h('form', { class: 'composer', onsubmit: (e) => { e.preventDefault(); submit(); } },
      input,
      voiceSupported ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Talk instead', onclick: () => { location.hash = '#talk'; setTimeout(talkTap, 80); } }, icon('mic', 21)) : null,
      h('button', { type: 'submit', class: 'icon-btn accent', 'aria-label': 'Send' }, icon('send', 19))));
  renderMessages();
}

function renderMessages() {
  const box = document.getElementById('messages');
  if (!box) return;
  box.replaceChildren();
  if (!ui.convo.length) {
    box.append(h('div', { class: 'chat-empty' }, brandMark(56),
      h('p', {}, 'Say it the way it comes out. For example:'),
      h('div', { class: 'examples' }, [
        'I need milk, and remind me to call the dentist tomorrow',
        'Send a WhatsApp to Mum saying I’ll ring her Sunday',
        'Dinner with Sam on Friday at 7',
        'Set a timer for 15 minutes',
      ].map((ex) => h('button', { class: 'example', onclick: () => send(ex) }, ex)))));
  }
  ui.convo.forEach((m, i) => {
    const isLast = i === ui.convo.length - 1;
    const bubble = h('div', { class: `msg ${m.role}` }, h('div', { class: 'bubble' }, m.text));
    if (m.role === 'assistant') {
      bubble.append(actionCards(m));
      if (isLast && m.question?.options?.length) bubble.append(h('div', { class: 'chips' }, m.question.options.map((o) => h('button', { class: 'chip', onclick: () => send(o.value) }, o.label))));
      const undoable = (m.actions ?? []).filter((a) => a.undoable);
      if (isLast && undoable.length) bubble.append(h('button', { class: 'undo', onclick: () => send('undo') }, 'Undo'));
    }
    box.append(bubble);
  });
  if (ui.thinking) box.append(h('div', { class: 'msg assistant' }, h('div', { class: 'bubble typing' }, h('span'), h('span'), h('span'))));
  requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
}

/** Links from a reply become tappable action cards (WhatsApp, Call, Spotify…). */
function actionCards(r) {
  if (!r.links?.length) return null;
  return h('div', { class: 'actions' }, r.links.map((l) => h('a', { class: 'action', href: l.url, target: /^https?:/.test(l.url) ? '_blank' : undefined, rel: 'noopener' },
    h('span', { class: 'action-ic' }, icon(linkIcon(l.url), 19)), h('span', { class: 'action-label' }, l.label), icon('chevron', 16))));
}

// ---------------------------------------------------------------------------
// Organise
// ---------------------------------------------------------------------------

const ORG_TABS = [['calendar', 'Calendar'], ['reminders', 'Reminders'], ['notes', 'Notes'], ['shopping', 'Shopping'], ['waiting', 'Waiting']];

function orgTab() {
  const t = (location.hash.split('?')[1] ?? '').trim();
  return ORG_TABS.some(([id]) => id === t) ? t : 'calendar';
}

function renderOrganise() {
  const tab = orgTab();
  const s = ui.state;
  const now = Date.now();
  let body;
  if (tab === 'calendar') {
    const events = s.events.filter((e) => e.status === 'confirmed' && Date.parse(e.end) > now - 3600000);
    const byDay = new Map();
    for (const e of events) {
      const k = fmtDay(e.start);
      byDay.set(k, [...(byDay.get(k) ?? []), e]);
    }
    body = events.length
      ? [...byDay.entries()].map(([day, list]) => h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, day)),
        h('div', { class: 'rows' }, list.map((e) => row({ icon: e.meeting ? 'video' : 'calendar', title: e.title, sub: e.allDay ? 'All day' : `${fmtTime(e.start)} – ${fmtTime(e.end)}`, onClick: () => eventSheet(e) })))))
      : [h('section', { class: 'card' }, empty('Your calendar is clear. Tap + or just say “Yoga on Tuesday at 6”.'))];
  } else if (tab === 'reminders') {
    const rem = s.reminders.filter((r) => r.status === 'open').sort((a, b) => (a.dueAt ?? '9') < (b.dueAt ?? '9') ? -1 : 1);
    body = [h('section', { class: 'card' }, h('div', { class: 'rows' }, rem.length
      ? rem.map((r) => row({ check: () => itemAction('reminder', r.id), title: r.text, sub: r.dueAt ? `${fmtDay(r.dueAt)} · ${fmtTime(r.dueAt)}` : null, onClick: () => reminderSheet(r) }))
      : empty('Nothing to remember. Say “Remind me to pay rent on the 1st”.')))];
  } else if (tab === 'notes') {
    const notes = [...s.notes].reverse();
    body = [h('section', { class: 'card' }, h('div', { class: 'rows' }, notes.length
      ? notes.map((n) => row({ icon: n.kind === 'idea' ? 'sparkle' : 'note', title: n.text, sub: new Date(n.createdAt).toLocaleDateString(), onClick: () => noteSheet(n) }))
      : empty('No notes yet. Say “Make a note: the gate code is 4471”.')))];
  } else if (tab === 'shopping') {
    const items = s.shopping.filter((i) => i.status === 'needed');
    const got = s.shopping.filter((i) => i.status === 'got').slice(-5);
    body = [h('section', { class: 'card' }, h('div', { class: 'rows' }, items.length
      ? items.map((i) => row({ check: () => itemAction('shopping', i.id), title: i.quantity ? `${i.quantity} × ${i.name}` : i.name, trailing: h('button', { class: 'icon-btn subtle', 'aria-label': `Remove ${i.name}`, onclick: () => itemAction('shopping', i.id, 'remove') }, icon('trash', 17)) }))
      : empty('Your list is empty. Say “I need milk and eggs”.'))),
    got.length ? h('section', { class: 'card muted' }, h('div', { class: 'card-head' }, h('h2', {}, 'Recently got')), h('div', { class: 'rows' }, got.map((i) => row({ icon: 'check', title: i.name })))) : null];
  } else {
    const w = s.waiting.filter((x) => x.status === 'waiting');
    const drafts = s.drafts.filter((d) => d.status === 'draft');
    const contact = (id) => s.contacts.find((c) => c.id === id)?.name ?? 'someone';
    body = [
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Waiting on')), h('div', { class: 'rows' }, w.length
        ? w.map((x) => row({ check: () => itemAction('waiting', x.id), title: x.direction === 'them' ? `${x.who}` : `${x.who} is waiting on you`, sub: x.about || null }))
        : empty('Not waiting on anyone. Say “Rick hasn’t replied about the quote”.'))),
      drafts.length ? h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Ready to send')), h('div', { class: 'rows' }, drafts.map((d) => row({ icon: 'message', title: `To ${contact(d.to)}`, sub: d.body, onClick: () => draftSheet(d, contact(d.to)) })))) : null,
    ];
  }
  page('organise',
    header('Organise', null, tab === 'waiting' ? null : h('button', { class: 'icon-btn accent round', 'aria-label': 'Add', onclick: () => addSheet(tab === 'calendar' ? 'event' : tab === 'reminders' ? 'reminder' : tab === 'notes' ? 'note' : 'shopping') }, icon('plus', 22))),
    h('div', { class: 'segments', role: 'tablist' }, ORG_TABS.map(([id, label]) => h('a', { href: `#organise?${id}`, role: 'tab', class: `seg ${tab === id ? 'on' : ''}`, 'aria-selected': tab === id ? 'true' : 'false' }, label))),
    ...body);
}

// ---------------------------------------------------------------------------
// Sheets: quick add, item details
// ---------------------------------------------------------------------------

function field(label, input) {
  return h('label', { class: 'field' }, h('span', {}, label), input);
}

export function addSheet(kind) {
  const titles = { event: 'New event', reminder: 'New reminder', note: 'New note', shopping: 'Add to shopping' };
  const text = kind === 'note'
    ? h('textarea', { rows: 5, placeholder: 'Anything you want to keep…' })
    : h('input', { placeholder: kind === 'event' ? 'What is it?' : kind === 'reminder' ? 'Remind me to…' : 'Milk, eggs, bread', autocomplete: 'off' });
  const date = h('input', { type: 'date', value: kind === 'event' ? isoDate() : '' });
  const time = h('input', { type: 'time', value: kind === 'event' ? '' : '' });
  const msg = h('p', { class: 'form-msg', 'aria-live': 'polite' });
  const close = sheet(titles[kind],
    h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api(`/api/create/${kind}`, { body: { text: text.value, date: date.value || undefined, time: time.value || undefined } });
        close();
        toast(r.message);
        await refreshAll();
      } catch (err) {
        msg.textContent = err.message;
      }
    } },
    field(kind === 'event' ? 'Title' : kind === 'note' ? 'Note' : kind === 'shopping' ? 'Items' : 'Reminder', text),
    kind === 'event' || kind === 'reminder' ? h('div', { class: 'field-row' }, field('Date', date), field(kind === 'event' ? 'Time (optional)' : 'Time', time)) : null,
    msg,
    h('button', { class: 'btn primary', type: 'submit' }, kind === 'shopping' ? 'Add' : 'Save')));
}

function messageSheet() {
  const to = h('input', { placeholder: 'Mum, Sarah…', autocomplete: 'off' });
  const body = h('textarea', { rows: 3, placeholder: 'What do you want to say?' });
  let via = 'WhatsApp';
  const vias = ['WhatsApp', 'Text', 'Email'];
  const pick = h('div', { class: 'segments small' }, vias.map((v) => h('button', { type: 'button', class: `seg ${v === via ? 'on' : ''}`, onclick: (e) => { via = v; [...pick.children].forEach((c) => c.classList.toggle('on', c === e.currentTarget)); } }, v)));
  const close = sheet('New message',
    h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      if (!to.value.trim() || !body.value.trim()) return;
      close();
      location.hash = '#chat';
      const verb = via === 'WhatsApp' ? 'Send a WhatsApp' : via === 'Text' ? 'Send a text' : 'Send an email';
      await send(`${verb} to ${to.value.trim()} saying ${body.value.trim()}`);
    } }, field('To', to), pick, field('Message', body), h('button', { class: 'btn primary', type: 'submit' }, 'Write it')));
}

function timerSheet() {
  const close = sheet('Timer',
    h('div', { class: 'timer-grid' }, [5, 10, 15, 20, 30, 45, 60, 90].map((m) => h('button', { class: 'timer-btn', onclick: async () => {
      close();
      const r = await send(`Set a timer for ${m} minutes`);
      if (r) toast(r.text);
    } }, m < 60 ? `${m} min` : `${m / 60 === 1 ? '1 hour' : `${m / 60} hours`}`))),
    h('p', { class: 'form-msg' }, 'I’ll send a notification when it’s done — turn on reminders in Settings so it reaches you with the app closed.'));
}

async function eventSheet(e) {
  const link = LOCAL ? null : await api(`/api/events/${encodeURIComponent(e.id)}/ics-link`).catch(() => null);
  const close = sheet(e.title,
    h('p', { class: 'sheet-sub' }, `${fmtDay(e.start)}${e.allDay ? ' · All day' : ` · ${fmtTime(e.start)} – ${fmtTime(e.end)}`}`),
    e.location ? h('p', {}, e.location) : null,
    e.notes ? h('p', { class: 'muted-text' }, e.notes) : null,
    h('div', { class: 'sheet-actions' },
      e.meeting ? h('a', { class: 'btn primary', href: e.meeting.url, target: '_blank', rel: 'noopener' }, icon('video', 18), 'Join meeting') : null,
      link ? h('a', { class: 'btn', href: link.url }, icon('calendar', 18), 'Add to iPhone Calendar') : null,
      h('button', { class: 'btn danger-text', onclick: async () => { await itemAction('event', e.id, 'remove'); close(); toast(`Removed ${e.title}. Say “undo” in Chat to bring it back.`); } }, icon('trash', 18), 'Remove')));
}

function reminderSheet(r) {
  const close = sheet(r.text,
    r.dueAt ? h('p', { class: 'sheet-sub' }, `${fmtDay(r.dueAt)} · ${fmtTime(r.dueAt)}`) : null,
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn primary', onclick: async () => { await itemAction('reminder', r.id); close(); } }, icon('check', 18), 'Done'),
      h('button', { class: 'btn danger-text', onclick: async () => { await itemAction('reminder', r.id, 'remove'); close(); } }, icon('trash', 18), 'Delete')));
}

function noteSheet(n) {
  const text = h('textarea', { rows: 6, value: n.text });
  const close = sheet('Note',
    h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      await api(`/api/items/note/${n.id}`, { body: { action: 'edit', text: text.value } });
      close();
      await refreshAll();
    } }, text,
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
      h('button', { class: 'btn danger-text', type: 'button', onclick: async () => { await api(`/api/items/note/${n.id}`, { body: { action: 'remove' } }); close(); await refreshAll(); } }, icon('trash', 18), 'Delete'))));
}

function draftSheet(d, name) {
  const links = [];
  const text = encodeURIComponent(d.body);
  links.push({ label: `Send to ${name} on WhatsApp`, url: d.handoffUrl ?? `https://wa.me/?text=${text}` });
  const close = sheet(`To ${name}`,
    h('p', { class: 'bubble-preview' }, d.body),
    actionCards({ links }),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn', onclick: async () => { await itemAction('draft', d.id, 'sent'); close(); } }, icon('check', 18), 'I’ve sent it'),
      h('button', { class: 'btn danger-text', onclick: async () => { await itemAction('draft', d.id, 'discard'); close(); } }, icon('trash', 18), 'Discard')));
}

async function itemAction(kind, id, action = 'complete') {
  await api(`/api/items/${kind}/${id}`, { body: { action } });
  await refreshAll();
}

// ---------------------------------------------------------------------------
// Setup checklist (Home)
// ---------------------------------------------------------------------------

export async function refreshSetup() {
  if (LOCAL) return;
  [ui.setup] = await Promise.all([api('/api/setup').catch(() => null), refreshPhone(), loadVoiceInfo()]);
  if (route() === 'home') renderHome();
}

function setupCard() {
  if (LOCAL || !ui.setup) return null;
  let hidden = false;
  try { hidden = localStorage.getItem('bd.setupHidden') === 'yes'; } catch {}
  if (hidden) return null;
  const items = [];
  if (isIOS() && !isStandalone()) items.push({ title: 'Add to your Home Screen', sub: 'Share → Add to Home Screen, then open it from there.' });
  if (!ui.setup.push && (!isIOS() || isStandalone())) items.push({ title: 'Turn on reminders', sub: 'So they reach you with the app closed.', action: () => enablePush().then(refreshSetup) });
  if (!ui.phone?.enabled && isIOS()) items.push({ title: 'Connect your iPhone apps', sub: 'Real alarms, Reminders, Calendar and Notes — and “Hey Siri, Brain Dump”.', href: '#shortcut' });
  if (!ui.setup.backupCode) items.push({ title: 'Save a backup code', sub: 'Your way back in on a new phone.', href: '#backup' });
  if (!items.length) return null;
  return h('section', { class: 'card setup' },
    h('div', { class: 'card-head' }, h('h2', {}, 'Finish setting up'), h('button', { class: 'see-all', onclick: () => { try { localStorage.setItem('bd.setupHidden', 'yes'); } catch {} renderHome(); } }, 'Hide')),
    h('div', { class: 'rows' }, items.map((i) => i.href
      ? h('a', { class: 'row', href: i.href }, h('span', { class: 'row-ic' }, icon('sparkle', 19)), h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, i.title), h('span', { class: 'row-sub' }, i.sub)), icon('chevron', 18))
      : row({ icon: 'sparkle', title: i.title, sub: i.sub, onClick: i.action }))));
}

// ---------------------------------------------------------------------------
// Data & boot
// ---------------------------------------------------------------------------

export async function loadState() {
  ui.state = await api('/api/state');
  ui.version = ui.state.version;
}

async function refreshOverview() {
  try {
    ui.overview = await api('/api/overview');
    await loadState();
    if (route() === 'home') renderHome();
    if (route() === 'organise') renderOrganise();
  } catch {
    /* offline */
  }
}

export async function refreshAll() {
  await loadState().catch(() => {});
  await refreshOverview();
}

export async function renderRoute() {
  const r = route();
  document.querySelectorAll('.sheet-wrap').forEach((s) => s.remove());
  if (!ui.state) await loadState();
  if (r !== 'talk' && voice.active) voice.stop();
  if (r === 'talk') return renderTalk();
  if (r === 'chat') return renderChat();
  if (r === 'organise') return renderOrganise();
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
        addAssistant(r);
        if (r.question && r.sessionId) setSession(r.sessionId);
        toast(r.text);
      }
      refreshAll();
    },
  }));
  toast(n.text, actions, actions.length ? 20000 : 8000);
}

let closeStream = () => {};

export async function boot() {
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
  const replies = await flushQueue();
  if (replies.length) toast(`Sorted ${replies.length} thing${replies.length > 1 ? 's' : ''} you captured offline.`);
  closeStream();
  closeStream = openStream(async (type, data) => {
    if (type === 'sync' && data.version !== ui.version) await refreshAll();
    if (type === 'notification') onNotification(data);
  });
  app.removeAttribute('aria-busy');
  await renderRoute();
  refreshOverview();
  refreshSetup();
  if (params.has('talk')) {
    location.hash = '#talk';
    setTimeout(talkTap, 300);
  }
}

window.addEventListener('hashchange', renderRoute);
window.addEventListener('online', async () => {
  ui.online = true;
  const replies = await flushQueue();
  if (replies.length) toast(`Back online — sorted ${replies.length} thing${replies.length > 1 ? 's' : ''} you captured.`);
  refreshAll();
});
window.addEventListener('offline', () => {
  ui.online = false;
  toast('You’re offline. I’ll keep what you tell me and sort it when you’re back.');
});

if (!LOCAL && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

boot().catch((err) => {
  app.replaceChildren(h('p', { class: 'boot' }, `Couldn't start: ${err.message}`));
});

export { queued };
