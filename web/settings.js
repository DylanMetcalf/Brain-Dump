// Settings, connections, setup screens (backup code, one-tap talking), history and sign-up.

import { api, auth, LOCAL } from './api.js';
import { h, icon, brandMark, toast, sheet, copyButton } from './ui.js';
import { ui, app, page, loadState, refreshAll, homeSections, setHomeSections, boot, refreshSetup } from './app.js';

const SCOPES = {
  calendar: 'Calendar', reminders: 'Reminders', shopping: 'Shopping list', notes: 'Notes', memory: 'Memory', contacts: 'People',
  messaging: 'Messages', email: 'Email', meetings: 'Meetings', bookings: 'Bookings', purchases: 'Purchases', music: 'Music', fitness: 'Fitness',
};
const LEVELS = { none: 'Off', read: 'Read only', draft: 'Prepare / draft', act: 'Handle for me' };

export function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function group(title, ...rows) {
  return h('section', { class: 'group' }, title ? h('h2', { class: 'group-title' }, title) : null, h('div', { class: 'group-body' }, ...rows));
}

function setRow(label, control, sub) {
  return h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('span', {}, label), sub ? h('span', { class: 'row-sub' }, sub) : null), control ?? null);
}

function linkRow(ic, label, sub, onClick, trailing) {
  return h('button', { class: 'set-row link-row', onclick: onClick }, h('span', { class: 'row-ic' }, icon(ic, 19)), h('div', { class: 'set-label' }, h('span', {}, label), sub ? h('span', { class: 'row-sub' }, sub) : null), trailing ?? icon('chevron', 18));
}

function toggle(on, onChange, label) {
  const b = h('button', { class: `switch ${on ? 'on' : ''}`, role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label, onclick: () => {
    const next = !b.classList.contains('on');
    b.classList.toggle('on', next);
    b.setAttribute('aria-checked', next ? 'true' : 'false');
    onChange(next);
  } }, h('span'));
  return b;
}

function select(value, options, onchange, label) {
  return h('select', { class: 'select', 'aria-label': label, onchange: (e) => onchange(e.target.value) }, Object.entries(options).map(([v, l]) => h('option', { value: v, selected: v === value ? true : undefined }, l)));
}

async function patchProfile(body) {
  await api('/api/profile', { method: 'PATCH', body });
  await loadState();
}

export async function renderSettings() {
  const s = ui.state;
  const p = s.profile;
  const [devices, integrations, ai] = await Promise.all([
    LOCAL ? { devices: [] } : api('/api/devices').catch(() => ({ devices: [] })),
    api('/api/integrations').catch(() => null),
    api('/api/ai').catch(() => null),
  ]);
  const google = s.integrations.google;
  const sections = homeSections();
  const SECTION_LABELS = { next: 'Up next', needs: 'Needs you', reminders: 'Reminders', shopping: 'Shopping', notes: 'Notes' };

  page('settings',
    h('header', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Settings'))),

    group('You and your assistant',
      setRow('Assistant’s name', h('input', { class: 'inline-input', value: p.assistantName ?? '', 'aria-label': 'Assistant name', onchange: (e) => patchProfile({ assistantName: e.target.value }) })),
      setRow('Your name', h('input', { class: 'inline-input', value: p.displayName ?? '', placeholder: 'Optional', 'aria-label': 'Your name', onchange: (e) => patchProfile({ displayName: e.target.value }) })),
      setRow('Speak replies out loud', toggle(p.preferences.voiceReplies, (v) => patchProfile({ preferences: { voiceReplies: v } }), 'Speak replies')),
      setRow('Helpful suggestions', toggle(p.preferences.proactivity === 'normal', (v) => patchProfile({ preferences: { proactivity: v ? 'normal' : 'quiet' } }), 'Suggestions'), 'Only when genuinely useful'),
      setRow('Sunday check-in', toggle(p.preferences.weeklyBriefing.enabled, (v) => patchProfile({ preferences: { weeklyBriefing: { ...p.preferences.weeklyBriefing, enabled: v } } }), 'Sunday check-in')),
      setRow('Remind me before events', select(String(p.preferences.defaultEventLeadMin), { 0: 'At the time', 10: '10 min', 15: '15 min', 30: '30 min', 60: '1 hour' }, (v) => patchProfile({ preferences: { defaultEventLeadMin: Number(v) } }), 'Lead time'))),

    group('Home screen',
      h('p', { class: 'group-note' }, 'Choose what you want to see on Home.'),
      ...Object.entries(SECTION_LABELS).map(([k, label]) => setRow(label, toggle(sections.includes(k), (v) => {
        const cur = homeSections().filter((x) => x !== k);
        setHomeSections(v ? [...cur, k] : cur);
      }, label)))),

    claudeGroup(ai),

    group('Connections',
      h('p', { class: 'group-note' }, 'How Brain Dump works with the apps on your phone.'),
      connRow('calendar', 'Google Calendar', google?.scopes?.includes('calendar') ? 'Connected — events go straight into Google Calendar' : integrations?.available?.google ? 'Tap to connect' : 'Needs a one-time Google setup on the server (see the setup guide)', integrations?.available?.google ? () => connectGoogle(['calendar']) : null),
      connRow('calendar', 'iPhone Calendar', 'Show everything from Brain Dump in the Calendar app', () => calendarSubscribe()),
      connRow('mail', 'Gmail', google?.scopes?.includes('gmail') ? 'Connected — ask “check my emails”' : integrations?.available?.google ? 'Tap to connect' : 'Needs a one-time Google setup on the server', integrations?.available?.google ? () => connectGoogle(['gmail']) : null),
      connRow('message', 'WhatsApp & Messages', 'Ready — say “Send a WhatsApp to Mum saying…” and tap to send', null),
      connRow('phone', 'Phone & FaceTime', 'Ready — say “Call Mum”', null),
      connRow('music', 'Music', 'Ready — say “Play some jazz” (Spotify or Apple Music)', null),
      connRow('timer', 'Timers & alarms', LOCAL ? 'Ready — notifications while the app is open' : 'Ready — arrive as notifications (turn on below)', null),
      connRow('video', 'Zoom', p.preferences.personalMeetingLink ? 'Using your personal meeting link' : 'Say “My Zoom link is …” once, and I’ll add it to meetings', null),
      LOCAL ? null : connRow('bell', 'Notifications on this phone', 'Reminders, timers and replies reach you with the app closed', () => enablePush())),

    LOCAL ? null : group('One-tap talking',
      linkRow('mic', 'Talk without opening the app', 'Widget, Action Button, Back Tap or “Hey Siri”', () => (location.hash = '#shortcut'))),

    group('What I can do',
      h('p', { class: 'group-note' }, 'I only act within what you allow. Anything involving money, or that can’t be undone, always comes back to you.'),
      ...s.permissions.map((perm) => setRow(SCOPES[perm.scope] ?? perm.scope, select(perm.level, LEVELS, async (v) => { await api(`/api/permissions/${perm.scope}`, { method: 'PUT', body: { level: v } }); await loadState(); }, SCOPES[perm.scope])))),

    group('What I remember',
      ...(s.memories.length
        ? s.memories.map((m) => setRow(`${m.subject}: ${m.value}`, h('button', { class: 'pill-btn', onclick: async () => { await api(`/api/memories/${m.id}`, { method: 'DELETE' }); await loadState(); renderSettings(); } }, 'Forget'), `${m.provenance} · ${new Date(m.learnedAt).toLocaleDateString()}`))
        : [h('p', { class: 'group-note' }, 'Nothing yet. I’ll always show you what I pick up.')]),
      ...s.contacts.filter((c) => c.phone || c.email).map((c) => setRow(c.name, null, [c.phone, c.email].filter(Boolean).join(' · ')))),

    s.routines.length ? group('Routines', ...s.routines.map((r) => setRow(r.title,
      select(r.status, { confirmed: 'Remind me', automated: 'Handle it', paused: 'Paused' }, async (v) => { await api(`/api/routines/${r.id}`, { method: 'PATCH', body: { status: v } }); await loadState(); }, r.title),
      `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.weekday]} ${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`))) : null,

    LOCAL ? group('Test version',
      h('p', { class: 'group-note' }, 'This test version keeps everything in this browser on this phone only.'),
      resetButton()) : group('Account & devices',
      linkRow('sparkle', 'Backup code', 'Your way back in on a new phone', () => (location.hash = '#backup')),
      linkRow('users', 'Add another device', 'iPad, laptop…', () => pairSheet()),
      ...devices.devices.map((d) => setRow(`${d.name}${d.current ? ' (this one)' : ''}`, d.current ? null : h('button', { class: 'pill-btn', onclick: async () => { await api(`/api/devices/${d.id}`, { method: 'DELETE' }); renderSettings(); } }, 'Remove'), `Last used ${new Date(d.lastSeenAt).toLocaleDateString()}`)),
      linkRow('note', 'History', 'Everything I’ve done, with undo', () => (location.hash = '#history')),
      linkRow('link', 'Export my data', null, exportData),
      h('button', { class: 'set-row danger-text', onclick: deleteAccount }, 'Delete account')),
  );
}

function connRow(ic, label, sub, onClick) {
  return onClick ? linkRow(ic, label, sub, onClick) : h('div', { class: 'set-row' }, h('span', { class: 'row-ic' }, icon(ic, 19)), h('div', { class: 'set-label' }, h('span', {}, label), h('span', { class: 'row-sub' }, sub)));
}

function claudeGroup(ai) {
  if (LOCAL) {
    const on = ai?.enabled !== false;
    return group('Claude',
      h('p', { class: 'group-note' }, ai?.state === 'unavailable'
        ? 'Claude isn’t available here. Open this page in the Claude app or claude.ai to use it.'
        : 'Claude helps me understand anything you say, however it comes out. It uses your own Claude account, so there’s no key to set up.'),
      setRow('Understand with Claude', toggle(on, async (v) => api('/api/ai', { method: v ? 'PUT' : 'DELETE', body: {} }), 'Claude')));
  }
  const msg = h('p', { class: 'group-note', 'aria-live': 'polite' });
  const input = h('input', { type: 'password', class: 'inline-input wide', placeholder: 'sk-ant-…', autocomplete: 'off', 'aria-label': 'Anthropic API key' });
  return group('Claude',
    h('p', { class: 'group-note' }, ai?.connected
      ? `Connected${ai.hint ? ` with your key ${ai.hint}` : ai.source === 'server' ? ' with the key set on Render — nothing to paste here' : ''}. Claude reads what you say however it comes out and turns it into actions, which still go through the same safety checks.`
      : 'Add an Anthropic API key (or set ANTHROPIC_API_KEY on Render) so I understand anything you say, however it comes out.'),
    ai?.source === 'server' ? null : h('form', { class: 'set-row', onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = 'Checking the key…';
      try {
        await api('/api/ai', { method: 'PUT', body: { apiKey: input.value } });
        renderSettings();
      } catch (err) {
        msg.textContent = err.message;
      }
    } }, input, h('button', { class: 'pill-btn', type: 'submit' }, 'Save')),
    h('div', { class: 'set-row' }, h('button', { class: 'pill-btn', onclick: async () => {
      msg.textContent = 'Asking Claude…';
      const r = await api('/api/ai/test', { body: {} }).catch((e) => ({ message: e.message }));
      msg.textContent = r.message;
    } }, 'Test Claude'), ai?.hint ? h('button', { class: 'pill-btn', onclick: async () => { await api('/api/ai', { method: 'DELETE' }); renderSettings(); } }, 'Remove key') : null),
    msg);
}

async function calendarSubscribe() {
  if (LOCAL) {
    toast('This works in the full version of Brain Dump.');
    return;
  }
  const r = await api('/api/calendar/feed', { body: {} });
  sheet('Show in iPhone Calendar',
    h('p', {}, 'Tap below and choose Subscribe. Everything Brain Dump adds to your calendar then appears in the iPhone Calendar app and stays up to date.'),
    h('div', { class: 'sheet-actions' },
      h('a', { class: 'btn primary', href: r.webcal }, icon('calendar', 18), 'Subscribe in Calendar'),
      copyButton(r.url, 'Copy link instead')),
    h('p', { class: 'form-msg' }, 'If you use Google Calendar on your iPhone, connect Google Calendar instead and events appear natively.'));
}

function pairSheet() {
  const out = h('div', {}, h('p', {}, 'On the other device, open Brain Dump and tap “I already use Brain Dump”.'));
  sheet('Add another device', out, h('button', { class: 'btn primary', onclick: async (e) => {
    const r = await api('/api/auth/pair/start', { body: {} });
    e.currentTarget.remove();
    out.append(h('div', { class: 'code' }, r.code), h('p', { class: 'form-msg' }, 'Enter this code there. It works once, for 10 minutes.'));
  } }, 'Show a code'));
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function enablePush() {
  if (isIOS() && !isStandalone()) {
    toast('First add Brain Dump to your Home Screen (Share → Add to Home Screen), open it from there, then turn this on.', [], 12000);
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('This browser can’t receive notifications.');
    return;
  }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast('Notifications are off. You can allow them in your phone’s Settings → Notifications → Brain Dump.');
      return;
    }
    const { publicKey } = await api('/api/push/key');
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
    await api('/api/push/subscribe', { body: { subscription: sub.toJSON() } });
    await api('/api/push/test', { body: {} });
    toast('Notifications are on — you should see a test one now.');
    refreshSetup();
  } catch (err) {
    toast(`Couldn’t turn on notifications: ${err.message}`);
  }
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

function deleteAccount() {
  const close = sheet('Delete account',
    h('p', {}, 'This permanently deletes your Brain Dump and everything in it, on every device. It can’t be undone.'),
    h('div', { class: 'sheet-actions' },
      h('button', { class: 'btn danger', onclick: async () => {
        await api('/api/account', { method: 'DELETE', body: { confirm: 'delete everything' } });
        auth.token = null;
        try { localStorage.clear(); } catch {}
        close();
        location.hash = '';
        location.reload();
      } }, 'Delete everything'),
      h('button', { class: 'btn', onclick: () => close() }, 'Keep my account')));
}

function resetButton() {
  const btn = h('button', { class: 'set-row danger-text', onclick: async () => {
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

// ---------------------------------------------------------------------------
// Setup screens
// ---------------------------------------------------------------------------

function subPage(title, ...body) {
  page('sub', h('a', { class: 'back', href: '#settings' }, icon('back', 18), 'Settings'), h('h1', { class: 'sub-title' }, title), ...body);
  window.scrollTo(0, 0);
}

export function renderBackupScreen() {
  const out = h('section', { class: 'card' },
    h('p', {}, 'Brain Dump has no password. If you lose this phone, get a new one, or clear Safari’s data, this code gets you back in with everything still there.'),
    h('p', { class: 'muted-text' }, 'Save it in Notes or a password manager. Anyone with the code can open your Brain Dump, so keep it private.'),
    h('button', { class: 'btn primary', onclick: async () => {
      const r = await api('/api/auth/recovery', { body: {} });
      out.replaceChildren(
        h('p', {}, 'Your backup code:'),
        h('div', { class: 'code' }, r.code),
        h('div', { class: 'sheet-actions' }, copyButton(r.code, 'Copy code')),
        h('p', { class: 'muted-text' }, 'It won’t be shown again. To use it: open Brain Dump on the new phone, tap “I already use Brain Dump”, and type the code.'),
        h('a', { class: 'btn primary', href: '#home', onclick: () => refreshSetup() }, 'I’ve saved it'));
    } }, 'Show my backup code'));
  subPage('Backup code', out);
}

export function renderShortcutScreen() {
  const status = h('div');
  const make = h('button', { class: 'btn primary', onclick: async () => {
    make.disabled = true;
    try {
      const r = await api('/api/auth/shortcut', { body: {} });
      const test = h('p', { class: 'muted-text', 'aria-live': 'polite' });
      status.replaceChildren(
        h('p', {}, 'Your personal link. Copy it now — you’ll paste it in step 3.'),
        h('div', { class: 'linkbox' }, r.link),
        h('div', { class: 'sheet-actions' }, copyButton(r.link, 'Copy link'),
          h('button', { class: 'pill-btn', onclick: async () => {
            test.textContent = 'Testing…';
            try {
              const res = await fetch(r.link + encodeURIComponent('What still needs me?'));
              test.textContent = res.ok ? `It works: “${await res.text()}”` : `The link didn’t work (${res.status}).`;
            } catch {
              test.textContent = 'Couldn’t reach Brain Dump.';
            }
          } }, 'Test it')),
        test);
      make.remove();
    } catch (err) {
      status.replaceChildren(h('p', { class: 'danger-text' }, err.message));
      make.disabled = false;
    }
  } }, 'Create my link');
  const step = (title, detail) => h('li', {}, h('strong', {}, title), h('span', {}, detail));
  subPage('Talk with one tap',
    h('section', { class: 'card' },
      h('p', {}, 'Optional. iPhone only lets apps from the App Store sit behind the Action Button or a widget, so this uses Apple’s Shortcuts app as the bridge: it listens, sends what you said to Brain Dump, and reads the answer out. Everything else works without it.'),
      status, make),
    h('section', { class: 'card' }, h('h2', {}, 'Make the Shortcut (2 minutes)'),
      h('ol', { class: 'steps' },
        step('Open Shortcuts and tap +', 'The + is top right.'),
        step('Add “Dictate Text”', 'Tap the search bar, type Dictate.'),
        step('Add “Get Contents of URL” and paste your link', 'Tap the blue “URL” to paste.'),
        step('Add “Dictated Text” at the end of the link', 'Cursor at the very end, then tap Dictated Text above the keyboard.'),
        step('Add “Speak Text”', 'It reads Brain Dump’s answer.'),
        step('Name it “Brain Dump”', 'Tap the name at the top, then Done.'))),
    h('section', { class: 'card' }, h('h2', {}, 'Put it one tap away'),
      h('ul', { class: 'steps plain' },
        h('li', {}, h('strong', {}, 'Widget: '), 'hold the Home Screen → Edit → Add Widget → Shortcuts.'),
        h('li', {}, h('strong', {}, 'Control Centre / Lock Screen (iOS 18): '), 'Control Centre → + → Add a Control → Shortcut.'),
        h('li', {}, h('strong', {}, 'Back Tap: '), 'Settings → Accessibility → Touch → Back Tap → Double Tap.'),
        h('li', {}, h('strong', {}, 'Action Button: '), 'Settings → Action Button → Shortcut.'),
        h('li', {}, h('strong', {}, 'Siri: '), 'say “Hey Siri, Brain Dump”.'))));
}

export async function renderHistory() {
  const hist = await api('/api/history');
  page('sub', h('a', { class: 'back', href: '#settings' }, icon('back', 18), 'Settings'), h('h1', { class: 'sub-title' }, 'History'),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'What I did')),
      h('div', { class: 'rows' }, hist.ledger.length ? hist.ledger.slice(0, 60).map((l) => h('div', { class: 'row' },
        h('span', { class: 'row-main' }, h('span', { class: 'row-title' }, l.summary), h('span', { class: 'row-sub' }, `${new Date(l.at).toLocaleString()} · ${l.auto ? 'handled for you' : 'you approved'}`)),
        l.undoneAt ? h('span', { class: 'tag' }, 'undone') : l.undoable ? h('button', { class: 'pill-btn', onclick: async () => { const r = await api(`/api/undo/${l.id}`, { body: {} }); toast(r.message); refreshAll(); renderHistory(); } }, 'Undo') : null))
        : h('p', { class: 'empty' }, 'Nothing yet.'))));
}

// ---------------------------------------------------------------------------
// Sign up / sign in
// ---------------------------------------------------------------------------

function deviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Browser';
}

export async function renderWelcome() {
  const config = await api('/api/auth/config').catch(() => ({}));
  const msg = h('p', { class: 'form-msg', 'aria-live': 'polite' });
  const invite = h('input', { id: 'invite', class: 'big-input', autocomplete: 'off', placeholder: 'Invite code', 'aria-label': 'Invite code' });
  const code = h('input', { id: 'pair', class: 'big-input', autocomplete: 'off', placeholder: '6-digit code or backup code', 'aria-label': 'Pairing code or backup code' });
  const pairForm = h('form', { class: 'form', hidden: true, onsubmit: async (e) => {
    e.preventDefault();
    const v = code.value.trim();
    try {
      const r = await api(/^\d{6}$/.test(v.replace(/\s/g, '')) ? '/api/auth/pair/complete' : '/api/auth/recover', { body: { code: v, deviceName: deviceLabel() } });
      auth.token = r.token;
      boot();
    } catch (err) {
      msg.textContent = err.message;
    }
  } }, h('p', { class: 'muted-text' }, 'Enter the 6-digit code from Settings on your other device, or your backup code.'), code, h('button', { class: 'btn primary', type: 'submit' }, 'Connect'));
  app.className = 'app welcome';
  app.replaceChildren(h('div', { class: 'welcome-inner' },
    h('div', { class: 'welcome-mark' }, brandMark(72, { onDark: true })),
    h('h1', {}, 'Get it out of your head.'),
    h('p', { class: 'muted-text' }, 'Say what’s on your mind, any way it comes out. Brain Dump sorts it, remembers it, and gets it done.'),
    h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/auth/register', { body: { deviceName: deviceLabel(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, inviteCode: invite.value } });
        auth.token = r.token;
        boot();
      } catch (err) {
        msg.textContent = err.message;
      }
    } }, config.inviteRequired ? invite : null, h('button', { class: 'btn primary', type: 'submit' }, 'Get started')),
    h('button', { class: 'btn text', onclick: () => { pairForm.hidden = false; code.focus(); } }, 'I already use Brain Dump'),
    pairForm, msg));
}
