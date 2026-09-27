// Context resolution: "what is the user actually referring to?"
// Resolves pronouns, demonstratives, titles, dates and people against conversation
// focus and authorised state. Returns found / ambiguous / none — never guesses wildly.

import { contentTokens, matchScore } from './text.js';
import { formatClockShort, formatDay, localDateKey, ParsedWhen, zonedParts, dateKey, addDays } from './time.js';
import type { CalendarEvent, Contact, EntityKind, Ref, Reminder, Session, ShoppingItem, UserState } from './types.js';

export interface Candidate {
  ref: Ref;
  label: string;
  title: string;
  score: number;
  start?: Date;
  status?: string;
}

export type Resolution =
  | { status: 'found'; candidate: Candidate; via: 'focus' | 'match' | 'only-option' }
  | { status: 'ambiguous'; candidates: Candidate[] }
  | { status: 'none'; keywords: string[] };

export interface ResolveContext {
  state: UserState;
  session: Session;
  now: Date;
  tz: string;
  /** Upcoming events from the calendar provider. */
  events: CalendarEvent[];
}

const PRONOUN_ONLY = /^(?:it|that|this|them|those|these|the one|that one|this one|the thing|that thing|the thing we (?:just )?(?:discussed|talked about)|what we (?:just )?(?:discussed|said)|it anymore|that anymore|it any more|this anymore)?$/;

export function eventLabel(e: CalendarEvent, tz: string, now: Date): string {
  const d = new Date(e.start);
  return `${e.title} ${formatDay(d, tz, now)} at ${formatClockShort(d, tz)}`;
}

/** Short disambiguation label: "Tuesday at 2". Falls back to including title when titles differ. */
export function optionLabel(c: Candidate, tz: string, now: Date, includeTitle: boolean): string {
  if (!c.start) return c.title;
  const day = formatDay(c.start, tz, now);
  const dayCap = day[0].toUpperCase() + day.slice(1);
  const base = `${dayCap} at ${formatClockShort(c.start, tz)}`;
  return includeTitle ? `${c.title} ${day} at ${formatClockShort(c.start, tz)}` : base;
}

function keywordsOf(phrase: string): string[] {
  return contentTokens(
    phrase
      .replace(/\b(the one|that one|this one|anymore|any more|appointment|meeting with|thing)\b/g, ' ')
      .replace(/\b(it|that|this|them)\b/g, ' '),
  );
}

function eventCandidate(e: CalendarEvent, state: UserState): Candidate {
  const names = e.attendees.map((id) => state.contacts.find((c) => c.id === id)?.name ?? '').join(' ');
  return { ref: { kind: 'event', id: e.id }, label: e.title, title: `${e.title} ${names}`.trim(), score: 0, start: new Date(e.start), status: e.status };
}

function matchesWhen(start: Date, when: ParsedWhen, tz: string): boolean {
  if (when.date) {
    if (localDateKey(start, tz) !== dateKey(when.date)) return false;
  } else if (when.weekday !== undefined) {
    if (zonedParts(start, tz).weekday !== when.weekday) return false;
  }
  if (when.span) {
    const key = localDateKey(start, tz);
    if (key < dateKey(when.span.from) || key > dateKey(when.span.to)) return false;
  }
  if (when.time) {
    const p = zonedParts(start, tz);
    const mins = p.hour * 60 + p.minute;
    const want = when.time.hour * 60 + when.time.minute;
    const alt = when.time.ambiguous ? ((when.time.hour + 12) % 24) * 60 + when.time.minute : want;
    if (Math.abs(mins - want) > 45 && Math.abs(mins - alt) > 45) return false;
  }
  return true;
}

/**
 * Resolve a spoken reference to one of the user's things.
 * kinds: which entity kinds are sensible for the action (cancel → event/reminder/shopping …)
 */
export function resolveTarget(
  ctx: ResolveContext,
  phrase: string,
  when: ParsedWhen | undefined,
  kinds: EntityKind[],
  opts: { includeCancelledFocus?: boolean } = {},
): Resolution {
  const { state, session, now, tz } = ctx;
  const cleanPhrase = (when?.rest ?? phrase).toLowerCase().trim();
  const keywords = keywordsOf(cleanPhrase);
  const hasWhen = !!when && (when.date !== undefined || when.weekday !== undefined || when.span !== undefined || when.time !== undefined);

  const alive = (ref: Ref): Candidate | undefined => entityCandidate(ctx, ref, opts.includeCancelledFocus);

  // 1. Pure reference ("it", "that", "cancel that") → conversation focus.
  if (!keywords.length) {
    for (const ref of session.focus) {
      if (!kinds.includes(ref.kind)) continue;
      const c = alive(ref);
      if (c && (!hasWhen || !c.start || matchesWhen(c.start, when!, tz))) return { status: 'found', candidate: c, via: 'focus' };
    }
    // 2. No conversational context: is there one obvious target?
    if (kinds.includes('event')) {
      const horizon = hasWhen ? 14 * 86400000 : 12 * 3600000;
      const soon = ctx.events
        .filter((e) => Date.parse(e.start) >= now.getTime() - 15 * 60000 && Date.parse(e.start) <= now.getTime() + horizon)
        .filter((e) => !hasWhen || matchesWhen(new Date(e.start), when!, tz))
        .map((e) => eventCandidate(e, state));
      if (soon.length === 1) return { status: 'found', candidate: soon[0], via: 'only-option' };
      if (soon.length > 1) return { status: 'ambiguous', candidates: soon.slice(0, 3) };
    }
    return { status: 'none', keywords };
  }

  // 3. Keyword match across authorised state.
  const cands: Candidate[] = [];
  const focusIds = new Set(session.focus.map((f) => f.id));

  if (kinds.includes('event')) {
    const pool = [...ctx.events];
    if (opts.includeCancelledFocus) {
      for (const f of session.focus) {
        const e = state.events.find((x) => x.id === f.id && x.status === 'cancelled');
        if (e && !pool.find((p) => p.id === e.id)) pool.push(e);
      }
    }
    for (const e of pool) {
      const c = eventCandidate(e, state);
      if (c.start!.getTime() < now.getTime() - 60 * 60000) continue;
      const generic = keywords.every((k) => k === 'meeting' || k === 'call');
      const s = generic && (e.attendees.length > 0 || !!e.meeting || /meeting|call|sync|zoom|catch/i.test(e.title)) ? 1 : matchScore(keywords.join(' '), c.title);
      if (s < 0.6) continue;
      if (hasWhen && !matchesWhen(c.start!, when!, tz)) continue;
      c.score = s + (focusIds.has(e.id) ? 0.3 : 0);
      cands.push(c);
    }
  }
  if (kinds.includes('reminder')) {
    for (const r of state.reminders.filter((x) => x.status === 'open')) {
      const s = matchScore(keywords.join(' '), r.text);
      if (s < 0.6) continue;
      cands.push({ ref: { kind: 'reminder', id: r.id }, label: r.text, title: r.text, score: s - 0.05 + (focusIds.has(r.id) ? 0.3 : 0), start: r.dueAt ? new Date(r.dueAt) : undefined });
    }
  }
  if (kinds.includes('shopping')) {
    for (const i of state.shopping.filter((x) => x.status === 'needed')) {
      const s = matchScore(keywords.join(' '), i.name);
      if (s < 0.75) continue;
      cands.push({ ref: { kind: 'shopping', id: i.id }, label: i.name, title: i.name, score: s - 0.1 + (focusIds.has(i.id) ? 0.3 : 0) });
    }
  }
  if (!cands.length) return { status: 'none', keywords };

  // Prefer the strongest kind of match.
  const best = Math.max(...cands.map((c) => c.score));
  let top = cands.filter((c) => c.score >= best - 0.15);
  // If events match, they win over reminders/shopping with the same words.
  if (top.some((c) => c.ref.kind === 'event')) top = top.filter((c) => c.ref.kind === 'event');
  if (top.length === 1) return { status: 'found', candidate: top[0], via: 'match' };

  // A focused candidate wins outright.
  const focused = top.filter((c) => focusIds.has(c.ref.id));
  if (focused.length === 1) return { status: 'found', candidate: focused[0], via: 'focus' };

  // Weekly repeats: the next one is the obvious one unless another is within a few days.
  const timed = top.filter((c) => c.start).sort((a, b) => a.start!.getTime() - b.start!.getTime());
  if (timed.length === top.length && timed.length > 1) {
    const first = timed[0];
    const close = timed.filter((c) => c.start!.getTime() - first.start!.getTime() < 5 * 86400000);
    if (close.length === 1) return { status: 'found', candidate: first, via: 'match' };
    return { status: 'ambiguous', candidates: close.slice(0, 4) };
  }
  return { status: 'ambiguous', candidates: top.slice(0, 4) };
}

export function entityCandidate(ctx: ResolveContext, ref: Ref, allowCancelled = false): Candidate | undefined {
  const { state } = ctx;
  switch (ref.kind) {
    case 'event': {
      const e = ctx.events.find((x) => x.id === ref.id) ?? state.events.find((x) => x.id === ref.id);
      if (!e) return undefined;
      if (e.status === 'cancelled' && !allowCancelled) return undefined;
      return eventCandidate(e, state);
    }
    case 'reminder': {
      const r = state.reminders.find((x) => x.id === ref.id && x.status === 'open');
      return r ? { ref, label: r.text, title: r.text, score: 1, start: r.dueAt ? new Date(r.dueAt) : undefined } : undefined;
    }
    case 'shopping': {
      const i = state.shopping.find((x) => x.id === ref.id && x.status === 'needed');
      return i ? { ref, label: i.name, title: i.name, score: 1 } : undefined;
    }
    case 'draft': {
      const d = state.drafts.find((x) => x.id === ref.id && x.status === 'draft');
      return d ? { ref, label: 'message', title: d.body, score: 1 } : undefined;
    }
    case 'waiting': {
      const w = state.waiting.find((x) => x.id === ref.id && x.status === 'waiting');
      return w ? { ref, label: w.about, title: `${w.who} ${w.about}`, score: 1 } : undefined;
    }
    case 'memory': {
      const m = state.memories.find((x) => x.id === ref.id);
      return m ? { ref, label: m.value, title: `${m.subject} ${m.value}`, score: 1 } : undefined;
    }
    default:
      return undefined;
  }
}

/** Pick an option from a clarifying question answer: "Tuesday", "the first one", "the 9 o'clock", "both". */
export function pickOption(
  answer: string,
  when: ParsedWhen,
  candidates: Candidate[],
  tz: string,
): { picked: Candidate[] } | undefined {
  const a = answer.toLowerCase();
  if (/\b(both|all of them|all|each)\b/.test(a)) return { picked: candidates };
  if (/\b(neither|none)\b/.test(a)) return { picked: [] };
  const ordinals: [RegExp, number][] = [
    [/\b(first|former|earlier one|1st|number one|the one)\b/, 0],
    [/\b(second|latter|later one|2nd|number two)\b/, 1],
    [/\b(third|3rd|number three)\b/, 2],
    [/\blast\b/, candidates.length - 1],
  ];
  for (const [re, idx] of ordinals) {
    if (re.test(a) && candidates[idx] && !(idx === 0 && /the one (on|at)/.test(a))) return { picked: [candidates[idx]] };
  }
  const byWhen = candidates.filter((c) => c.start && (when.date || when.weekday !== undefined || when.time) && matchesWhen(c.start, when, tz));
  if (byWhen.length === 1) return { picked: byWhen };
  if (when.part) {
    const [lo, hi] = { morning: [0, 12], lunchtime: [11, 14], afternoon: [12, 17], evening: [17, 24], tonight: [17, 24], later: [12, 24] }[when.part];
    const byPart = candidates.filter((c) => c.start && zonedParts(c.start, tz).hour >= lo && zonedParts(c.start, tz).hour < hi);
    if (byPart.length === 1) return { picked: byPart };
  }
  const byTitle = candidates.map((c) => ({ c, s: matchScore(a, c.title) })).filter((x) => x.s >= 0.6);
  if (byTitle.length === 1) return { picked: [byTitle[0].c] };
  const byLabel = candidates.filter((c) => a.includes(c.label.toLowerCase()));
  if (byLabel.length === 1) return { picked: byLabel };
  return undefined;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export type PersonResolution =
  | { status: 'found'; contact: Contact }
  | { status: 'ambiguous'; contacts: Contact[] }
  | { status: 'new'; name: string };

const PRONOUNS = /^(her|him|them|she|he|they)$/;

export function resolvePerson(state: UserState, session: Session | undefined, name: string): PersonResolution {
  const n = name.trim().toLowerCase().replace(/[.,!?]$/, '');
  if (PRONOUNS.test(n)) {
    const c = session?.lastPersonId ? state.contacts.find((x) => x.id === session.lastPersonId) : undefined;
    if (c) return { status: 'found', contact: c };
    return { status: 'new', name: '' };
  }
  const full = state.contacts.filter((c) => c.name.toLowerCase() === n || c.aliases.some((a) => a.toLowerCase() === n));
  if (full.length === 1) return { status: 'found', contact: full[0] };
  const first = full.length ? full : state.contacts.filter((c) => c.name.toLowerCase().split(' ')[0] === n.split(' ')[0]);
  if (first.length === 1) return { status: 'found', contact: first[0] };
  if (first.length > 1) {
    // Conversation context: the person we were just talking about.
    if (session?.lastPersonId) {
      const recent = first.find((c) => c.id === session.lastPersonId);
      if (recent) return { status: 'found', contact: recent };
    }
    // Recent interaction history (last 14 days of ledger) as a tiebreaker only if decisive.
    const recentIds = new Map<string, number>();
    for (const l of state.ledger.slice(-200)) {
      const after = l.after as { to?: string; personId?: string; attendees?: string[] } | null;
      const ids = [after?.to, after?.personId, ...(after?.attendees ?? [])].filter(Boolean) as string[];
      for (const id of ids) recentIds.set(id, (recentIds.get(id) ?? 0) + 1);
    }
    const ranked = first.map((c) => ({ c, n: recentIds.get(c.id) ?? 0 })).sort((a, b) => b.n - a.n);
    if (ranked[0].n >= 3 && ranked[1].n === 0) return { status: 'found', contact: ranked[0].c };
    return { status: 'ambiguous', contacts: first };
  }
  return { status: 'new', name: name.trim() };
}

export function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
    .join(' ');
}

/** Words that look like a person but are not ("the dentist", "mum" is a person though). */
export function isLikelyPersonName(name: string): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  if (/^(the|my|a|an|our|your)\b/.test(n)) return false;
  if (/\b(dentist|doctor|gp|office|bank|school|council|landlord|plumber|garage|shop|company|insurance|vet|clinic|hospital|surgery|salon|gym)\b/.test(n)) return false;
  return n.split(' ').length <= 2;
}

export function upcomingWindow(now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - 2 * 3600000), to: new Date(now.getTime() + 120 * 86400000) };
}

export { addDays };
export type { Reminder, ShoppingItem };
