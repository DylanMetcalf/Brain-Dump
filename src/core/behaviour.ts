// Behavioural & friction engine.
// OBSERVED → RECOGNISED → SUGGESTED → CONFIRMED → PREPARED → AUTOMATED
// Repetition alone never grants permission: every step past SUGGESTED needs the user's yes.

import { capitalize, contentTokens, listJoin } from './text.js';
import { weekdayName, zonedParts } from './time.js';
import type { IdGen } from './text.js';
import type { Suggestion, UserState } from './types.js';

const DAY = 86400000;

function isoWeek(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / DAY - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${week}`;
}

function partOfDay(h: number): string {
  if (h < 12) return 'mornings';
  if (h < 17) return 'afternoons';
  return 'evenings';
}

/** Normalised routine key: "calisthenics session" ≈ "calisthenics". */
function titleKey(title: string): string {
  return contentTokens(title).sort().join(' ');
}

interface RoutineCandidate {
  key: string;
  title: string;
  weekday: number;
  hour: number;
  minute: number;
  weeks: number;
  durationMin: number;
  kind: 'exercise' | 'run' | 'appointment' | 'other';
}

export function detectRoutines(state: UserState, now: Date): RoutineCandidate[] {
  const tz = state.profile.timeZone;
  const since = now.getTime() - 10 * 7 * DAY;
  const groups = new Map<string, { title: string; hits: { week: string; weekday: number; hour: number; minute: number; dur: number }[] }>();
  const add = (title: string, start: Date, dur: number) => {
    const key = titleKey(title);
    if (!key) return;
    const p = zonedParts(start, tz);
    const g = groups.get(key) ?? { title, hits: [] };
    g.hits.push({ week: isoWeek(start, tz), weekday: p.weekday, hour: p.hour, minute: p.minute, dur });
    groups.set(key, g);
  };
  // Authorised observations: calendar events (including ones since cancelled — they still show a pattern) and reported activities.
  for (const e of state.events) {
    if (Date.parse(e.start) < since || Date.parse(e.start) > now.getTime() + 7 * DAY || e.routineId) continue;
    add(e.title, new Date(e.start), Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60000));
  }
  for (const o of state.observations) {
    if (o.kind !== 'activity' || Date.parse(o.at) < since) continue;
    const at = o.meta?.start ? new Date(String(o.meta.start)) : new Date(o.at);
    add(o.key, at, 45);
  }
  const out: RoutineCandidate[] = [];
  for (const [key, g] of groups) {
    // Group by weekday; allow ±90 minutes of variation in time.
    for (let wd = 0; wd < 7; wd++) {
      const hits = g.hits.filter((h) => h.weekday === wd);
      const weeks = new Set(hits.map((h) => h.week));
      if (weeks.size < 3) continue;
      const hours = hits.map((h) => h.hour * 60 + h.minute).sort((a, b) => a - b);
      const median = hours[Math.floor(hours.length / 2)];
      const consistent = hours.filter((m) => Math.abs(m - median) <= 90).length / hours.length;
      if (consistent < 0.75) continue;
      const kind = /\b(run|jog)\b/.test(key) ? 'run' : /(yoga|gym|calisthenic|pilates|swim|workout|class|training|climb|spin)/.test(key) ? 'exercise' : /(dentist|doctor|therapy|physio|hair|massage)/.test(key) ? 'appointment' : 'other';
      const durs = hits.map((h) => h.dur).sort((a, b) => a - b);
      out.push({ key, title: capitalize(g.title), weekday: wd, hour: Math.floor(median / 60), minute: median % 60, weeks: weeks.size, durationMin: durs[Math.floor(durs.length / 2)] || 60, kind });
    }
  }
  return out;
}

export function detectStaples(state: UserState, now: Date): { name: string; weeks: number }[] {
  const tz = state.profile.timeZone;
  const since = now.getTime() - 8 * 7 * DAY;
  const byItem = new Map<string, Set<string>>();
  for (const o of state.observations) {
    if (o.kind !== 'item_added' || Date.parse(o.at) < since) continue;
    const set = byItem.get(o.key) ?? new Set();
    set.add(isoWeek(new Date(o.at), tz));
    byItem.set(o.key, set);
  }
  return [...byItem.entries()]
    .filter(([name, weeks]) => weeks.size >= 3 && !/^(groceries|grocery|food|shopping)$/.test(name))
    .map(([name, weeks]) => ({ name, weeks: weeks.size }))
    .sort((a, b) => b.weeks - a.weeks);
}

function upsertSuggestion(state: UserState, ids: IdGen, now: Date, s: Omit<Suggestion, 'id' | 'createdAt' | 'status'>): void {
  const existing = state.suggestions.find((x) => x.key === s.key);
  if (existing) {
    // Respect declines: 30-day cool-off, and never again after two declines.
    if (existing.status === 'declined') {
      const declines = Number(existing.payload.declines ?? 1);
      if (declines >= 2 || now.getTime() - Date.parse(existing.respondedAt ?? existing.createdAt) < 30 * DAY) return;
      existing.status = 'pending';
      existing.text = s.text;
      existing.score = s.score;
      existing.payload = { ...s.payload, declines };
      return;
    }
    if (existing.status === 'pending' || existing.status === 'offered') {
      existing.text = s.text;
      existing.score = s.score;
      existing.payload = { ...existing.payload, ...s.payload };
    }
    return;
  }
  state.suggestions.push({ ...s, id: ids('sug'), createdAt: now.toISOString(), status: 'pending' });
}

/** Re-analyse behaviour; creates or refreshes suggestions. Pure bookkeeping — never acts. */
export function analyseBehaviour(state: UserState, ids: IdGen, now: Date): void {
  // Routines
  for (const r of detectRoutines(state, now)) {
    if (state.routines.some((x) => titleKey(x.title) === r.key && x.weekday === r.weekday)) continue;
    const when = `${weekdayName(r.weekday)} ${partOfDay(r.hour)}`;
    upsertSuggestion(state, ids, now, {
      kind: 'routine',
      key: `routine:${r.key}:${r.weekday}`,
      text: `I've noticed you usually do ${r.title.toLowerCase()} on ${when}. Want me to remember that as your usual routine?`,
      score: Math.min(1, 0.4 + r.weeks * 0.12),
      payload: { ...r },
    });
  }
  // Shopping staples
  const staples = detectStaples(state, now).filter((s) => !state.routines.some((r) => r.kind === 'shopping' && r.items?.includes(s.name)));
  if (staples.length >= 2) {
    const names = staples.slice(0, 5).map((s) => s.name);
    upsertSuggestion(state, ids, now, {
      kind: 'staples',
      key: `staples:${names.slice(0, 3).sort().join(',')}`,
      text: `You add ${listJoin(names)} most weeks. Want me to put them on your list automatically each week?`,
      score: Math.min(1, 0.35 + staples[0].weeks * 0.1),
      payload: { items: names },
    });
  }
  // Repeated manual checks for a reply
  const checks = new Map<string, number>();
  for (const o of state.observations) {
    if (o.kind === 'manual_check' && Date.parse(o.at) > now.getTime() - 7 * DAY) checks.set(o.key, (checks.get(o.key) ?? 0) + 1);
  }
  for (const [person, n] of checks) {
    if (n < 2) continue;
    const w = state.waiting.find((x) => x.status === 'waiting' && x.who.toLowerCase() === person && !x.notifyOnReply);
    if (!w) continue;
    upsertSuggestion(state, ids, now, {
      kind: 'notify_reply',
      key: `notify:${w.id}`,
      text: `You keep checking whether ${w.who} has replied. Want me to tell you when ${w.who.split(' ')[0]} does?`,
      score: Math.min(1, 0.5 + n * 0.15),
      payload: { waitingId: w.id },
    });
  }
  // Many separate one-item captures of groceries in a day → offer a combined list.
  const perDay = new Map<string, Set<string>>();
  for (const o of state.observations) {
    if (o.kind !== 'item_added' || Date.parse(o.at) < now.getTime() - 14 * DAY) continue;
    const day = o.at.slice(0, 10);
    const sid = String(o.meta?.sessionId ?? o.at);
    perDay.set(day, (perDay.get(day) ?? new Set()).add(sid));
  }
  const busyDays = [...perDay.values()].filter((s) => s.size >= 4).length;
  if (busyDays >= 2 && !state.profile.preferences.shoppingDigest) {
    upsertSuggestion(state, ids, now, {
      kind: 'combine_capture',
      key: 'combine_capture',
      text: 'You keep adding groceries separately. Want me to combine them and send you one list before you usually shop?',
      score: 0.6,
      payload: {},
    });
  }
  // Same service booked manually several times → remember the provider.
  const bookings = new Map<string, number>();
  for (const o of state.observations) if (o.kind === 'booking' && o.meta?.provider) bookings.set(o.key, (bookings.get(o.key) ?? 0) + 1);
  for (const [service, n] of bookings) {
    if (n < 2 || state.memories.some((m) => m.kind === 'service' && m.subject.includes(service))) continue;
    const last = [...state.observations].reverse().find((o) => o.kind === 'booking' && o.key === service);
    upsertSuggestion(state, ids, now, {
      kind: 'remember_provider',
      key: `provider:${service}`,
      text: `You've booked ${service} the same way ${n} times. Want me to remember that as your usual place?`,
      score: 0.55,
      payload: { service, provider: last?.meta?.provider, serviceId: last?.meta?.serviceId },
    });
  }
  // Waiting too long → offer a nudge (once).
  for (const w of state.waiting) {
    if (w.status !== 'waiting' || w.direction !== 'them' || w.nudgedAt) continue;
    if (now.getTime() - Date.parse(w.since) < 3 * DAY) continue;
    upsertSuggestion(state, ids, now, {
      kind: 'nudge',
      key: `nudge:${w.id}`,
      text: `${w.who} still hasn't replied${w.about ? ` about ${w.about}` : ''}. Want me to draft a quick nudge?`,
      score: 0.5,
      payload: { waitingId: w.id },
    });
  }
}

export function pronounFor(_name: string): string {
  return 'they';
}

/** The single best suggestion worth interrupting for, if any. Silence is a valid outcome. */
export function pickProactive(state: UserState, now: Date, threshold = 0.6): Suggestion | undefined {
  if (state.profile.preferences.proactivity === 'quiet') return undefined;
  const recentOffer = state.suggestions.some((s) => s.offeredAt && now.getTime() - Date.parse(s.offeredAt) < 2 * DAY);
  if (recentOffer) return undefined;
  // Acceptance history adjusts the bar: users who often decline get fewer suggestions.
  const responded = state.suggestions.filter((s) => s.status === 'accepted' || s.status === 'declined');
  const declineRate = responded.length ? responded.filter((s) => s.status === 'declined').length / responded.length : 0;
  const bar = threshold + declineRate * 0.3;
  return state.suggestions
    .filter((s) => s.status === 'pending' && s.score >= bar)
    .sort((a, b) => b.score - a.score)[0];
}
