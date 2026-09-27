// Copying into the iPhone's own apps. A web app can't touch Clock, Reminders, Calendar or
// Notes, but a Shortcut can. The Brain Dump Shortcut asks the server for anything new and
// creates it natively: a real alarm, a real reminder, an event in her default calendar
// (Google Calendar, if that's the default), a note in Notes, shopping in Reminders.

import type { ISODate, PhoneSync, UserState } from './types.js';
import { tzOffsetMs, zonedParts } from './time.js';

/** reminder = has a time (alert); todo = no time. Separate so the Shortcut needs no nested Ifs. */
export type PhoneActionType = 'alarm' | 'timer' | 'reminder' | 'todo' | 'event' | 'note' | 'shopping';

/** Flat, Shortcut-friendly: every value is a string so "Get Dictionary Value" is simple. */
export interface PhoneAction {
  id: string;
  type: PhoneActionType;
  title: string;
  /** Local time with offset, e.g. 2026-10-02T19:00:00+01:00 (events, reminders, alarms). */
  start?: string;
  end?: string;
  /** 24-hour local time, e.g. 06:30 (alarms). */
  time?: string;
  /** Whole minutes (timers). */
  minutes?: string;
  notes?: string;
  location?: string;
  /** Reminders list for shopping. */
  list?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO 8601 in the user's zone with its offset: what Shortcuts reads most reliably. */
export function localISO(iso: ISODate, tz: string): string {
  const d = new Date(iso);
  const p = zonedParts(d, tz);
  const off = Math.round(tzOffsetMs(d, tz) / 60000);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function phoneSyncOf(state: UserState): PhoneSync | undefined {
  return state.phoneSync?.enabled ? state.phoneSync : undefined;
}

export function enablePhoneSync(state: UserState, now: Date, on: boolean): PhoneSync {
  const prev = state.phoneSync;
  state.phoneSync = on
    ? { enabled: true, since: prev?.enabled ? prev.since : now.toISOString(), sent: prev?.sent ?? [], shoppingList: prev?.shoppingList, lastRunAt: prev?.lastRunAt }
    : { ...(prev ?? { since: now.toISOString(), sent: [] }), enabled: false };
  return state.phoneSync;
}

/** What hasn't been copied to the phone yet. */
export function phoneOutbox(state: UserState, now: Date): PhoneAction[] {
  const sync = phoneSyncOf(state);
  if (!sync) return [];
  const tz = state.profile.timeZone;
  const since = sync.since;
  const sent = new Set(sync.sent);
  const fresh = (id: string, created: string) => !sent.has(id) && created >= since;
  const out: PhoneAction[] = [];

  for (const r of state.reminders) {
    if (r.status !== 'open' || !fresh(r.id, r.createdAt)) continue;
    if (r.kind === 'timer') {
      if (!r.dueAt) continue;
      const mins = Math.round((Date.parse(r.dueAt) - now.getTime()) / 60000);
      if (mins < 1) continue; // already over by the time the phone saw it
      out.push({ id: r.id, type: 'timer', title: r.text.replace(/^Time's up\s*/i, '').replace(/[()]/g, '').trim() || 'Timer', minutes: String(mins) });
    } else if (r.kind === 'alarm') {
      if (!r.dueAt || Date.parse(r.dueAt) <= now.getTime()) continue;
      const p = zonedParts(new Date(r.dueAt), tz);
      out.push({ id: r.id, type: 'alarm', title: r.text || 'Alarm', time: `${pad(p.hour)}:${pad(p.minute)}`, start: localISO(r.dueAt, tz) });
    } else {
      if (r.dueAt && Date.parse(r.dueAt) <= now.getTime() - 60_000) continue;
      out.push(r.dueAt ? { id: r.id, type: 'reminder', title: r.text, start: localISO(r.dueAt, tz) } : { id: r.id, type: 'todo', title: r.text });
    }
  }
  for (const e of state.events) {
    // Events already in Google Calendar reach the phone through her Google account.
    if (e.status !== 'confirmed' || e.source === 'google' || e.externalId || !fresh(e.id, e.createdAt)) continue;
    if (Date.parse(e.end) <= now.getTime()) continue;
    out.push({
      id: e.id,
      type: 'event',
      title: e.title,
      start: localISO(e.start, tz),
      end: localISO(e.end, tz),
      ...(e.location ? { location: e.location } : {}),
      ...(e.meeting?.url || e.notes ? { notes: [e.meeting?.url, e.notes].filter(Boolean).join('\n') } : {}),
    });
  }
  for (const n of state.notes) {
    if (!fresh(n.id, n.createdAt)) continue;
    out.push({ id: n.id, type: 'note', title: n.text });
  }
  for (const s of state.shopping) {
    if (s.status !== 'needed' || !fresh(s.id, s.addedAt)) continue;
    out.push({ id: s.id, type: 'shopping', title: s.quantity && s.quantity > 1 ? `${s.name} ×${s.quantity}` : s.name, list: sync.shoppingList ?? 'Shopping' });
  }
  return out;
}

/** The Shortcut picked these up: don't hand them over again. */
export function markSentToPhone(state: UserState, ids: string[], now: Date) {
  const sync = phoneSyncOf(state);
  if (!sync || !ids.length) return;
  sync.sent = [...sync.sent, ...ids].slice(-2000);
  sync.lastRunAt = now.toISOString();
}

/** Short summary for the app ("2 reminders and an alarm"). */
export function describeOutbox(items: PhoneAction[]): string {
  const names: Record<PhoneActionType, [string, string]> = {
    alarm: ['an alarm', 'alarms'], timer: ['a timer', 'timers'], reminder: ['a reminder', 'reminders'],
    todo: ['a to-do', 'to-dos'], event: ['an event', 'events'], note: ['a note', 'notes'], shopping: ['a shopping item', 'shopping items'],
  };
  const counts = new Map<PhoneActionType, number>();
  for (const i of items) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
  const parts = [...counts].map(([t, n]) => (n === 1 ? names[t][0] : `${n} ${names[t][1]}`));
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
