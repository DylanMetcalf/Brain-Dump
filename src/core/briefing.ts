// Status views: "What still needs me?", "What did you handle?", schedule and weekly briefing.
// Only genuine blockers are surfaced; only verified ledger entries are reported as handled.

import { capitalize, listJoin } from './text.js';
import { addDays, formatClock, formatDay, formatWhen, localDateKey, startOfLocalDay, zonedParts, zonedToUtc } from './time.js';
import type { CalendarEvent, LedgerEntry, UserState } from './types.js';

export interface NeedItem {
  kind: 'question' | 'waiting_me' | 'waiting_them' | 'reminder' | 'draft' | 'booking';
  text: string;
  id: string;
}

function personName(state: UserState, id?: string): string | undefined {
  return id ? state.contacts.find((c) => c.id === id)?.name : undefined;
}

export function needsMe(state: UserState, now: Date): NeedItem[] {
  const tz = state.profile.timeZone;
  const items: NeedItem[] = [];
  // Unanswered, non-optional questions from recent sessions.
  const recent = state.sessions.filter((s) => Date.parse(s.lastActivityAt) > now.getTime() - 7 * 86400000);
  for (const s of recent) {
    for (const q of s.pending) {
      if (q.optional || !q.asked) continue;
      items.push({ kind: 'question', text: q.data.needText ?? q.text, id: q.id });
    }
  }
  for (const w of state.waiting.filter((x) => x.status === 'waiting' && x.direction === 'me')) {
    items.push({ kind: 'waiting_me', text: `${w.who} is waiting for ${w.about ? w.about.replace(/^(?:my|an?|the) /, 'your ') : 'your answer'}.`, id: w.id });
  }
  for (const d of state.drafts.filter((x) => x.status === 'draft' && Date.parse(x.createdAt) > now.getTime() - 14 * 86400000)) {
    const who = personName(state, d.to) ?? 'someone';
    items.push({ kind: 'draft', text: `Your ${d.channel === 'email' ? 'email' : 'message'} to ${who} is ready to send.`, id: d.id });
  }
  const endOfToday = zonedToUtc({ ...addDays(zonedParts(now, tz), 1), hour: 0, minute: 0 }, tz).getTime();
  for (const r of state.reminders.filter((x) => x.status === 'open')) {
    if (r.kind === 'booking') {
      items.push({ kind: 'booking', text: `You need to ${r.text.charAt(0).toLowerCase()}${r.text.slice(1)}.`, id: r.id });
      continue;
    }
    // A follow-up with a draft already prepared is represented by the draft.
    if (state.drafts.some((d) => d.reminderId === r.id && d.status === 'draft')) continue;
    if (r.dueAt && Date.parse(r.dueAt) < endOfToday) {
      const overdue = Date.parse(r.dueAt) < now.getTime() - 3600000;
      items.push({ kind: 'reminder', text: `${capitalize(r.text)}${overdue ? ' (overdue)' : ' (today)'}.`, id: r.id });
    } else if (!r.dueAt && r.kind !== 'task') {
      items.push({ kind: 'reminder', text: `${capitalize(r.text)}.`, id: r.id });
    }
  }
  for (const w of state.waiting.filter((x) => x.status === 'waiting' && x.direction === 'them')) {
    const about = w.about ? ` ${w.about.startsWith('the ') || w.about.startsWith('about') ? '' : 'about '}${w.about}` : '';
    items.push({ kind: 'waiting_them', text: w.about.includes('confirm') ? `${w.who} hasn't ${w.about}.` : `${w.who} hasn't replied${about}.`, id: w.id });
  }
  void tz;
  return items;
}

export function needsMeText(items: NeedItem[], undatedTasks: number): string {
  if (!items.length) {
    return undatedTasks ? `Nothing urgent. You've got ${undatedTasks === 1 ? 'one thing' : `${undatedTasks} things`} on your list whenever you're ready.` : "Nothing needs you right now.";
  }
  const shown = items.slice(0, 5);
  const count = items.length === 1 ? 'One thing needs you' : `${numberWord(items.length)} things need you`;
  const extra = items.length > 5 ? ` …and ${items.length - 5} more.` : '';
  return `${count}: ${shown.map((i) => i.text).join(' ')}${extra}`;
}

function numberWord(n: number): string {
  return ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'][n] ?? String(n);
}

// ---------------------------------------------------------------------------
// Handled
// ---------------------------------------------------------------------------

function phraseFor(e: LedgerEntry, state: UserState, now: Date): { group: string; text: string } | undefined {
  const tz = state.profile.timeZone;
  const after = e.after as any;
  const before = e.before as any;
  switch (e.actionType) {
    case 'calendar.cancel':
      return { group: 'cancel', text: `cancelled ${(before?.title ?? 'an event').toLowerCase()}` };
    case 'calendar.create':
      if (after?.meeting || /zoom|meet|teams|call/i.test(after?.title ?? '')) return { group: 'meeting', text: `set up the ${after?.title ?? 'meeting'}` };
      return { group: 'create', text: `added ${after?.title ?? 'an event'} to your calendar` };
    case 'calendar.update':
      if (after?.start && before?.start !== after.start) {
        return { group: 'move', text: `moved ${(after.title ?? 'an event').toLowerCase()} to ${formatWhen(new Date(after.start), tz, now)}` };
      }
      return { group: 'move', text: `updated ${(after?.title ?? 'an event').toLowerCase()}` };
    case 'shopping.add':
      return { group: 'shopping', text: after?.name ?? 'an item' };
    case 'shopping.complete':
      return { group: 'ticked', text: after?.name ?? 'an item' };
    case 'reminder.create':
      return { group: 'reminder', text: after?.text ?? 'a reminder' };
    case 'reminder.complete':
      return { group: 'done', text: after?.text ?? '' };
    case 'draft.create': {
      const who = personName(state, after?.to) ?? 'someone';
      if (after?.relatedEventId) return { group: 'draft', text: `prepared ${who}'s invite` };
      return { group: 'draft', text: `drafted ${who}'s ${after?.channel === 'email' ? 'email' : 'reply'}` };
    }
    case 'message.send': {
      const who = personName(state, after?.to) ?? 'someone';
      return { group: 'send', text: `sent ${who} your message` };
    }
    case 'email.archive':
      return { group: 'email', text: e.summary.replace(/^Archived/, 'archived') };
    case 'email.delete':
      return { group: 'email', text: e.summary.replace(/^Deleted/, 'deleted') };
    case 'booking.create':
      return { group: 'booking', text: e.summary.replace(/^Booked/, 'booked') };
    case 'waiting.create':
      return undefined;
    case 'note.create':
      return { group: 'note', text: 'note' };
    default:
      return undefined;
  }
}

export function handledSummary(state: UserState, now: Date, range: 'today' | 'week' = 'today', sessionId?: string): string {
  const tz = state.profile.timeZone;
  const from = range === 'today' ? startOfLocalDay(now, tz) : new Date(now.getTime() - 7 * 86400000);
  const entries = state.ledger.filter(
    (e) => e.verified && !e.undoneAt && Date.parse(e.at) >= from.getTime() && (!sessionId || e.sessionId === sessionId),
  );
  // An event cancelled and then rescheduled is reported once, as the final outcome.
  const lastById = new Map<string, LedgerEntry>();
  for (const e of entries) if (e.entity === 'event') lastById.set(e.entityId, e);
  const phrases: string[] = [];
  const shopping: string[] = [];
  const reminders: string[] = [];
  const ticked: string[] = [];
  let notes = 0;
  for (const e of entries) {
    if (e.entity === 'event' && lastById.get(e.entityId) !== e) continue;
    const p = phraseFor(e, state, now);
    if (!p) continue;
    if (p.group === 'shopping') shopping.push(p.text);
    else if (p.group === 'reminder') reminders.push(p.text);
    else if (p.group === 'ticked') ticked.push(p.text);
    else if (p.group === 'note') notes++;
    else if (p.group !== 'done' && !phrases.includes(p.text)) phrases.push(p.text);
  }
  if (shopping.length) phrases.push(shopping.length > 3 ? `added ${shopping.length} things to your shopping list` : `added ${listJoin(shopping)} to your shopping list`);
  if (ticked.length) phrases.push(`ticked off ${listJoin(ticked)}`);
  const lc = (x: string) => (/^(Call|Message|Reply|Email|Book|Buy|Get|Pay|Send|Pick|Take|Check|Renew|Tell|Text|Ring|Phone)\b/.test(x) ? x.charAt(0).toLowerCase() + x.slice(1) : x);
  if (reminders.length) phrases.push(reminders.length <= 3 ? `set reminders to ${listJoin(reminders.map(lc))}`.replace(/^set reminders to (.*)$/, reminders.length === 1 ? 'set a reminder to $1' : 'set reminders to $1') : `set ${reminders.length} reminders`);
  if (notes) phrases.push(notes === 1 ? 'saved a note' : `saved ${notes} notes`);

  const waiting = state.waiting.filter((w) => w.status === 'waiting' && w.direction === 'them');
  const waitText = waiting.length
    ? ' ' + waiting.map((w) => `${w.who} hasn't ${/confirm/.test(w.about) ? 'confirmed' : 'replied'} yet.`).join(' ')
    : '';
  const when = range === 'today' ? 'Today' : 'This week';
  if (!phrases.length) return `I haven't needed to do anything ${range === 'today' ? 'today' : 'this week'} yet.${waitText}`;
  return `${when} I ${listJoin(phrases)}.${waitText}`;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export function scheduleSummary(events: CalendarEvent[], tz: string, now: Date, from: Date, to: Date, label: string): string {
  const list = events
    .filter((e) => e.status === 'confirmed' && Date.parse(e.start) >= from.getTime() && Date.parse(e.start) < to.getTime())
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (!list.length) return `Nothing on ${label}.`;
  const multiDay = localDateKey(from, tz) !== localDateKey(new Date(to.getTime() - 1), tz);
  const parts = list.slice(0, 8).map((e) => {
    const d = new Date(e.start);
    return multiDay ? `${e.title} ${formatWhen(d, tz, now, e.allDay)}` : `${e.title} at ${formatClock(d, tz)}`;
  });
  const more = list.length > 8 ? `, and ${list.length - 8} more` : '';
  return `${capitalize(label)}: ${listJoin(parts)}${more}.`;
}

// ---------------------------------------------------------------------------
// Weekly
// ---------------------------------------------------------------------------

export function weeklyBriefing(state: UserState, events: CalendarEvent[], now: Date): string {
  const tz = state.profile.timeZone;
  const today = zonedParts(now, tz);
  const weekEnd = zonedToUtc({ ...addDays(today, 7), hour: 0, minute: 0 }, tz);
  const lines: string[] = ["Here's what's happening this week."];

  const handled = handledSummary(state, now, 'week');
  if (!/^I haven't/.test(handled)) lines.push(handled.replace(/^This week I/, 'Over the last week I'));

  const upcoming = events.filter((e) => e.status === 'confirmed' && Date.parse(e.start) >= now.getTime() && Date.parse(e.start) < weekEnd.getTime());
  if (upcoming.length) {
    const byDay = new Map<string, string[]>();
    for (const e of upcoming.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
      const d = new Date(e.start);
      const day = formatDay(d, tz, now);
      byDay.set(day, [...(byDay.get(day) ?? []), `${e.title} at ${formatClock(d, tz)}`]);
    }
    const parts = [...byDay.entries()].slice(0, 7).map(([day, list]) => `${capitalize(day)}: ${listJoin(list)}`);
    lines.push(`Coming up — ${parts.join('. ')}.`);
  } else {
    lines.push('Your calendar is clear this week.');
  }

  const remaining = state.reminders.filter((r) => r.status === 'open');
  if (remaining.length) {
    const top = remaining.slice(0, 3).map((r) => r.text.charAt(0).toLowerCase() + r.text.slice(1));
    lines.push(`Still on your list: ${listJoin(top)}${remaining.length > 3 ? ` and ${remaining.length - 3} more` : ''}.`);
  }
  const waiting = state.waiting.filter((w) => w.status === 'waiting');
  if (waiting.length) lines.push(`Waiting: ${waiting.map((w) => (w.direction === 'them' ? `${w.who} hasn't replied` : `${w.who} is waiting on you`)).join('; ')}.`);

  const routines = state.routines.filter((r) => r.status !== 'paused');
  if (routines.length) {
    lines.push(`Your routines: ${listJoin(routines.map((r) => `${r.title.toLowerCase()} on ${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][r.weekday]}`))}.`);
  }
  const shopping = state.shopping.filter((s) => s.status === 'needed');
  if (shopping.length) lines.push(`${shopping.length === 1 ? 'One thing' : `${shopping.length} things`} on your shopping list.`);

  // Preparation: events in the next 3 days that often need something.
  const prep = upcoming.filter((e) => /dentist|doctor|flight|interview|meeting|appointment|trip|exam/i.test(e.title) && Date.parse(e.start) < now.getTime() + 3 * 86400000);
  if (prep.length) lines.push(`Worth preparing for: ${listJoin(prep.map((e) => e.title))}.`);
  void addDays;
  return lines.join(' ');
}

export const WEEKLY_PROMPTS = ["Anything on your mind?", "Anything you've been meaning to do?", 'Anything I can make easier?', 'Anything else?'];
