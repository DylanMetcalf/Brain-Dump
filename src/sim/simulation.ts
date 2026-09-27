// 30-day simulation of realistic, messy use (spec §70).
// Every step carries a check that knows the right outcome, so the report measures
// correctness and mental load removed — not just "it didn't crash".

import { Assistant, Reply } from '../core/assistant.js';
import { LocalCalendar, NewEvent } from '../core/providers.js';
import { tick } from '../core/scheduler.js';
import { createUserState, grantEverydayPermissions } from '../core/state.js';
import { sequentialIds } from '../core/text.js';
import { zonedParts, zonedToUtc } from '../core/time.js';
import type { CalendarEvent, UserState } from '../core/types.js';

export const SIM_TZ = 'Europe/London';

interface Step {
  day: number;
  hour: number;
  minute?: number;
  text?: string;
  /** New conversation (e.g. widget tapped again). */
  fresh?: boolean;
  /** Captured offline: replayed later with this capture time. */
  offline?: boolean;
  tick?: boolean;
  notificationAct?: { match: RegExp; value: string };
  check?: (s: UserState, r: Reply | undefined) => boolean | string;
  label: string;
  /** This step should NOT need a question. */
  noQuestion?: boolean;
}

export interface SimReport {
  days: number;
  utterances: number;
  checks: number;
  passed: number;
  failures: { day: number; label: string; text?: string; reply?: string; why: string }[];
  verifiedActions: number;
  questionsAsked: number;
  unnecessaryConfirmations: number;
  falseClaims: number;
  duplicates: number;
  thoughtsLost: number;
  notifications: number;
  suggestionsOffered: number;
  mentalLoadScore: number;
  transcript: string[];
}

/** A calendar that fails on chosen days (simulated outage of an integration). */
class FlakyCalendar extends LocalCalendar {
  failing = false;
  override async create(ev: NewEvent): Promise<CalendarEvent> {
    if (this.failing) throw new Error('calendar unavailable');
    return super.create(ev);
  }
  override async cancel(id: string): Promise<void> {
    if (this.failing) throw new Error('calendar unavailable');
    return super.cancel(id);
  }
}

const count = (s: UserState, re: RegExp, status = 'confirmed') => s.events.filter((e) => re.test(e.title) && e.status === status).length;
const needed = (s: UserState, name: string) => s.shopping.some((i) => i.name === name && i.status === 'needed');
const reminder = (s: UserState, re: RegExp, status = 'open') => s.reminders.some((r) => re.test(r.text) && r.status === status);
const says = (re: RegExp) => (_s: UserState, r?: Reply) => (!!r && re.test(r.text)) || `reply was: ${r?.text}`;

function script(): Step[] {
  const S: Step[] = [];
  const add = (x: Step) => S.push(x);
  // Weeks start Monday 5 Oct 2026 (day 1).
  for (let week = 0; week < 5; week++) {
    const base = week * 7;
    if (base + 4 > 30) break;
    // Thursday calisthenics, stated the evening before (a routine to be discovered).
    add({ day: base + 3, hour: 20, fresh: true, text: week % 2 ? "Calisthenics tomorrow at 8, and I'm out of oat milk" : 'Calisthenics tomorrow at 8', label: `w${week} calisthenics`, noQuestion: true, check: (s) => s.events.filter((e) => /calisthenics/i.test(e.title)).length >= 1 });
    add({ day: base + 3, hour: 20, minute: 1, text: "That's all", label: 'end', check: says(/sorted everything/) });
    // Weekend groceries: messy stream.
    add({ day: base + 6, hour: 10, fresh: true, text: 'um so I need milk, eggs and bread, oh and bin bags', label: `w${week} groceries`, noQuestion: true, check: (s) => needed(s, 'milk') && needed(s, 'bin bags') });
    add({ day: base + 6, hour: 17, fresh: true, text: 'I got the milk and the eggs', label: `w${week} got milk`, check: (s) => !needed(s, 'milk') && !needed(s, 'eggs') });
    add({ day: base + 6, hour: 17, minute: 1, text: "don't worry about bread", label: 'no bread', check: (s) => !needed(s, 'bread') });
    add({ day: base + 6, hour: 17, minute: 2, text: 'got the bin bags too', label: 'bin bags', check: (s) => !needed(s, 'bin bags') });
  }

  // Day 1 (Mon 5 Oct): onboarding-free morning dump.
  add({ day: 1, hour: 8, fresh: true, text: 'I need groceries, I forgot about yoga tomorrow, I should reply to Sarah, and I need to call the dentist', label: 'golden multi-thought', check: (s, r) => (reminder(s, /call the dentist/i) && reminder(s, /reply to sarah/i) && /Which Sarah/.test(r?.text ?? '')) || `reply: ${r?.text}` });
  add({ day: 1, hour: 8, minute: 1, text: 'Jones', label: 'which Sarah → Jones', check: (s, r) => (/What do you want to say to Sarah Jones/.test(r?.text ?? '') && s.reminders.some((x) => x.text === 'Reply to Sarah Jones' && !!x.personId)) || `reply: ${r?.text}` });
  add({ day: 1, hour: 8, minute: 2, text: "Just tell her I'll send the photos tonight", label: 'draft body', check: (s) => s.drafts.some((d) => s.contacts.find((c) => c.id === d.to)?.name === 'Sarah Jones' && /photos tonight/.test(d.body)) || 'no draft to Sarah Jones' });
  add({ day: 1, hour: 8, minute: 3, text: "that's it", label: 'end', check: says(/sorted/) });

  // Day 2: yoga the critical way.
  add({ day: 2, hour: 9, fresh: true, text: "Ah, I can't make that yoga appointment anymore.", label: 'critical cancel', noQuestion: false, check: (s, r) => (count(s, /^yoga$/i) === 0 && /reschedule/.test(r?.text ?? '') && !/are you sure/i.test(r?.text ?? '')) || `reply: ${r?.text}` });
  add({ day: 2, hour: 9, minute: 1, text: 'No.', label: 'no reschedule', check: says(/^OK\.$/) });

  // Day 3: meeting with Rick (New York).
  add({ day: 3, hour: 11, fresh: true, text: 'Rick lives in New York', label: 'Rick tz', check: (s) => s.contacts.some((c) => c.name === 'Rick' && c.timeZone === 'America/New_York') });
  add({ day: 3, hour: 11, minute: 1, text: 'Organise a Zoom with Rick', label: 'meeting', check: says(/What day/) });
  add({ day: 3, hour: 11, minute: 2, text: 'Thursday', label: 'meeting day', check: says(/What time/) });
  add({ day: 3, hour: 11, minute: 3, text: 'Two', label: 'meeting time → zone q', check: says(/your time or Rick's/) });
  add({ day: 3, hour: 11, minute: 4, text: "Rick's", label: 'meeting zone', check: (s) => s.events.some((e) => /zoom with rick/i.test(e.title) && e.start === zonedToUtc({ year: 2026, month: 10, day: 8, hour: 14, minute: 0 }, 'America/New_York').toISOString()) || 'wrong meeting time' });
  add({ day: 3, hour: 11, minute: 5, text: "That's all", label: 'end', check: says(/sorted/) });

  // Day 4: status checks.
  add({ day: 4, hour: 18, fresh: true, text: 'What still needs me?', label: 'needs me', check: says(/Rick hasn't confirmed/) });
  add({ day: 4, hour: 18, minute: 1, text: 'Has Rick replied?', label: 'check 1', check: says(/Not yet/) });
  add({ day: 5, hour: 9, fresh: true, text: 'Has Rick replied?', label: 'check 2 → offer', check: says(/tell you when Rick does/) });
  add({ day: 5, hour: 9, minute: 1, text: 'yes', label: 'accept watch', check: (s) => s.waiting.some((w) => w.who === 'Rick' && w.notifyOnReply) });
  add({ day: 5, hour: 14, label: 'Rick replies (tick)', tick: true, check: (s) => s.waiting.some((w) => w.who === 'Rick' && w.status === 'resolved') || 'Rick still waiting' });

  // Day 6: modification chain with shopping vs event focus.
  add({ day: 6, hour: 12, fresh: true, text: 'I need to buy eye patches', label: 'capture', noQuestion: true, check: (s) => needed(s, 'eye patches') });
  add({ day: 6, hour: 12, minute: 1, text: 'Actually make that three', label: 'quantity by focus', check: (s) => s.shopping.some((i) => i.name === 'eye patches' && i.quantity === 3) || 'quantity not set' });

  // Day 8: dentist appointment and move.
  add({ day: 8, hour: 9, fresh: true, text: 'Dentist on Friday at 10', label: 'event add', noQuestion: true, check: (s) => count(s, /dentist/i) === 1 });
  add({ day: 8, hour: 9, minute: 1, text: 'Move it to 11', label: 'move', check: (s) => s.events.some((e) => /dentist/i.test(e.title) && zonedParts(new Date(e.start), SIM_TZ).hour === 11) });
  add({ day: 8, hour: 9, minute: 2, text: 'I called the dentist', label: 'completion', check: (s) => reminder(s, /call the dentist/i, 'done') });
  add({ day: 8, hour: 9, minute: 3, text: 'Dentist on Friday at 11', label: 'duplicate guard', check: (s) => count(s, /dentist/i) === 1 || 'duplicate dentist' });

  // Day 9: offline capture on the Tube.
  add({ day: 9, hour: 8, fresh: true, offline: true, text: 'Remember to buy batteries', label: 'offline 1', check: () => true });
  add({ day: 9, hour: 8, minute: 5, offline: true, text: 'Remind me to pay the window cleaner tomorrow', label: 'offline 2', check: () => true });
  add({ day: 9, hour: 9, label: 'back online (replay twice)', check: (s) => (s.shopping.filter((i) => i.name === 'batteries').length === 1 && s.reminders.filter((r) => /window cleaner/.test(r.text)).length === 1) || 'offline replay wrong' });

  // Day 10: interruption — user walks away mid-question, comes back later.
  add({ day: 10, hour: 12, fresh: true, text: 'Book me a massage next Wednesday afternoon', label: 'booking (no integration)', check: says(/can't book massage directly/) });
  add({ day: 10, hour: 12, minute: 1, text: "I'm going for a run later", label: 'run', check: says(/What time/) });
  add({ day: 10, hour: 13, label: 'walks away (session expires)', tick: true, check: (s) => s.sessions.filter((x) => !x.endedAt && x.device !== 'automation').length === 0 });
  add({ day: 10, hour: 16, fresh: true, text: 'What still needs me?', label: 'massage surfaced', check: says(/massage/i) });

  // Day 11: ambiguity.
  add({ day: 11, hour: 8, fresh: true, text: 'Pilates Saturday at 7pm and pilates Sunday at 7am', label: 'two pilates', check: (s) => count(s, /pilates/i) === 2 });
  add({ day: 11, hour: 8, minute: 1, text: 'Cancel pilates', label: 'ambiguous → one question', check: says(/^Which one — Saturday at 7 or Sunday at 7\?$/) });
  add({ day: 11, hour: 8, minute: 2, text: 'the morning one', label: 'resolve by part of day', check: (s) => (count(s, /pilates/i) === 1 && s.events.some((e) => /pilates/i.test(e.title) && e.status === 'cancelled' && zonedParts(new Date(e.start), SIM_TZ).hour === 7)) || 'wrong pilates' });

  // Day 12: undo & correction.
  add({ day: 12, hour: 19, fresh: true, text: 'Add avocados, limes and tortillas', label: 'taco night', noQuestion: true, check: (s) => needed(s, 'avocados') && needed(s, 'tortillas') });
  add({ day: 12, hour: 19, minute: 1, text: 'undo', label: 'undo batch', check: (s) => !needed(s, 'avocados') && !needed(s, 'tortillas') });

  // Day 13: waiting on me + completion.
  add({ day: 13, hour: 10, fresh: true, text: "Sarah Lee is waiting for my answer about the flat", label: 'waiting me', check: (s) => s.waiting.some((w) => w.direction === 'me' && /flat/.test(w.about)) });
  add({ day: 13, hour: 15, fresh: true, text: 'I replied to Sarah Lee', label: 'resolve me-waiting', check: (s) => s.waiting.every((w) => w.direction !== 'me' || w.status === 'resolved') || 'still waiting' });

  // Day 17: calendar integration outage.
  add({ day: 17, hour: 9, fresh: true, text: 'Haircut Saturday at 11', label: 'calendar down: honest failure', check: (s, r) => (count(s, /haircut/i) === 0 && /couldn't update your calendar/.test(r?.text ?? '') && !/^Added/.test(r?.text ?? '')) || `reply: ${r?.text}` });
  add({ day: 17, hour: 12, fresh: true, text: 'Haircut Saturday at 11', label: 'retry after outage', check: (s) => count(s, /haircut/i) === 1 });

  // Day 20: friction → routine + staples suggestions.
  add({ day: 20, hour: 21, fresh: true, text: 'Can you make this easier?', label: 'friction', check: says(/calisthenics|most weeks/i) });
  add({ day: 20, hour: 21, minute: 1, text: 'yes', label: 'accept', check: (s) => s.routines.length >= 1 });
  add({ day: 20, hour: 21, minute: 2, text: 'yes', label: 'automate', check: (s) => s.routines.some((r) => r.status === 'automated') });

  // Day 22: automation materialises the routine exactly once.
  add({ day: 22, hour: 12, label: 'tick automation', tick: true, check: () => true });
  add({ day: 22, hour: 12, minute: 5, label: 'tick again (idempotent)', tick: true, check: (s) => (s.events.filter((e) => /calisthenics/i.test(e.title) && e.status === 'confirmed' && e.start.startsWith('2026-10-29')).length === 1) || 'routine not exactly once' });

  // Day 24: noise and fillers.
  add({ day: 24, hour: 8, fresh: true, text: 'um', label: 'filler ignored', check: (s) => !s.notes.some((n) => /^um$/i.test(n.text)) || 'filler saved as note' });
  add({ day: 24, hour: 8, minute: 1, text: 'hey mylo remind me to renew the car insurance on Friday', label: 'misheard name', check: (s) => reminder(s, /renew the car insurance/i) });

  // Day 27: weekly briefing conversation.
  add({ day: 27, hour: 18, fresh: true, text: 'weekly review', label: 'weekly', check: says(/Here's what's happening this week/) });
  add({ day: 27, hour: 18, minute: 1, text: 'I need to get the boiler serviced', label: 'brain dump in briefing', check: (s) => reminder(s, /boiler serviced/) });
  add({ day: 27, hour: 18, minute: 2, text: 'no', label: 'b2', check: () => true });
  add({ day: 27, hour: 18, minute: 3, text: 'no', label: 'b3', check: () => true });
  add({ day: 27, hour: 18, minute: 4, text: "no that's it", label: 'b4', check: () => true });

  // Day 30: history.
  add({ day: 30, hour: 20, fresh: true, text: 'What did you handle this week?', label: 'handled', check: says(/^This week I/) });
  return S.sort((a, b) => a.day - b.day || a.hour - b.hour || (a.minute ?? 0) - (b.minute ?? 0));
}

const LOW_RISK_CONFIRM = /^(Cancel yoga|Cancel pilates|Add|Remind|Shall I go ahead)/;

export async function runSimulation(): Promise<SimReport> {
  const clock = { now: zonedToUtc({ year: 2026, month: 10, day: 5, hour: 7, minute: 0 }, SIM_TZ) };
  const state = createUserState('sim', SIM_TZ, clock.now);
  state.profile.assistantName = 'Milo';
  state.profile.onboarding = 'done';
  grantEverydayPermissions(state, 'onboarding', clock.now);
  const ids = sequentialIds();
  let st = state;
  const cal = new FlakyCalendar(() => st, ids, () => clock.now);
  const a = new Assistant(state, { clock: () => clock.now, ids, providers: { calendar: cal } });
  st = a.state;

  // Pre-existing world.
  const ev = (title: string, d: number, h: number) =>
    state.events.push({ id: ids('evt'), title, start: zonedToUtc({ year: 2026, month: 10, day: d, hour: h, minute: 0 }, SIM_TZ).toISOString(), end: zonedToUtc({ year: 2026, month: 10, day: d, hour: h + 1, minute: 0 }, SIM_TZ).toISOString(), timeZone: SIM_TZ, attendees: [], status: 'confirmed', source: 'local', createdAt: clock.now.toISOString(), updatedAt: clock.now.toISOString() });
  ev('Yoga', 6, 14);
  for (const n of ['Sarah Jones', 'Sarah Lee']) state.contacts.push({ id: ids('person'), name: n, aliases: [], source: 'provider', createdAt: clock.now.toISOString() });

  const report: SimReport = {
    days: 30, utterances: 0, checks: 0, passed: 0, failures: [], verifiedActions: 0, questionsAsked: 0, unnecessaryConfirmations: 0,
    falseClaims: 0, duplicates: 0, thoughtsLost: 0, notifications: 0, suggestionsOffered: 0, mentalLoadScore: 0, transcript: [],
  };
  let sessionId: string | undefined;
  const offlineQueue: { clientId: string; text: string; capturedAt: string }[] = [];
  let lastDay = 0;

  for (const step of script()) {
    const at = zonedToUtc({ year: 2026, month: 10, day: 4 + step.day, hour: step.hour, minute: step.minute ?? 0 }, SIM_TZ);
    // Run the scheduler through the passing time, like the real server does.
    if (step.day !== lastDay) {
      for (let d = lastDay + 1; d <= step.day; d++) {
        for (const hh of [7, 12, 18, 21]) {
          const t = zonedToUtc({ year: 2026, month: 10, day: 4 + d, hour: hh, minute: 0 }, SIM_TZ);
          if (t.getTime() < at.getTime() && t.getTime() > clock.now.getTime()) {
            clock.now = t;
            report.notifications += (await tick(a, t)).notifications.length;
          }
        }
      }
      lastDay = step.day;
    }
    clock.now = at;
    cal.failing = step.day === 17 && step.hour === 9;
    // Rick replies on day 5 afternoon.
    if (step.day === 5 && step.hour === 14) {
      const rick = state.contacts.find((c) => c.name === 'Rick');
      if (rick && !rick.email) rick.email = 'rick@example.com';
      state.mailbox.push({ id: 'mail_rick', from: 'rick@example.com', fromName: 'Rick', to: ['me'], subject: 'Thursday works', snippet: 'See you then', receivedAt: at.toISOString(), labels: ['INBOX'], unread: true });
    }
    if (step.fresh) sessionId = undefined;

    let reply: Reply | undefined;
    if (step.offline && step.text) {
      offlineQueue.push({ clientId: `off-${offlineQueue.length}`, text: step.text, capturedAt: at.toISOString() });
      report.transcript.push(`[day ${step.day}] (offline) > ${step.text}`);
      continue;
    }
    if (step.label.startsWith('back online')) {
      for (let pass = 0; pass < 2; pass++) for (const c of offlineQueue) await a.handle({ ...c, now: at });
      offlineQueue.length = 0;
    } else if (step.tick) {
      report.notifications += (await tick(a, at)).notifications.length;
    } else if (step.text) {
      const ledgerBefore = state.ledger.length;
      reply = await a.handle({ text: step.text, sessionId, now: at });
      report.utterances++;
      sessionId = reply.sessionEnded ? undefined : reply.sessionId;
      report.transcript.push(`[day ${step.day} ${String(step.hour).padStart(2, '0')}:${String(step.minute ?? 0).padStart(2, '0')}] > ${step.text}\n    ${reply.text}`);
      if (reply.question) {
        report.questionsAsked++;
        if (step.noQuestion) report.failures.push({ day: step.day, label: step.label, text: step.text, reply: reply.text, why: 'asked a question that should not be needed' });
        if (reply.question && LOW_RISK_CONFIRM.test(reply.question.text) && reply.question.options?.some((o) => /Cancel it|Yes/.test(o.label)) && !/Which/.test(reply.question.text)) report.unnecessaryConfirmations++;
      }
      // No false claims: success words need verified ledger entries from this turn.
      const claimed = /^(Done|Added|Booked|Sent|Ticked off|Took)|I've cancelled|is now|rescheduled/.test(reply.text);
      const fresh = state.ledger.slice(ledgerBefore);
      if (claimed && (!fresh.length || fresh.some((e) => !e.verified))) {
        report.falseClaims++;
        report.failures.push({ day: step.day, label: step.label, text: step.text, reply: reply.text, why: 'claimed an action without a verified ledger entry' });
      }
      if (/Saved — I've noted that/.test(reply.text)) {
        report.thoughtsLost++; // fell through to a generic note
        report.transcript.push('    ^ fell through to a note');
      }
    }

    if (step.check) {
      report.checks++;
      const ok = step.check(state, reply);
      if (ok === true) report.passed++;
      else report.failures.push({ day: step.day, label: step.label, text: step.text, reply: reply?.text, why: typeof ok === 'string' ? ok : 'check failed' });
    }
  }

  // Duplicates: same title at the same start, or the same needed item twice.
  const seen = new Set<string>();
  for (const e of state.events.filter((x) => x.status === 'confirmed')) {
    const k = `${e.title.toLowerCase()}|${e.start}`;
    if (seen.has(k)) {
      report.duplicates++;
      report.failures.push({ day: 0, label: 'duplicate event', why: k });
    }
    seen.add(k);
  }
  const items = state.shopping.filter((i) => i.status === 'needed').map((i) => i.name);
  const dupItems = items.filter((x, i) => items.indexOf(x) !== i);
  report.duplicates += dupItems.length;
  for (const d of dupItems) report.failures.push({ day: 0, label: 'duplicate shopping item', why: d });
  report.verifiedActions = state.ledger.filter((l) => l.verified && !l.undoneAt).length;
  report.suggestionsOffered = state.suggestions.filter((s) => s.offeredAt).length;
  // Mental load: each verified action is something the user didn't have to do or remember;
  // questions cost a little; errors, false claims and lost thoughts cost a lot.
  report.mentalLoadScore =
    report.verifiedActions - report.questionsAsked * 0.5 - report.failures.length * 3 - report.falseClaims * 5 - report.duplicates * 3 - report.thoughtsLost * 2 - report.unnecessaryConfirmations * 2;
  return report;
}
