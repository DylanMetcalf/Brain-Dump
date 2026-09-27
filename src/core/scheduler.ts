// Background intelligence, run periodically (every minute on the server).
// Everything here is idempotent: running tick() twice never duplicates a notification,
// an event or a shopping item.

import type { Assistant } from './assistant.js';
import { analyseBehaviour, pickProactive } from './behaviour.js';
import { addDays, dateKey, formatClock, localDateKey, weekdayOf, zonedParts, zonedToUtc } from './time.js';
import { listJoin, sameItem } from './text.js';
import type { AppNotification, UserState } from './types.js';

export interface TickResult {
  notifications: AppNotification[];
  changed: boolean;
}

function notify(state: UserState, a: Assistant, n: Omit<AppNotification, 'id' | 'read'>, out: AppNotification[]): boolean {
  if (state.notifications.some((x) => x.key === n.key)) return false;
  const full: AppNotification = { ...n, id: a.ids('ntf'), read: false };
  state.notifications.push(full);
  if (state.notifications.length > 300) state.notifications.splice(0, state.notifications.length - 300);
  out.push(full);
  return true;
}

function isoWeekKey(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  return `${date.getUTCFullYear()}-${Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / (7 * 86400000))}`;
}

export async function tick(a: Assistant, now: Date): Promise<TickResult> {
  const state = a.state;
  const tz = state.profile.timeZone;
  const out: AppNotification[] = [];
  const versionBefore = state.version;
  let changed = a.expireIdleSessions(now) > 0;
  if (state.profile.onboarding !== 'done') return { notifications: out, changed };

  // 1. Due reminders.
  for (const r of state.reminders) {
    if (r.status !== 'open' || !r.dueAt || r.notifiedAt || Date.parse(r.dueAt) > now.getTime()) continue;
    r.notifiedAt = now.toISOString();
    changed = true;
    notify(state, a, {
      at: now.toISOString(), kind: 'reminder', key: `rem:${r.id}:${r.dueAt}`, text: r.text,
      actions: [
        { label: 'Done', value: 'done' },
        { label: 'In an hour', value: 'snooze' },
      ],
      data: { reminderId: r.id },
    }, out);
  }

  // 2. Upcoming events.
  const upcoming = await a.providers.calendar.list(now, new Date(now.getTime() + 3 * 3600000)).catch(() => []);
  for (const e of upcoming) {
    if (e.allDay || e.remindedAt) continue;
    const routine = e.routineId ? state.routines.find((r) => r.id === e.routineId) : undefined;
    const lead = e.leadMin ?? routine?.setup?.leadMin ?? state.profile.preferences.defaultEventLeadMin;
    const start = Date.parse(e.start);
    if (start - lead * 60000 > now.getTime() || start < now.getTime()) continue;
    const local = state.events.find((x) => x.id === e.id);
    if (local) local.remindedAt = now.toISOString();
    changed = true;
    const mins = Math.max(1, Math.round((start - now.getTime()) / 60000));
    notify(state, a, {
      at: now.toISOString(), kind: 'event', key: `evt:${e.id}:${e.start}`,
      text: `${e.title} in ${mins} minute${mins === 1 ? '' : 's'}${e.location ? ` — ${e.location}` : ''}${e.meeting ? '. Link ready.' : '.'}`,
      actions: e.meeting ? [{ label: 'Join', value: e.meeting.url }] : undefined,
      data: { eventId: e.id },
    }, out);
  }

  // 3. Routines: automated ones are handled; confirmed ones are prepared (offered the day before).
  const today = zonedParts(now, tz);
  for (const r of state.routines) {
    if (r.status === 'paused') continue;
    if (r.kind === 'shopping') {
      // Staples: added on the routine's weekday, once per date, never duplicating.
      const key = localDateKey(now, tz);
      if (r.status === 'automated' && today.weekday === r.weekday && today.hour >= r.hour && !r.handled.includes(key)) {
        r.handled.push(key);
        const needed = state.shopping.filter((s) => s.status === 'needed');
        const items = (r.items ?? []).filter((i) => !needed.some((n) => sameItem(n.name, i)));
        if (items.length) {
          await a.exec.execute({ type: 'shopping.add', items: items.map((name) => ({ name })) }, { auto: true, risk: 'low' });
        }
        changed = true;
      }
      continue;
    }
    for (let i = 0; i < 8; i++) {
      const d = addDays(today, i);
      if (weekdayOf(d) !== r.weekday) continue;
      const key = dateKey(d);
      if (r.handled.includes(key)) continue;
      const start = zonedToUtc({ ...d, hour: r.hour, minute: r.minute }, tz);
      if (start.getTime() < now.getTime()) continue;
      if (r.status === 'automated') {
        await a.materialiseRoutineAt(r.id, key, now);
        changed = true;
      } else if (i === 1 && today.hour >= 17) {
        // Day before, evening: offer to add it — once.
        const exists = state.events.some((e) => e.status === 'confirmed' && localDateKey(new Date(e.start), tz) === key && e.title.toLowerCase().includes(r.title.toLowerCase().split(' ')[0]));
        if (!exists && state.profile.preferences.proactivity !== 'quiet') {
          changed = notify(state, a, {
            at: now.toISOString(), kind: 'suggestion', key: `routine:${r.id}:${key}`,
            text: `Your usual ${r.title.toLowerCase()} is tomorrow at ${formatClock(start, tz)}. Want me to add it to your calendar?`,
            actions: [
              { label: 'Add it', value: 'add' },
              { label: 'Skip', value: 'dismiss' },
            ],
            data: { routineId: r.id, date: key },
          }, out) || changed;
        }
      }
    }
  }

  // 4. Combined shopping list (friction engine: one list instead of many pings).
  const digest = state.profile.preferences.shoppingDigest;
  if (digest && today.hour >= digest.hour) {
    const key = `digest:${localDateKey(now, tz)}`;
    const addedToday = state.observations.some((o) => o.kind === 'item_added' && localDateKey(new Date(o.at), tz) === localDateKey(now, tz));
    const needed = state.shopping.filter((s) => s.status === 'needed');
    if (addedToday && needed.length) {
      changed = notify(state, a, { at: now.toISOString(), kind: 'reminder', key, text: `Your shopping list: ${listJoin(needed.map((n) => n.name))}.` }, out) || changed;
    }
  }

  // 5. Watching for replies the user asked about.
  if (a.providers.email) {
    for (const w of state.waiting) {
      if (w.status !== 'waiting' || w.direction !== 'them' || !w.notifyOnReply) continue;
      const contact = w.personId ? state.contacts.find((c) => c.id === w.personId) : undefined;
      const msgs = await a.providers.email.search({ from: contact?.email ?? w.who, since: new Date(w.since) }).catch(() => []);
      if (!msgs.length) continue;
      const m = msgs[msgs.length - 1];
      await a.exec.execute({ type: 'waiting.resolve', id: w.id }, { auto: true, risk: 'low' });
      notify(state, a, { at: now.toISOString(), kind: 'waiting', key: `reply:${w.id}`, text: `${w.who} replied: “${m.subject}”.`, data: { emailId: m.id } }, out);
      changed = true;
    }
  }

  // 6. Weekly briefing.
  const wb = state.profile.preferences.weeklyBriefing;
  if (wb.enabled && today.weekday === wb.weekday && today.hour >= wb.hour) {
    changed = notify(state, a, {
      at: now.toISOString(), kind: 'briefing', key: `weekly:${isoWeekKey(now, tz)}`,
      text: "Here's what's happening this week — got a minute?",
      actions: [
        { label: 'Start', value: 'briefing' },
        { label: 'Later', value: 'dismiss' },
      ],
    }, out) || changed;
  }

  // 7. Behaviour analysis once a day; at most one proactive suggestion, only if it clears the bar.
  const analysisKey = `analysis:${localDateKey(now, tz)}`;
  if (!state.notifications.some((n) => n.key === analysisKey) && today.hour >= 9) {
    analyseBehaviour(state, a.ids, now);
    const s = pickProactive(state, now);
    state.notifications.push({ id: a.ids('ntf'), at: now.toISOString(), kind: 'system', key: analysisKey, text: '', read: true });
    if (s) {
      s.status = 'offered';
      s.offeredAt = now.toISOString();
      notify(state, a, {
        at: now.toISOString(), kind: 'suggestion', key: `sug:${s.id}`, text: s.text,
        actions: [
          { label: 'Yes', value: 'yes' },
          { label: 'No thanks', value: 'dismiss' },
        ],
        data: { suggestionId: s.id },
      }, out);
    }
    changed = true;
  }

  if (changed && state.version === versionBefore) state.version += 1;
  return { notifications: out, changed };
}
