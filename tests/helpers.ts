import { Assistant, Reply } from '../src/core/assistant.js';
import { createUserState, grantEverydayPermissions } from '../src/core/state.js';
import { sequentialIds } from '../src/core/text.js';
import { zonedToUtc } from '../src/core/time.js';
import type { Providers } from '../src/core/providers.js';
import type { CalendarEvent, UserState } from '../src/core/types.js';

export const TZ = 'Europe/London';
/** Sunday 27 September 2026, 10:00 London time. */
export const NOW = zonedToUtc({ year: 2026, month: 9, day: 27, hour: 10, minute: 0 }, TZ);

export function at(month: number, day: number, hour: number, minute = 0, tz = TZ): Date {
  return zonedToUtc({ year: 2026, month, day, hour, minute }, tz);
}

export interface Harness {
  a: Assistant;
  state: UserState;
  clock: { now: Date };
  sessionId?: string;
  replies: Reply[];
  say(text: string, opts?: { clientId?: string; capturedAt?: string }): Promise<Reply>;
  advance(minutes: number): void;
  event(title: string, start: Date, opts?: Partial<CalendarEvent>): CalendarEvent;
  contact(name: string, extra?: Record<string, unknown>): string;
  newSession(): void;
}

export function setup(opts: { providers?: Partial<Providers>; onboarded?: boolean; permissions?: boolean; now?: Date } = {}): Harness {
  const clock = { now: opts.now ?? NOW };
  const state = createUserState('user_1', TZ, clock.now);
  if (opts.onboarded !== false) {
    state.profile.assistantName = 'Milo';
    state.profile.onboarding = 'done';
    if (opts.permissions !== false) grantEverydayPermissions(state, 'test', clock.now);
  }
  const ids = sequentialIds();
  const a = new Assistant(state, { clock: () => clock.now, ids, providers: opts.providers });
  const h: Harness = {
    a,
    state,
    clock,
    replies: [],
    async say(text, o = {}) {
      const r = await a.handle({ text, sessionId: h.sessionId, ...o });
      h.sessionId = r.sessionEnded ? undefined : r.sessionId;
      h.replies.push(r);
      return r;
    },
    advance(minutes) {
      clock.now = new Date(clock.now.getTime() + minutes * 60000);
    },
    event(title, start, extra = {}) {
      const e: CalendarEvent = {
        id: ids('evt'), title, start: start.toISOString(), end: new Date(start.getTime() + 3600000).toISOString(), timeZone: TZ,
        attendees: [], status: 'confirmed', source: 'local', createdAt: clock.now.toISOString(), updatedAt: clock.now.toISOString(), ...extra,
      };
      state.events.push(e);
      return e;
    },
    contact(name, extra = {}) {
      const id = ids('person');
      state.contacts.push({ id, name, aliases: [], source: 'told', createdAt: clock.now.toISOString(), ...extra });
      return id;
    },
    newSession() {
      h.sessionId = undefined;
    },
  };
  return h;
}

export function confirmationsAsked(h: Harness): number {
  return h.state.sessions.flatMap((s) => s.turns).filter((t) => t.role === 'assistant' && /are you sure|shall i go ahead|\?\s*$/i.test(t.text) && /^(Cancel|Are you sure|Shall)/i.test(t.text)).length;
}
