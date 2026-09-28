// Brain Dump Integration & Setup Orchestrator.
//
// One catalogue of everything Brain Dump can work with. For a given device it decides:
//   • DISCOVER  — is this available here at all? (unsupported things are simply not shown)
//   • CONNECT   — which route: the Brain Dump iPhone app (EventKit, AlarmKit, App Intents),
//                 a Google account, or the web app on its own
//   • HEALTH    — working, needs the person (and exactly what to tap), or broken (and why)
//
// It is pure: the server feeds it facts (device capabilities reported by each device,
// account connections, live check results) and it returns plain-language status. The
// setup screens and Integration Health read from here, so they never disagree.
//
// ACCOUNT CONNECTION (e.g. Google, stored once, works everywhere) is kept separate from
// DEVICE PERMISSION (e.g. Calendar access on this iPhone — each device grants its own).

import type { DeviceCaps, PermissionState, UserState } from './types.js';

export type IntegrationId =
  | 'voice' | 'notifications' | 'calendar' | 'reminders' | 'alarms' | 'contacts' | 'notes'
  | 'mail' | 'messages' | 'music' | 'meetings' | 'siri' | 'brain' | 'natural-voice';

export type Health = 'ok' | 'needs-you' | 'broken' | 'off' | 'unavailable';

export interface Fix {
  /** permission = ask the platform (in-app prompt); settings = only the Settings app can turn it back on;
   *  reconnect = sign in again; install = get the Brain Dump app / add to Home Screen; open = a Brain Dump screen. */
  kind: 'permission' | 'settings' | 'reconnect' | 'install' | 'open' | 'retry';
  /** What to ask for / where to go (e.g. "calendar", "#shortcut", "google:calendar"). */
  target: string;
  label: string;
}

export interface IntegrationStatus {
  id: IntegrationId;
  label: string;
  /** Short line for the setup list and Health ("Your iPhone calendar", "Through Google"). */
  via: string;
  health: Health;
  /** Plain words. Never just "failed". */
  message: string;
  fix?: Fix;
  /** Offered in first-run selection (brain and natural-voice are automatic, shown in Health only). */
  selectable: boolean;
  /** Pre-ticked in first-run selection. */
  suggested: boolean;
  /** Advanced detail (technical), shown only in Advanced. */
  detail?: string;
}

export interface OrchestratorFacts {
  /** This device (the one asking). */
  device?: DeviceCaps;
  /** Other devices on the account, for "works on your iPhone, not here" notes. */
  otherDevices: DeviceCaps[];
  server: {
    googleConfigured: boolean;
    pushConfigured: boolean;
    claude: { configured: boolean; ok?: boolean; error?: string };
    naturalVoice: { configured: boolean; ok?: boolean; error?: string };
  };
  account: {
    google?: { scopes: string[]; ok?: boolean; error?: string };
    /** Push subscription stored for this device. */
    pushForDevice: boolean;
    lastPushResult?: 'ok' | 'gone' | 'error';
  };
  state: UserState;
  now: Date;
}

const LABELS: Record<IntegrationId, string> = {
  voice: 'Voice', notifications: 'Notifications', calendar: 'Calendar', reminders: 'Reminders', alarms: 'Alarms & timers',
  contacts: 'Contacts', notes: 'Notes', mail: 'Mail', messages: 'Messages & WhatsApp', music: 'Music', meetings: 'Zoom & Meet',
  siri: 'Siri & Shortcuts', brain: 'Understanding (Claude)', 'natural-voice': 'Natural voice',
};

const has = (d: DeviceCaps | undefined, f: string) => !!d?.features.includes(f);
const perm = (d: DeviceCaps | undefined, p: keyof DeviceCaps['permissions']): PermissionState | undefined => d?.permissions[p];

/** A permission-driven status: granted → ok; prompt → ask; denied → Settings app. */
function byPermission(p: PermissionState | undefined, what: string, why: string, target: string): Pick<IntegrationStatus, 'health' | 'message' | 'fix'> {
  if (p === 'granted' || p === 'limited') return { health: 'ok', message: 'Connected.' };
  if (p === 'denied') {
    return {
      health: 'needs-you',
      message: `${what} access is off. Turn it on in Settings and I’ll finish the setup.`,
      fix: { kind: 'settings', target, label: 'Open Settings' },
    };
  }
  return { health: 'needs-you', message: `${what} needs your permission ${why}`, fix: { kind: 'permission', target, label: `Allow ${what}` } };
}

export function integrationStatus(f: OrchestratorFacts): IntegrationStatus[] {
  const d = f.device;
  const native = d?.shell === 'ios';
  const iphoneWeb = !native && (d?.platform === 'ios' || d?.platform === 'ipados');
  const sync = f.state.phoneSync;
  const out: IntegrationStatus[] = [];
  const add = (id: IntegrationId, s: Omit<IntegrationStatus, 'id' | 'label'>) => out.push({ id, label: LABELS[id], ...s });
  const google = f.account.google;
  const googleCal = !!google?.scopes.includes('calendar');
  const phoneFailure = (needs: string) => sync?.failures?.slice().reverse().find((x) => x.needs === needs && (!sync.lastOkAt || x.at > sync.lastOkAt));

  // ---- Voice (talking to Brain Dump) ----
  if (has(d, 'voice-input')) {
    const p = native ? (perm(d, 'speech') === 'denied' ? 'denied' : perm(d, 'microphone')) : perm(d, 'microphone');
    add('voice', { via: native ? 'iPhone speech recognition' : 'This browser', selectable: true, suggested: true,
      ...(p === 'granted' ? { health: 'ok', message: 'Ready — tap Talk and speak.' } : byPermission(p, 'Microphone', 'so you can talk to me.', 'microphone')) });
  } else if (d) {
    add('voice', { via: 'Not in this browser', health: 'unavailable', message: 'Voice isn’t available in this browser. Type instead, or use Safari on iPhone.', selectable: false, suggested: false });
  }

  // ---- Notifications ----
  if (has(d, 'push') || native) {
    const p = perm(d, 'notifications');
    let s: Pick<IntegrationStatus, 'health' | 'message' | 'fix'> = byPermission(p, 'Notifications', 'so reminders reach you when the app is closed.', 'notifications');
    if (s.health === 'ok' && !native && f.server.pushConfigured && !f.account.pushForDevice) {
      s = { health: 'needs-you', message: 'Notifications are allowed but not linked to this phone yet.', fix: { kind: 'retry', target: 'notifications', label: 'Link this phone' } };
    }
    if (s.health === 'ok' && f.account.lastPushResult === 'gone') {
      s = { health: 'needs-you', message: 'This phone stopped accepting notifications. Tap to reconnect them.', fix: { kind: 'retry', target: 'notifications', label: 'Reconnect' } };
    }
    add('notifications', { via: native ? 'iPhone notifications' : 'Web notifications', selectable: true, suggested: true, ...s });
  } else if (iphoneWeb && !d?.standalone) {
    add('notifications', { via: 'Needs the Home Screen app', health: 'needs-you', message: 'On iPhone, notifications work once Brain Dump is on your Home Screen.', fix: { kind: 'install', target: 'home-screen', label: 'Add to Home Screen' }, selectable: true, suggested: true });
  }

  // ---- Calendar ----
  if (native) {
    const failed = phoneFailure('calendar');
    const s = failed ? byPermission('denied', 'Calendar', '', 'calendar') : byPermission(perm(d, 'calendar'), 'Calendar', 'so I can find and manage your appointments.', 'calendar');
    add('calendar', { via: googleCal ? 'Your iPhone calendar and Google' : 'Your iPhone calendar (includes Google if it’s on your phone)', selectable: true, suggested: true, ...s,
      ...(s.health === 'ok' && sync?.calendarSyncedAt ? { message: 'Connected — I can see and manage your events.' } : {}),
      detail: `EventKit ${perm(d, 'calendar') ?? 'unknown'}; last shared ${sync?.calendarSyncedAt ?? 'never'}` });
  } else if (googleCal) {
    const ok = google?.ok !== false;
    add('calendar', { via: 'Google Calendar', selectable: true, suggested: true, health: ok ? 'ok' : 'needs-you',
      message: ok ? 'Connected to Google Calendar.' : 'Google needs you to sign in again.', ...(ok ? {} : { fix: { kind: 'reconnect', target: 'google:calendar', label: 'Reconnect Google' } }), detail: google?.error });
  } else {
    add('calendar', { via: f.server.googleConfigured ? 'Brain Dump calendar — or connect Google' : 'Brain Dump calendar', selectable: true, suggested: true,
      health: 'ok', message: 'Ready. Events live in Brain Dump; you can show them in your phone’s calendar too.',
      ...(f.server.googleConfigured ? { fix: { kind: 'reconnect', target: 'google:calendar', label: 'Connect Google Calendar' } } : {}) });
  }

  // ---- Reminders ----
  if (native) {
    const failed = phoneFailure('reminders');
    add('reminders', { via: 'iPhone Reminders', selectable: true, suggested: true,
      ...(failed ? byPermission('denied', 'Reminders', '', 'reminders') : byPermission(perm(d, 'reminders'), 'Reminders', 'so your reminders show up in the Reminders app.', 'reminders')) });
  } else {
    add('reminders', { via: sync?.enabled ? 'Brain Dump, copied to Reminders by the Shortcut' : 'Brain Dump reminders, sent as notifications', selectable: true, suggested: true, health: 'ok', message: 'Ready.' });
  }

  // ---- Alarms & timers ----
  if (native && has(d, 'alarmkit')) {
    const failed = phoneFailure('alarms');
    add('alarms', { via: 'Real iPhone alarms', selectable: true, suggested: true,
      ...(failed ? byPermission('denied', 'Alarms', '', 'alarms') : byPermission(perm(d, 'alarms'), 'Alarms', 'so I can set real alarms and timers.', 'alarms')) });
  } else if (native) {
    add('alarms', { via: 'Loud notifications', selectable: true, suggested: true, health: 'ok', message: 'Ready. Real Clock alarms need iOS 26 or later.' });
  } else {
    add('alarms', { via: sync?.enabled ? 'Clock, through the Shortcut' : 'Notifications', selectable: true, suggested: false, health: 'ok', message: 'Ready.' });
  }

  // ---- Contacts (device only, never uploaded wholesale) ----
  if (native) {
    add('contacts', { via: 'iPhone Contacts (looked up on your phone)', selectable: true, suggested: true,
      ...byPermission(perm(d, 'contacts'), 'Contacts', 'so “text Mum” finds her number.', 'contacts') });
  }

  // ---- Notes ----
  add('notes', { via: native ? 'Brain Dump notes — share to Apple Notes any time' : sync?.enabled ? 'Brain Dump, copied to Notes by the Shortcut' : 'Brain Dump notes',
    selectable: true, suggested: true, health: 'ok', message: 'Ready.', detail: 'Apple offers apps no way to write into Notes directly.' });

  // ---- Mail ----
  if (f.server.googleConfigured) {
    const connected = !!google?.scopes.includes('gmail');
    const ok = connected && google?.ok !== false;
    add('mail', { via: 'Gmail', selectable: true, suggested: false,
      health: ok ? 'ok' : 'needs-you',
      message: ok ? 'Connected — ask “check my emails”.' : connected ? 'Google needs you to sign in again.' : 'Sign in with Google so I can check and tidy your email.',
      fix: ok ? undefined : { kind: 'reconnect', target: 'google:gmail', label: connected ? 'Reconnect Google' : 'Sign in with Google' }, detail: google?.error });
  }

  // ---- Hand-offs (always there; one tap to send/play) ----
  add('messages', { via: 'WhatsApp, Messages, Mail — you tap send', selectable: true, suggested: true, health: 'ok', message: 'Ready.' });
  add('music', { via: 'Spotify or Apple Music', selectable: true, suggested: true, health: 'ok', message: 'Ready.' });
  add('meetings', { via: 'Your Zoom, Meet or Teams link', selectable: true, suggested: false, health: 'ok',
    message: f.state.profile.preferences.personalMeetingLink ? 'Ready — using your meeting link.' : 'Ready. Say “My Zoom link is …” once and I’ll add it to meetings.' });

  // ---- Siri & Shortcuts ----
  if (native) {
    add('siri', { via: 'Built in — no Shortcut to build', selectable: true, suggested: true,
      health: has(d, 'app-intents') ? 'ok' : 'broken',
      message: has(d, 'app-intents') ? 'Ready — say “Hey Siri, Brain Dump”.' : 'Siri actions didn’t register. Reopen Brain Dump and I’ll try again.',
      ...(has(d, 'app-intents') ? {} : { fix: { kind: 'retry', target: 'siri', label: 'Try again' } }) });
  } else if (iphoneWeb) {
    const working = !!sync?.enabled && !!sync.lastRunAt;
    add('siri', { via: 'Best with the Brain Dump iPhone app', selectable: true, suggested: false,
      health: working ? 'ok' : 'needs-you',
      message: working ? 'Working through your Brain Dump Shortcut.' : 'For “Hey Siri” and your iPhone’s own apps, install the Brain Dump iPhone app (or use the optional Shortcut).',
      ...(working ? {} : { fix: { kind: 'install', target: 'ios-app', label: 'How to get it' } }) });
  }

  // ---- Automatic (Health only) ----
  const c = f.server.claude;
  add('brain', { via: 'Claude', selectable: false, suggested: false,
    health: !c.configured ? 'off' : c.ok === false ? 'broken' : 'ok',
    message: !c.configured ? 'Not set up — I still understand everyday phrasing.' : c.ok === false ? `Claude isn’t answering: ${c.error ?? 'unknown reason'}. I’ll keep working with my own understanding and retry.` : 'Connected.',
    ...(c.ok === false ? { fix: { kind: 'open', target: '#settings', label: 'Check the key' } } : {}) });
  const v = f.server.naturalVoice;
  add('natural-voice', { via: 'ChatGPT voice', selectable: false, suggested: false,
    health: !v.configured ? 'off' : v.ok === false ? 'broken' : 'ok',
    message: !v.configured ? 'Using your phone’s voice.' : v.ok === false ? `The natural voice isn’t answering (${v.error ?? 'unknown'}), so I’m using your phone’s voice for now.` : 'Connected.' });

  return out;
}

/** The first-run choices: only what this device actually supports. */
export function setupChoices(statuses: IntegrationStatus[]) {
  return statuses.filter((s) => s.selectable && s.health !== 'unavailable').map((s) => ({ id: s.id, label: s.label, via: s.via, suggested: s.suggested }));
}

/** Anything the person should know about, most important first (for Home and the repair card). */
export function problems(statuses: IntegrationStatus[], selected?: string[]): IntegrationStatus[] {
  const rank: Record<Health, number> = { broken: 0, 'needs-you': 1, off: 3, ok: 4, unavailable: 5 };
  return statuses
    .filter((s) => (s.health === 'broken' || s.health === 'needs-you') && (!selected || !s.selectable || selected.includes(s.id)))
    .sort((a, b) => rank[a.health] - rank[b.health]);
}

/**
 * Integrations that became available since setup (a new capability or a new server
 * connection), not yet offered. Mentioned once, gently.
 */
export function newlyAvailable(statuses: IntegrationStatus[], state: UserState): IntegrationStatus[] {
  const setup = state.setup;
  if (!setup?.completedAt) return [];
  const known = new Set([...(setup.selected ?? []), ...(setup.offered ?? [])]);
  return statuses.filter((s) => s.selectable && s.health !== 'unavailable' && !known.has(s.id));
}
