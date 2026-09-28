// The device agent protocol: getting things into, and keeping them in step with, the
// phone's own apps.
//
// Brain Dump's intelligence runs here; the phone only carries out plain operations.
// Two kinds of device agent pick these up:
//   • The Brain Dump iPhone app (native): EventKit for Calendar and Reminders, AlarmKit for
//     real alarms and timers. It creates, updates, cancels and completes, verifies each
//     result by reading it back, and reports it (applyPhoneResults). It also shares the
//     phone's calendar (applyDeviceCalendar) so "I can't make yoga" finds her real event.
//   • The optional Brain Dump Shortcut (legacy, for the web app without the native app):
//     creates only, so it never sees update/cancel/complete operations.

import type { CalendarEvent, ISODate, PhoneSync, UserState } from './types.js';
import { tzOffsetMs, zonedParts } from './time.js';

/** reminder = has a time (alert); todo = no time. Separate so the Shortcut needs no nested Ifs. */
export type PhoneCreateType = 'alarm' | 'timer' | 'reminder' | 'todo' | 'event' | 'note' | 'shopping';
/** Only the native app does these. */
export type PhoneChangeType = 'event_update' | 'event_cancel' | 'reminder_complete';
export type PhoneActionType = PhoneCreateType | PhoneChangeType;

/** Flat, Shortcut-friendly: every value is a string so "Get Dictionary Value" is simple. */
export interface PhoneAction {
  /** Brain Dump's id for the item. */
  id: string;
  /** Unique per operation; what the device reports back. */
  key: string;
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
  /** The phone's own identifier, for updates, cancels and completions. */
  nativeId?: string;
  allDay?: string;
}

export interface PhoneResult {
  key: string;
  ok: boolean;
  /** The phone's identifier for what it created (EventKit / AlarmKit). */
  nativeId?: string;
  /** Why it failed, in plain words ("Calendar access is off"). */
  error?: string;
  /** Which permission was missing, so health can say exactly what to do. */
  needs?: 'calendar' | 'reminders' | 'alarms' | 'notifications';
}

export interface DeviceCalendarEvent {
  nativeId: string;
  title: string;
  start: ISODate;
  end: ISODate;
  allDay?: boolean;
  location?: string;
  notes?: string;
  calendar?: string;
}

const CHANGE_TYPES: PhoneActionType[] = ['event_update', 'event_cancel', 'reminder_complete'];
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
    ? { ...(prev ?? { sent: [] }), enabled: true, since: prev?.enabled ? prev.since : now.toISOString(), sent: prev?.sent ?? [] }
    : { ...(prev ?? { since: now.toISOString(), sent: [] }), enabled: false };
  return state.phoneSync;
}

function eventPayload(e: CalendarEvent, tz: string) {
  return {
    title: e.title,
    start: localISO(e.start, tz),
    end: localISO(e.end, tz),
    ...(e.allDay ? { allDay: 'yes' } : {}),
    ...(e.location ? { location: e.location } : {}),
    ...(e.meeting?.url || e.notes ? { notes: [e.meeting?.url, e.notes].filter(Boolean).join('\n') } : {}),
  };
}

/**
 * What the phone still needs to do. `native` = the Brain Dump app (all operations);
 * otherwise the Shortcut (creations only).
 */
export function phoneOutbox(state: UserState, now: Date, opts: { native?: boolean } = {}): PhoneAction[] {
  const sync = phoneSyncOf(state);
  if (!sync) return [];
  const tz = state.profile.timeZone;
  const since = sync.since;
  const sent = new Set(sync.sent);
  const fresh = (id: string, created: string) => !sent.has(id) && created >= since;
  const out: PhoneAction[] = [];

  for (const r of state.reminders) {
    if (r.status === 'done' && r.externalId && r.kind !== 'timer' && !sent.has(`done:${r.id}`)) {
      out.push({ id: r.id, key: `done:${r.id}`, type: 'reminder_complete', title: r.text, nativeId: r.externalId });
      continue;
    }
    if (r.status !== 'open' || !fresh(r.id, r.createdAt)) continue;
    if (r.kind === 'timer') {
      if (!r.dueAt) continue;
      const mins = Math.round((Date.parse(r.dueAt) - now.getTime()) / 60000);
      if (mins < 1) continue; // already over by the time the phone saw it
      out.push({ id: r.id, key: r.id, type: 'timer', title: r.text.replace(/^Time's up\s*/i, '').replace(/[()]/g, '').trim() || 'Timer', minutes: String(mins) });
    } else if (r.kind === 'alarm') {
      if (!r.dueAt || Date.parse(r.dueAt) <= now.getTime()) continue;
      const p = zonedParts(new Date(r.dueAt), tz);
      out.push({ id: r.id, key: r.id, type: 'alarm', title: r.text || 'Alarm', time: `${pad(p.hour)}:${pad(p.minute)}`, start: localISO(r.dueAt, tz) });
    } else {
      if (r.dueAt && Date.parse(r.dueAt) <= now.getTime() - 60_000) continue;
      out.push(r.dueAt ? { id: r.id, key: r.id, type: 'reminder', title: r.text, start: localISO(r.dueAt, tz) } : { id: r.id, key: r.id, type: 'todo', title: r.text });
    }
  }

  for (const e of state.events) {
    // Google events reach the phone through her Google account; Google is the source of truth.
    if (e.source === 'google') continue;
    const onPhone = !!e.externalId && (e.source === 'device' || sent.has(e.id));
    if (onPhone) {
      if (e.status === 'cancelled') {
        const key = `cancel:${e.id}`;
        if (!sent.has(key)) out.push({ id: e.id, key, type: 'event_cancel', title: e.title, nativeId: e.externalId });
      } else if (e.updatedAt > e.createdAt && Date.parse(e.end) > now.getTime()) {
        const key = `update:${e.id}:${e.updatedAt}`;
        if (!sent.has(key)) out.push({ id: e.id, key, type: 'event_update', nativeId: e.externalId, ...eventPayload(e, tz) });
      }
      continue;
    }
    if (e.source !== 'local' || e.status !== 'confirmed' || !fresh(e.id, e.createdAt)) continue;
    if (Date.parse(e.end) <= now.getTime()) continue;
    out.push({ id: e.id, key: e.id, type: 'event', ...eventPayload(e, tz) });
  }

  for (const n of state.notes) {
    if (!fresh(n.id, n.createdAt)) continue;
    out.push({ id: n.id, key: n.id, type: 'note', title: n.text });
  }
  for (const s of state.shopping) {
    if (s.status !== 'needed' || !fresh(s.id, s.addedAt)) continue;
    out.push({ id: s.id, key: s.id, type: 'shopping', title: s.quantity && s.quantity > 1 ? `${s.name} ×${s.quantity}` : s.name, list: sync.shoppingList ?? 'Shopping' });
  }
  return opts.native ? out : out.filter((a) => !CHANGE_TYPES.includes(a.type));
}

/** Handed to the phone: don't hand them over again. */
export function markSentToPhone(state: UserState, keys: string[], now: Date) {
  const sync = phoneSyncOf(state);
  if (!sync || !keys.length) return;
  sync.sent = [...sync.sent, ...keys].slice(-3000);
  sync.lastRunAt = now.toISOString();
}

/**
 * The native app reports what really happened. Successes remember the phone's id (so later
 * changes reach the same item); failures go back in the queue and are recorded for health.
 */
export function applyPhoneResults(state: UserState, results: PhoneResult[], now: Date): { ok: number; failed: number } {
  const sync = phoneSyncOf(state);
  if (!sync) return { ok: 0, failed: 0 };
  let ok = 0;
  let failed = 0;
  const failures = sync.failures ?? [];
  for (const r of results) {
    if (!r || typeof r.key !== 'string') continue;
    if (r.ok) {
      ok++;
      const id = r.key;
      if (r.nativeId && !id.includes(':')) {
        const item = state.events.find((e) => e.id === id) ?? state.reminders.find((x) => x.id === id);
        if (item) item.externalId = r.nativeId;
      }
      if (!sync.sent.includes(r.key)) sync.sent.push(r.key);
      sync.lastOkAt = now.toISOString();
    } else {
      failed++;
      sync.sent = sync.sent.filter((k) => k !== r.key); // retry next time
      failures.push({ key: r.key, at: now.toISOString(), error: String(r.error ?? 'failed').slice(0, 200), ...(r.needs ? { needs: r.needs } : {}) });
    }
  }
  sync.failures = failures.slice(-20);
  sync.sent = sync.sent.slice(-3000);
  sync.lastRunAt = now.toISOString();
  return { ok, failed };
}

/**
 * The phone's calendar, as the native app sees it (a window of days). Keeps Brain Dump's
 * copy in step so it can find, move and cancel her real events. Events Brain Dump itself
 * put on the phone are recognised and not duplicated.
 */
export function applyDeviceCalendar(state: UserState, events: DeviceCalendarEvent[], window: { from: ISODate; to: ISODate }, now: Date, ids: (p: string) => string): { added: number; updated: number; removed: number } {
  const sync = state.phoneSync;
  const nowIso = now.toISOString();
  const byNative = new Map(state.events.filter((e) => e.externalId && e.source !== 'google').map((e) => [e.externalId!, e]));
  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const d of events) {
    if (!d?.nativeId || !d.start || !d.end) continue;
    seen.add(d.nativeId);
    const existing = byNative.get(d.nativeId);
    if (existing) {
      if (existing.source !== 'device') continue; // one of ours; Brain Dump's copy wins
      const changed = existing.title !== d.title || existing.start !== d.start || existing.end !== d.end || existing.status !== 'confirmed';
      if (changed) {
        Object.assign(existing, { title: d.title, start: d.start, end: d.end, allDay: !!d.allDay, location: d.location, status: 'confirmed' as const, updatedAt: nowIso });
        sync?.sent.push(`update:${existing.id}:${nowIso}`); // this change came from the phone
        updated++;
      }
      continue;
    }
    state.events.push({
      id: ids('evt'), title: d.title || '(no title)', start: d.start, end: d.end, timeZone: state.profile.timeZone, allDay: !!d.allDay,
      location: d.location, notes: d.notes, attendees: [], status: 'confirmed', source: 'device', externalId: d.nativeId, createdAt: nowIso, updatedAt: nowIso,
    });
    added++;
  }
  // Deleted on the phone: gone here too (without sending a cancel back).
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  for (const e of state.events) {
    if (e.source !== 'device' || e.status !== 'confirmed' || !e.externalId || seen.has(e.externalId)) continue;
    if (Date.parse(e.start) < from || Date.parse(e.start) > to) continue;
    e.status = 'cancelled';
    e.updatedAt = nowIso;
    sync?.sent.push(`cancel:${e.id}`);
    removed++;
  }
  if (sync) sync.calendarSyncedAt = nowIso;
  return { added, updated, removed };
}

/** Short summary for the app ("2 reminders and an alarm"). */
export function describeOutbox(items: PhoneAction[]): string {
  const names: Record<PhoneActionType, [string, string]> = {
    alarm: ['an alarm', 'alarms'], timer: ['a timer', 'timers'], reminder: ['a reminder', 'reminders'],
    todo: ['a to-do', 'to-dos'], event: ['an event', 'events'], note: ['a note', 'notes'], shopping: ['a shopping item', 'shopping items'],
    event_update: ['a calendar change', 'calendar changes'], event_cancel: ['a cancellation', 'cancellations'], reminder_complete: ['a finished reminder', 'finished reminders'],
  };
  const counts = new Map<PhoneActionType, number>();
  for (const i of items) counts.set(i.type, (counts.get(i.type) ?? 0) + 1);
  const parts = [...counts].map(([t, n]) => (n === 1 ? names[t][0] : `${n} ${names[t][1]}`));
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
