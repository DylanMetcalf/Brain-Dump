// The Assistant orchestrator.
// USER INPUT → INTERPRETATION → CONTEXT RESOLUTION → ACTION PLAN → RISK EVALUATION →
// PERMISSION CHECK → EXECUTION → VERIFICATION → STATE UPDATE → USER RESPONSE
//
// Design rules enforced here:
//  • act when intent + target are clear and policy allows; ask ONE short question otherwise
//  • inspect existing state before creating anything new
//  • never claim an action that was not verified
//  • optional questions are dropped when the user moves on; blockers are kept

import { analyseBehaviour, pickProactive } from './behaviour.js';
import { handledSummary, needsMe, needsMeText, scheduleSummary, weeklyBriefing, WEEKLY_PROMPTS } from './briefing.js';
import { ActionPlan, ExecResult, Executor, metaFor } from './executor.js';
import { interpret, isNo, isYes, Thought, toSecondPerson } from './interpret.js';
import { decide } from './policy.js';
import { localProviders, Providers } from './providers.js';
import {
  Candidate, entityCandidate, isLikelyPersonName, optionLabel, pickOption, resolvePerson, resolveTarget, ResolveContext, titleCaseName,
  upcomingWindow,
} from './resolve.js';
import { grantEverydayPermissions, grantPermission, hasPermission, recordConfirmation, SCOPE_LABELS, setTrust } from './state.js';
import { capitalize, contentTokens, IdGen, listJoin, lower, matchScore, randomId, sameItem } from './text.js';
import {
  addDays, cityToTimeZone, formatClock, formatDay, formatWhen, ParsedWhen, parseWhen, resolveInstant, sameLocalDay, startOfLocalDay, zonedParts,
  zonedToUtc,
} from './time.js';
import type {
  CalendarEvent, Contact, Draft, LedgerEntry, PendingQuestion, PermissionLevel, QuestionOption, Ref, Scope, Session, UserState,
} from './types.js';

export interface HandleRequest {
  text: string;
  sessionId?: string;
  /** Idempotency key: the same clientId is never processed twice (offline replay). */
  clientId?: string;
  /** When the thought was captured (offline capture replays use this for "tomorrow" etc.). */
  capturedAt?: string;
  now?: Date;
  device?: string;
}

export interface Reply {
  sessionId: string;
  text: string;
  question?: { id: string; text: string; options?: QuestionOption[] };
  sessionEnded: boolean;
  /** Nothing is waiting on the user: a voice UI may close after a short silence. */
  settled: boolean;
  actions: { id: string; summary: string; undoable: boolean }[];
  links: { label: string; url: string }[];
  version: number;
}

export const SESSION_IDLE_MS = 10 * 60000;
const DEFAULT_EVENT_MIN = 60;

interface Out {
  lines: string[];
  links: { label: string; url: string }[];
  actions: LedgerEntry[];
  ended: boolean;
}

interface TurnCtx {
  session: Session;
  now: Date;
  tz: string;
  out: Out;
  events: CalendarEvent[];
}

interface RunOpts {
  done?: string;
  confirmText?: string;
  confirmOptions?: QuestionOption[];
  declineText?: string;
  needText?: string;
  /** The user explicitly asked for this exact action ("send it"), which counts as confirmation for medium risk. */
  userConfirmed?: boolean;
  after?: AfterSpec;
  quiet?: boolean;
}

type AfterSpec =
  | { kind: 'offer_reschedule'; eventId: string; title: string }
  | { kind: 'send_drafts'; draftIds: string[] }
  | { kind: 'say'; text: string };

type Intent =
  | { type: 'meeting'; people: string[]; provider?: string; date?: { year: number; month: number; day: number }; time?: { hour: number; minute: number; ambiguous: boolean; hour12?: number }; zone?: string; statedAs: string }
  | { type: 'activity'; activity: string }
  | { type: 'event'; title: string; date?: { year: number; month: number; day: number } }
  | { type: 'reschedule'; eventId: string }
  | { type: 'event_from_reminder'; title: string; date: { year: number; month: number; day: number }; reminderId: string }
  | { type: 'communicate'; contactId: string; channel: 'email' | 'message'; reminderId?: string }
  | { type: 'booking'; service: string }
  | { type: 'cancel_target' }
  | { type: 'person_for'; thought: Thought };

export class Assistant {
  readonly providers: Providers;
  readonly exec: Executor;
  readonly clock: () => Date;
  readonly ids: IdGen;

  constructor(public state: UserState, opts: { providers?: Partial<Providers>; clock?: () => Date; ids?: IdGen } = {}) {
    this.clock = opts.clock ?? (() => new Date());
    this.ids = opts.ids ?? randomId;
    this.providers = { ...localProviders(() => this.state, this.ids, this.clock), ...(opts.providers ?? {}) } as Providers;
    this.exec = new Executor({ state: () => this.state, providers: this.providers, ids: this.ids, clock: this.clock });
  }

  get tz(): string {
    return this.state.profile.timeZone;
  }

  get name(): string {
    return this.state.profile.assistantName ?? 'your assistant';
  }

  // =========================================================================
  // Sessions
  // =========================================================================

  getSession(id: string | undefined, now: Date, device?: string): Session {
    let s = id ? this.state.sessions.find((x) => x.id === id) : undefined;
    if (s && !s.endedAt && now.getTime() - Date.parse(s.lastActivityAt) > SESSION_IDLE_MS) this.closeSession(s, now);
    if (!s || s.endedAt) {
      const prev = s;
      s = {
        id: this.ids('ses'),
        startedAt: now.toISOString(),
        lastActivityAt: now.toISOString(),
        device,
        turns: [],
        focus: prev ? prev.focus.slice(0, 3) : [],
        lastPersonId: prev?.lastPersonId,
        pending: [],
        ledgerIds: [],
      };
      this.state.sessions.push(s);
      if (this.state.sessions.length > 60) this.state.sessions.splice(0, this.state.sessions.length - 60);
    }
    return s;
  }

  /** Close idle sessions: optional questions are dropped, blockers stay visible in "what needs me". */
  closeSession(s: Session, now: Date): void {
    s.pending = s.pending.filter((q) => !q.optional && q.asked && q.kind !== 'briefing' && q.kind !== 'onboarding');
    s.endedAt = now.toISOString();
  }

  expireIdleSessions(now: Date): number {
    let n = 0;
    for (const s of this.state.sessions) {
      if (!s.endedAt && now.getTime() - Date.parse(s.lastActivityAt) > SESSION_IDLE_MS) {
        this.closeSession(s, now);
        n++;
      }
    }
    return n;
  }

  /** Start (or resume) a conversation. Used by the widget tap. */
  async start(opts: { sessionId?: string; now?: Date; device?: string } = {}): Promise<Reply> {
    const now = opts.now ?? this.clock();
    const session = this.getSession(opts.sessionId, now, opts.device);
    const t = await this.turn(session, now);
    if (this.state.profile.onboarding === 'name') {
      if (!session.pending.some((q) => q.kind === 'onboarding')) {
        t.out.lines.push("Hi! I'm here to take things off your mind.");
        this.askOnboardingName(t);
      }
    } else if (this.state.profile.onboarding === 'permissions') {
      if (!session.pending.some((q) => q.kind === 'onboarding')) this.askOnboardingPermissions(t);
    }
    return this.finish(t, undefined, !session.turns.length && this.state.profile.onboarding === 'done' ? "What's on your mind?" : undefined);
  }

  async end(sessionId: string, now = this.clock()): Promise<Reply> {
    return this.handle({ text: "that's all", sessionId, now });
  }

  // =========================================================================
  // Main entry
  // =========================================================================

  async handle(req: HandleRequest): Promise<Reply> {
    if (req.clientId) {
      const done = this.state.processed.find((p) => p.clientId === req.clientId);
      if (done) return done.reply as Reply;
    }
    const now = req.capturedAt ? new Date(req.capturedAt) : req.now ?? this.clock();
    const session = this.getSession(req.sessionId, req.now ?? now, req.device);
    const t = await this.turn(session, now);
    const text = (req.text ?? '').slice(0, 2000);
    session.turns.push({ at: now.toISOString(), role: 'user', text });
    session.lastActivityAt = (req.now ?? now).toISOString();

    const interp = interpret(text, {
      now,
      timeZone: this.tz,
      assistantName: this.state.profile.assistantName,
      nameAliases: this.state.profile.nameAliases,
    });
    const thoughts = interp.thoughts;

    if (this.state.profile.onboarding === 'name' && !session.pending.some((q) => q.kind === 'onboarding')) {
      if (!thoughts.length || /^(hi|hello|hey|start|begin)\b/i.test(text.trim())) {
        t.out.lines.push("Hi! I'm here to take things off your mind.");
        this.askOnboardingName(t);
        return this.finish(t, req);
      }
      this.askOnboardingName(t, false);
    }

    if (!thoughts.length) {
      t.out.lines.push(interp.addressedByName ? 'Yes?' : "Sorry, I didn't catch that.");
      return this.finish(t, req);
    }

    let idx = 0;
    while (idx < thoughts.length) {
      const q = this.activeQuestion(session);
      if (!q) break;
      const consumed = await this.tryAnswer(q, thoughts[idx], t);
      if (!consumed) break;
      idx++;
    }
    if (idx < thoughts.length) this.dropStaleOptional(session, thoughts[idx]);
    for (; idx < thoughts.length; idx++) {
      await this.handleThought(thoughts[idx], t);
      if (t.out.ended) break;
    }
    return this.finish(t, req);
  }

  private async turn(session: Session, now: Date): Promise<TurnCtx> {
    this.exec.batchId = this.ids('batch');
    return { session, now, tz: this.tz, out: { lines: [], links: [], actions: [], ended: false }, events: await this.loadEvents(now) };
  }

  private async loadEvents(now: Date): Promise<CalendarEvent[]> {
    const w = upcomingWindow(now);
    try {
      return await this.providers.calendar.list(w.from, w.to);
    } catch {
      return this.state.events.filter((e) => e.status === 'confirmed');
    }
  }

  private async refresh(t: TurnCtx) {
    t.events = await this.loadEvents(t.now);
  }

  private finish(t: TurnCtx, req?: HandleRequest, fallback?: string): Reply {
    const s = t.session;
    let q: PendingQuestion | undefined;
    if (!t.out.ended) {
      q = s.pending.find((p) => !p.asked);
      if (q) {
        q.asked = true;
        q.askedAt = t.now.toISOString();
      }
    }
    let text = t.out.lines.filter(Boolean).join(' ');
    if (q) text = text ? `${text} ${q.text}` : q.text;
    if (!text) text = fallback ?? (t.out.actions.length ? 'Done.' : 'Got it.');
    s.turns.push({ at: t.now.toISOString(), role: 'assistant', text });
    if (s.turns.length > 120) s.turns.splice(0, s.turns.length - 120);
    this.state.version += 1;
    const reply: Reply = {
      sessionId: s.id,
      text,
      question: q ? { id: q.id, text: q.text, options: q.options } : undefined,
      sessionEnded: t.out.ended,
      settled: !q && !this.activeQuestion(s),
      actions: t.out.actions.map((a) => ({ id: a.id, summary: a.summary, undoable: a.undoable && !a.undoneAt })),
      links: t.out.links,
      version: this.state.version,
    };
    if (req?.clientId) {
      this.state.processed.push({ clientId: req.clientId, at: t.now.toISOString(), reply });
      if (this.state.processed.length > 500) this.state.processed.splice(0, this.state.processed.length - 500);
    }
    return reply;
  }

  // =========================================================================
  // Questions
  // =========================================================================

  activeQuestion(s: Session): PendingQuestion | undefined {
    for (let i = s.pending.length - 1; i >= 0; i--) if (s.pending[i].asked) return s.pending[i];
    return undefined;
  }

  private ask(t: TurnCtx, q: Omit<PendingQuestion, 'id' | 'askedAt' | 'asked'>): PendingQuestion {
    const pq: PendingQuestion = { ...q, id: this.ids('q'), askedAt: t.now.toISOString(), asked: false };
    t.session.pending.push(pq);
    return pq;
  }

  private removeQuestion(s: Session, q: PendingQuestion) {
    s.pending = s.pending.filter((x) => x.id !== q.id);
  }

  /** The user moved on: optional questions they ignored are dropped (the underlying reminder stays). */
  private dropStaleOptional(s: Session, next: Thought) {
    if (next.kind === 'yes' || next.kind === 'no') return;
    s.pending = s.pending.filter((q) => !(q.asked && q.optional && q.kind !== 'briefing'));
  }

  private async tryAnswer(q: PendingQuestion, th: Thought, t: TurnCtx): Promise<boolean> {
    const raw = th.raw;
    const optionValue = raw.startsWith('option:') ? raw.slice(7) : undefined;
    const yes = th.kind === 'yes' || th.kind === 'send' || (optionValue === 'yes');
    const no = th.kind === 'no' || optionValue === 'no';

    switch (q.kind) {
      case 'onboarding':
        return this.answerOnboarding(q, th, t);

      case 'confirm_action': {
        if (yes) {
          this.removeQuestion(t.session, q);
          const plan = q.data.plan as ActionPlan;
          recordConfirmation(this.state, metaFor(plan, this.state).actionType, true, t.now);
          await this.runPlan(plan, t, { ...(q.data.opts as RunOpts), userConfirmed: true, forceExecute: true } as RunOpts & { forceExecute: boolean });
          return true;
        }
        if (no) {
          this.removeQuestion(t.session, q);
          const plan = q.data.plan as ActionPlan;
          if (!q.optional) recordConfirmation(this.state, metaFor(plan, this.state).actionType, false, t.now);
          t.out.lines.push(q.data.opts?.declineText ?? "OK, I won't.");
          return true;
        }
        // "Change it to …" while confirming a message.
        const plan = q.data.plan as ActionPlan;
        if (plan.type === 'message.send' && (th.kind === 'communicate' || /^(?:change|edit|make) it (?:to |say )?/i.test(raw) || /^(?:say|tell (?:her|him|them)) /i.test(raw))) {
          const body = th.kind === 'communicate' && th.body ? th.body : toSecondPerson(raw.replace(/^(?:change|edit|make) it (?:to |say )?/i, ''));
          const d = this.state.drafts.find((x) => x.id === plan.draftId);
          if (d && body) {
            d.body = body;
            d.updatedAt = t.now.toISOString();
            const c = this.state.contacts.find((x) => x.id === d.to);
            if (c) d.handoffUrl = this.providers.messaging.handoffUrl(d, c);
            q.text = `Send to ${c?.name ?? 'them'}: “${body}”?`;
            q.asked = false;
            return true;
          }
        }
        return false;
      }

      case 'grant_permission': {
        if (yes || (optionValue && optionValue !== 'no' && optionValue !== 'draft')) {
          this.removeQuestion(t.session, q);
          const scope = q.data.scope as Scope;
          const level = q.data.level as PermissionLevel;
          if (q.data.everyday) grantEverydayPermissions(this.state, 'conversation', t.now);
          grantPermission(this.state, scope, level, 'conversation', t.now);
          await this.runPlan(q.data.plan as ActionPlan, t, (q.data.opts ?? {}) as RunOpts);
          return true;
        }
        if (no || optionValue === 'draft') {
          this.removeQuestion(t.session, q);
          t.out.lines.push(q.data.declineText ?? `OK — I'll leave ${SCOPE_LABELS[q.data.scope as Scope]} alone.`);
          if (q.data.fallbackLink) t.out.links.push(q.data.fallbackLink);
          return true;
        }
        return false;
      }

      case 'clarify_target': {
        if (no && !/^no[, ]/i.test(raw)) {
          this.removeQuestion(t.session, q);
          t.out.lines.push("OK, I'll leave them as they are.");
          return true;
        }
        const cands = (q.data.candidates as SerialCandidate[]).map(deserialiseCandidate);
        let picked: Candidate[] | undefined;
        if (optionValue) picked = cands.filter((c) => c.ref.id === optionValue);
        else {
          const when = parseWhen(raw, t.now, t.tz, { answerMode: true });
          picked = pickOption(raw, when, cands, t.tz)?.picked;
        }
        if (!picked) return false;
        this.removeQuestion(t.session, q);
        if (!picked.length) {
          t.out.lines.push("OK, I'll leave them as they are.");
          return true;
        }
        for (const c of picked) await this.applyToCandidate(q.data.action, c, q.data.payload ?? {}, t);
        return true;
      }

      case 'offer_reschedule': {
        if (no) {
          this.removeQuestion(t.session, q);
          t.out.lines.push('OK.');
          return true;
        }
        const eventId = q.data.eventId as string;
        if (th.kind === 'modify' || (th.kind === 'yes' && false)) {
          this.removeQuestion(t.session, q);
          await this.rescheduleEvent(eventId, th.kind === 'modify' ? th.when : undefined, t);
          return true;
        }
        const when = parseWhen(raw, t.now, t.tz, { answerMode: true });
        if ((when.date || when.time || when.span || when.relativeMs) && th.kind !== 'cancel' && th.kind !== 'event_add') {
          this.removeQuestion(t.session, q);
          await this.rescheduleEvent(eventId, when, t);
          return true;
        }
        if (yes) {
          this.removeQuestion(t.session, q);
          this.ask(t, { kind: 'fill_slot', text: 'When would you like it?', optional: true, data: { slot: 'when', intent: { type: 'reschedule', eventId } } });
          return true;
        }
        return false;
      }

      case 'fill_slot':
        return this.answerSlot(q, th, t);

      case 'suggestion': {
        if (yes) {
          this.removeQuestion(t.session, q);
          await this.acceptSuggestion(q, t);
          return true;
        }
        if (no) {
          this.removeQuestion(t.session, q);
          this.declineSuggestion(q, t);
          return true;
        }
        return false;
      }

      case 'briefing': {
        this.removeQuestion(t.session, q);
        const step = Number(q.data.step ?? 0);
        const nothing = no || /^(?:nothing|not really|nope|no|nah|that'?s it|all good|i'?m good)\b/i.test(raw) || th.kind === 'end';
        if (th.kind === 'end') {
          await this.handleThought(th, t);
          return true;
        }
        if (!nothing) await this.handleThought(th, t);
        if (step === 2 && !nothing) {
          // "Anything I can make easier?" answered with something → treat as friction request too.
        }
        if (step + 1 < WEEKLY_PROMPTS.length) {
          this.ask(t, { kind: 'briefing', text: WEEKLY_PROMPTS[step + 1], optional: true, data: { step: step + 1 } });
        } else {
          t.out.lines.push("That's the week sorted.");
        }
        return true;
      }
    }
    return false;
  }

  private async answerSlot(q: PendingQuestion, th: Thought, t: TurnCtx): Promise<boolean> {
    const raw = th.raw;
    const slot = q.data.slot as string;
    const intent = q.data.intent as Intent;
    if (th.kind === 'no' && slot !== 'zone') {
      this.removeQuestion(t.session, q);
      t.out.lines.push(intent.type === 'communicate' ? "OK — it's on your list for later." : 'OK.');
      return true;
    }
    if (th.kind === 'end') return false;

    if (slot === 'when' || slot === 'date' || slot === 'time') {
      const when = parseWhen(raw, t.now, t.tz, { answerMode: true });
      if (!(when.date || when.time || when.span || when.relativeMs !== undefined || when.part)) return false;
      if (['cancel', 'shopping_add', 'shopping_got', 'meeting', 'query', 'communicate'].includes(th.kind) && !/^\s*(?:at|on|about|around)?\s*[\w:]+\s*$/.test(raw)) return false;
      this.removeQuestion(t.session, q);
      await this.continueIntent(intent, t, when);
      return true;
    }
    if (slot === 'zone' && intent.type === 'meeting') {
      const a = lower(raw);
      let zone: string | undefined;
      if (/\b(my|mine|me|your|local|here)\b/.test(a)) zone = this.tz;
      else {
        const other = intent.people.map((id) => this.state.contacts.find((c) => c.id === id)).find((c) => c?.timeZone);
        if (/\b(his|hers|her|their|theirs|them)\b/.test(a) || (other && a.includes(other.name.toLowerCase().split(' ')[0]))) zone = other?.timeZone;
        else {
          const city = cityToTimeZone(a.replace(/\btime\b/, '').trim());
          if (city) zone = city;
        }
      }
      if (!zone) return false;
      this.removeQuestion(t.session, q);
      intent.zone = zone;
      await this.continueMeeting(intent, t);
      return true;
    }
    if (slot === 'body' && intent.type === 'communicate') {
      if (['cancel', 'shopping_add', 'shopping_got', 'shopping_remove', 'meeting', 'query', 'event_add', 'booking', 'undo', 'waiting', 'modify', 'recall', 'activity', 'weekly', 'friction'].includes(th.kind)) return false;
      if (th.kind === 'reminder' && /^remind me\b/i.test(raw)) return false;
      const body = th.kind === 'communicate' && th.body ? th.body : toSecondPerson(raw);
      if (!body || body.length < 2) return false;
      this.removeQuestion(t.session, q);
      await this.draftMessage(intent.contactId, intent.channel, body, t, intent.reminderId);
      return true;
    }
    if (slot === 'person' && intent.type === 'person_for') {
      const name = raw.replace(/^(?:to |it'?s |for )/i, '').trim();
      if (!name || name.split(' ').length > 3) return false;
      this.removeQuestion(t.session, q);
      const th2 = { ...intent.thought, personName: name } as Thought;
      await this.handleThought(th2, t);
      return true;
    }
    if (slot === 'target') {
      if (th.kind !== 'note' && th.kind !== 'cancel' && th.kind !== 'recall') return false;
      this.removeQuestion(t.session, q);
      const phrase = th.kind === 'cancel' || th.kind === 'recall' ? th.phrase : raw;
      await this.handleThought({ kind: 'cancel', raw, phrase, when: parseWhen(phrase, t.now, t.tz) }, t);
      return true;
    }
    if (slot === 'booking_slot') {
      const slots = q.data.slots as { id: string; start: string; end: string; label: string }[];
      const when = parseWhen(raw, t.now, t.tz, { answerMode: true });
      const cands: Candidate[] = slots.map((s) => ({ ref: { kind: 'event', id: s.id }, label: s.label, title: s.label, score: 1, start: new Date(s.start) }));
      const opt = raw.startsWith('option:') ? cands.filter((c) => c.ref.id === raw.slice(7)) : pickOption(raw, when, cands, t.tz)?.picked;
      if (!opt || opt.length !== 1) return false;
      this.removeQuestion(t.session, q);
      const s = slots.find((x) => x.id === opt[0].ref.id)!;
      await this.bookSlot(q.data.serviceId, q.data.service, s, q.data.price, t);
      return true;
    }
    return false;
  }

  // =========================================================================
  // Onboarding
  // =========================================================================

  private askOnboardingName(t: TurnCtx, _immediate = true) {
    this.ask(t, { kind: 'onboarding', text: 'What would you like to call me?', optional: false, data: { step: 'name', needText: 'Choose a name for me.' } });
  }

  private askOnboardingPermissions(t: TurnCtx) {
    this.ask(t, {
      kind: 'onboarding',
      text: "Would you like me to manage your calendar, reminders and shopping list? I'll handle everyday changes without asking each time, and always check with you before anything involving money or other people.",
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'Not now', value: 'no' },
      ],
      optional: false,
      data: { step: 'permissions' },
    });
  }

  private async answerOnboarding(q: PendingQuestion, th: Thought, t: TurnCtx): Promise<boolean> {
    if (q.data.step === 'name') {
      const name = th.kind === 'rename' ? th.name : extractName(th.raw);
      if (!name) {
        q.asked = false; // re-ask after handling whatever they said
        return false;
      }
      this.removeQuestion(t.session, q);
      this.setAssistantName(name, t);
      t.out.lines.push(`${name} it is.`);
      this.state.profile.onboarding = 'permissions';
      this.askOnboardingPermissions(t);
      return true;
    }
    if (q.data.step === 'permissions') {
      const yes = th.kind === 'yes' || th.raw === 'option:yes';
      const no = th.kind === 'no' || th.raw === 'option:no';
      if (!yes && !no) {
        q.asked = false;
        return false;
      }
      this.removeQuestion(t.session, q);
      this.state.profile.onboarding = 'done';
      if (yes) {
        grantEverydayPermissions(this.state, 'onboarding', t.now);
        t.out.lines.push("Great — I'm all set. What's on your mind?");
      } else {
        t.out.lines.push("No problem — I'll ask before touching anything. What's on your mind?");
      }
      return true;
    }
    return false;
  }

  private setAssistantName(name: string, t: TurnCtx) {
    const prev = this.state.profile.assistantName;
    this.state.profile.assistantName = name;
    if (prev && prev.toLowerCase() !== name.toLowerCase()) this.state.profile.nameAliases = [];
    const existing = this.state.memories.find((m) => m.kind === 'identity' && m.subject === 'assistant name');
    if (existing) {
      existing.value = name;
      existing.lastObservedAt = t.now.toISOString();
    } else {
      this.state.memories.push({
        id: this.ids('mem'), kind: 'identity', subject: 'assistant name', value: name, provenance: 'told', source: 'conversation', confidence: 1,
        learnedAt: t.now.toISOString(), observationCount: 1, lastObservedAt: t.now.toISOString(), confirmed: true, automationAllowed: false,
      });
    }
  }

  // =========================================================================
  // Plans
  // =========================================================================

  private async runPlan(plan: ActionPlan, t: TurnCtx, o: RunOpts & { forceExecute?: boolean } = {}): Promise<'done' | 'asked' | 'failed'> {
    const meta = metaFor(plan, this.state);
    const d = decide(this.state, meta);
    if (d.kind === 'grant') {
      this.askGrant(plan, meta.scope, d.level, t, o);
      return 'asked';
    }
    if (d.kind === 'refuse') {
      t.out.lines.push("I can't do that.");
      return 'failed';
    }
    const confirmed = o.forceExecute || (o.userConfirmed && d.risk !== 'high');
    if (d.kind === 'confirm' && !confirmed) {
      this.ask(t, {
        kind: 'confirm_action',
        text: o.confirmText ?? 'Shall I go ahead?',
        options: o.confirmOptions ?? [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
        optional: false,
        data: { plan, opts: stripOpts(o), needText: o.needText ?? o.confirmText },
      });
      return 'asked';
    }
    const res = await this.exec.execute(plan, { auto: d.kind === 'execute' ? d.auto : false, risk: d.risk, sessionId: t.session.id });
    this.recordResult(res, t);
    if (!res.ok) {
      t.out.lines.push(this.failureText(plan, res));
      return 'failed';
    }
    if (o.done && !o.quiet) t.out.lines.push(o.done);
    if (o.after) await this.applyAfter(o.after, t);
    if (plan.type.startsWith('calendar.') || plan.type === 'booking.create') await this.refresh(t);
    return 'done';
  }

  private recordResult(res: ExecResult, t: TurnCtx) {
    for (const e of res.entries) {
      t.session.ledgerIds.push(e.id);
      t.out.actions.push(e);
    }
    for (const r of [...res.refs].reverse()) this.focus(t, r);
  }

  private failureText(plan: ActionPlan, res: ExecResult): string {
    if (res.error === 'cannot-send') return "I can't send that directly yet — it's ready for you to send.";
    if (plan.type.startsWith('calendar.')) return "I couldn't update your calendar just now — I'll keep it on your list so nothing's lost.";
    return `That didn't work${res.error ? ` (${res.error})` : ''} — nothing was changed.`;
  }

  private askGrant(plan: ActionPlan, scope: Scope, level: PermissionLevel, t: TurnCtx, o: RunOpts) {
    const everyday = ['calendar', 'reminders', 'shopping', 'notes', 'memory', 'contacts'].includes(scope);
    let text: string;
    let options: QuestionOption[] = [
      { label: 'Yes', value: 'yes' },
      { label: 'Not now', value: 'no' },
    ];
    let declineText: string | undefined;
    if (everyday) {
      text = scope === 'calendar'
        ? "Would you like me to manage your calendar? I'll handle everyday changes like this without asking each time."
        : `Would you like me to look after ${SCOPE_LABELS[scope]}? I'll handle everyday changes without asking each time.`;
    } else if (scope === 'messaging' || scope === 'email') {
      text = `Want me to send ${scope === 'email' ? 'emails' : 'messages'} for you, or just draft them?`;
      options = [
        { label: 'Send for me', value: 'yes' },
        { label: 'Just draft', value: 'draft' },
      ];
      declineText = "OK — I'll keep drafting them for you to send.";
    } else if (scope === 'purchases') {
      text = "Want me to be able to buy things for you? I'll always confirm the price with you first.";
    } else if (scope === 'bookings') {
      text = "Want me to make bookings for you? I'll always check with you before anything that costs money.";
    } else {
      text = `Would you like me to manage ${SCOPE_LABELS[scope]}?`;
    }
    this.ask(t, {
      kind: 'grant_permission',
      text,
      options,
      optional: false,
      data: { plan, scope, level, everyday, opts: stripOpts(o), declineText, needText: text },
    });
  }

  private async applyAfter(a: AfterSpec, t: TurnCtx) {
    if (a.kind === 'say') t.out.lines.push(a.text);
    if (a.kind === 'offer_reschedule') {
      this.ask(t, {
        kind: 'offer_reschedule',
        text: 'Do you want to reschedule it?',
        options: [
          { label: 'Reschedule', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
        optional: true,
        data: { eventId: a.eventId, title: a.title },
      });
    }
  }

  private focus(t: TurnCtx, ref: Ref) {
    t.session.focus = [ref, ...t.session.focus.filter((f) => f.id !== ref.id)].slice(0, 12);
    if (ref.kind === 'contact') t.session.lastPersonId = ref.id;
  }

  // =========================================================================
  // Thought handlers
  // =========================================================================

  async handleThought(th: Thought, t: TurnCtx): Promise<void> {
    switch (th.kind) {
      case 'end':
        return this.endConversation(t);
      case 'yes':
      case 'no':
        if (!t.out.lines.length) t.out.lines.push('OK.');
        return;
      case 'filler':
        return;
      case 'shopping_add':
        return this.onShoppingAdd(th, t);
      case 'shopping_got':
        return this.onShoppingGot(th, t);
      case 'shopping_remove':
        return this.onShoppingRemove(th, t);
      case 'cancel':
        return this.onCancel(th, t);
      case 'modify':
        return this.onModify(th, t);
      case 'undo':
        return this.onUndo(t);
      case 'send':
        return this.onSend(t);
      case 'done':
        return this.onDone(th, t);
      case 'event_add':
        return this.onEventAdd(th, t);
      case 'reminder':
        return this.onReminder(th, t);
      case 'recall':
        return this.onRecall(th, t);
      case 'communicate':
        return this.onCommunicate(th, t);
      case 'meeting':
        return this.onMeeting(th, t);
      case 'booking':
        return this.onBooking(th, t);
      case 'purchase':
        return this.onPurchase(th, t);
      case 'waiting':
        return this.onWaiting(th, t);
      case 'replied':
        return this.onReplied(th.personName, t);
      case 'query':
        return this.onQuery(th, t);
      case 'friction':
        return this.onFriction(t);
      case 'weekly':
        return this.onWeekly(t);
      case 'activity':
        return this.onActivity(th, t);
      case 'rename':
        this.setAssistantName(th.name, t);
        if (this.state.profile.onboarding === 'name') {
          this.state.profile.onboarding = 'permissions';
          t.session.pending = t.session.pending.filter((q) => !(q.kind === 'onboarding' && q.data.step === 'name'));
          this.askOnboardingPermissions(t);
        }
        t.out.lines.push(`${th.name} it is.`);
        return;
      case 'contact_fact':
        return this.onContactFact(th, t);
      case 'user_fact':
        return this.onUserFact(th, t);
      case 'remember_fact':
        return this.onRememberFact(th, t);
      case 'forget':
        return this.onForget(th, t);
      case 'trust':
        return this.onTrust(th, t);
      case 'email_clear':
        return this.onEmailClear(th, t);
      case 'meeting_link':
        this.state.profile.preferences.personalMeetingLink = { provider: th.provider, url: th.url };
        t.out.lines.push(`Got it — I'll use that ${th.provider === 'meet' ? 'Google Meet' : capitalize(th.provider)} link for your meetings.`);
        return;
      case 'note':
        return this.onNote(th, t);
    }
  }

  // ---- ending ---------------------------------------------------------------

  private endConversation(t: TurnCtx) {
    const s = t.session;
    const blockers = s.pending.filter((q) => !q.optional && q.kind !== 'briefing' && q.kind !== 'onboarding');
    s.pending = blockers.map((q) => ({ ...q, asked: true }));
    let text = "Got it. I've sorted everything I could.";
    if (blockers.length) {
      const needs = blockers.map((q) => q.data.needText ?? q.text);
      text += blockers.length === 1 ? ` One thing still needs you: ${needs[0]}` : ` ${blockers.length} things still need you: ${needs.join(' ')}`;
    }
    text += " I'll let you know if anything needs you.";
    t.out.lines.push(text);
    s.endedAt = t.now.toISOString();
    t.out.ended = true;
  }

  // ---- shopping -------------------------------------------------------------

  private async onShoppingAdd(th: Extract<Thought, { kind: 'shopping_add' }>, t: TurnCtx) {
    const needed = this.state.shopping.filter((s) => s.status === 'needed');
    const toAdd: { name: string; quantity?: number }[] = [];
    const already: string[] = [];
    for (const it of th.items) {
      const ex = needed.find((n) => sameItem(n.name, it.name));
      if (ex) {
        if (it.quantity && ex.quantity !== it.quantity) {
          await this.runPlan({ type: 'shopping.update', id: ex.id, quantity: it.quantity }, t, { done: `Updated ${ex.name} to ${it.quantity}.` });
        } else already.push(ex.name);
      } else if (!toAdd.some((x) => sameItem(x.name, it.name))) toAdd.push(it);
    }
    if (toAdd.length) {
      const names = toAdd.map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name));
      await this.runPlan({ type: 'shopping.add', items: toAdd }, t, { done: `Added ${listJoin(names)}.` });
    }
    if (already.length) t.out.lines.push(`${capitalize(listJoin(already))} ${already.length > 1 ? 'are' : 'is'} already on your list.`);
  }

  private findShopping(name: string) {
    const needed = this.state.shopping.filter((s) => s.status === 'needed');
    return needed.find((n) => sameItem(n.name, name)) ?? needed.find((n) => matchScore(name, n.name) >= 0.75 || matchScore(n.name, name) >= 0.75);
  }

  private async onShoppingGot(th: Extract<Thought, { kind: 'shopping_got' }>, t: TurnCtx) {
    const ids: string[] = [];
    const names: string[] = [];
    const unmatched: string[] = [];
    for (const n of th.items) {
      const item = this.findShopping(n);
      if (item && !ids.includes(item.id)) {
        ids.push(item.id);
        names.push(item.name);
        continue;
      }
      const r = this.state.reminders.find((x) => x.status === 'open' && matchScore(n, x.text) >= 0.7);
      if (r) {
        await this.runPlan({ type: 'reminder.complete', id: r.id }, t, { done: `Nice — ticked off “${r.text}”.` });
        continue;
      }
      unmatched.push(n);
    }
    // "I got the milk" when only generic "groceries" was listed.
    if (ids.length) await this.runPlan({ type: 'shopping.complete', ids }, t, { done: `Ticked off ${listJoin(names)}.` });
    if (unmatched.length && !ids.length) {
      const generic = this.state.shopping.find((s) => s.status === 'needed' && /^(groceries|grocery|shopping)$/.test(s.name));
      if (generic && unmatched.some((u) => /groceries|shopping|food/.test(u))) {
        await this.runPlan({ type: 'shopping.complete', ids: [generic.id] }, t, { done: 'Ticked off the groceries.' });
      } else t.out.lines.push(`${capitalize(listJoin(unmatched))} wasn't on your list, so nothing to tick off.`);
    }
  }

  private async onShoppingRemove(th: Extract<Thought, { kind: 'shopping_remove' }>, t: TurnCtx) {
    const ids: string[] = [];
    const names: string[] = [];
    const missing: string[] = [];
    for (const n of th.items) {
      const item = this.findShopping(n);
      if (item) {
        ids.push(item.id);
        names.push(item.name);
      } else missing.push(n);
    }
    if (ids.length) await this.runPlan({ type: 'shopping.remove', ids }, t, { done: `Took ${listJoin(names)} off your list.` });
    if (missing.length) t.out.lines.push(`${capitalize(listJoin(missing))} wasn't on your list.`);
  }

  // ---- cancellation -----------------------------------------------------------

  private ctx(t: TurnCtx): ResolveContext {
    return { state: this.state, session: t.session, now: t.now, tz: t.tz, events: t.events };
  }

  private async onCancel(th: Extract<Thought, { kind: 'cancel' }>, t: TurnCtx) {
    const keywords = contentTokens((th.when?.rest ?? th.phrase).replace(/\b(it|that|this|them)\b/g, ''));
    // "Remove it" right after cancelling: it's already done.
    if (!keywords.length) {
      const top = t.session.focus[0];
      if (top?.kind === 'event') {
        const e = this.state.events.find((x) => x.id === top.id);
        if (e?.status === 'cancelled') {
          t.out.lines.push(`${e.title} is already cancelled.`);
          return;
        }
      }
    }
    const r = resolveTarget(this.ctx(t), th.phrase, th.when, ['event', 'reminder', 'shopping']);
    if (r.status === 'found') return this.applyToCandidate('cancel', r.candidate, {}, t);
    if (r.status === 'ambiguous') return this.askClarify('cancel', r.candidates, t, {});
    if (!keywords.length) {
      this.ask(t, { kind: 'fill_slot', text: "What can't you make?", optional: true, data: { slot: 'target', intent: { type: 'cancel_target' } } });
      return;
    }
    const phrase = th.when?.rest || th.phrase;
    const already = this.state.events.find((e) => e.status === 'cancelled' && Date.parse(e.start) > t.now.getTime() && matchScore(keywords.join(' '), e.title) >= 0.8);
    if (already) {
      t.out.lines.push(`${already.title} ${formatWhen(new Date(already.start), t.tz, t.now)} is already cancelled.`);
      return;
    }
    t.out.lines.push(`I couldn't find ${cleanPhrase(phrase)} on your calendar or lists.`);
  }

  private async applyToCandidate(action: string, c: Candidate, payload: Record<string, any>, t: TurnCtx) {
    if (action === 'cancel') return this.applyCancel(c, t);
    if (action === 'modify') return this.applyModify(c, deserialiseMod(payload), t);
    if (action === 'person') {
      const thought = payload.thought as Thought;
      const contact = this.state.contacts.find((x) => x.id === c.ref.id);
      if (!contact) return;
      this.focus(t, { kind: 'contact', id: contact.id });
      const replaced = replacePerson(thought, payload.name, `#id:${contact.id}`);
      return this.handleThought(replaced, t);
    }
    if (action === 'done') return this.completeCandidate(c, t);
  }

  private async applyCancel(c: Candidate, t: TurnCtx) {
    if (c.ref.kind === 'event') {
      const e = this.state.events.find((x) => x.id === c.ref.id) ?? t.events.find((x) => x.id === c.ref.id);
      if (!e) return;
      const when = formatWhen(new Date(e.start), t.tz, t.now, e.allDay);
      const names = e.attendees.map((id) => this.state.contacts.find((x) => x.id === id)?.name).filter(Boolean) as string[];
      await this.runPlan({ type: 'calendar.cancel', id: e.id, summary: `Cancelled ${e.title} (${when})` }, t, {
        done: `Done — I've cancelled ${lcTitle(e.title)} ${when}.`,
        confirmText: `Cancel ${lcTitle(e.title)} ${when}?${names.length ? ` ${listJoin(names)} will be told.` : ''}`,
        confirmOptions: [
          { label: 'Cancel it', value: 'yes' },
          { label: 'Keep', value: 'no' },
        ],
        declineText: `OK, I'll keep ${lcTitle(e.title)}.`,
        needText: `Confirm cancelling ${lcTitle(e.title)} ${when}.`,
        after: { kind: 'offer_reschedule', eventId: e.id, title: e.title },
      });
      return;
    }
    if (c.ref.kind === 'reminder') {
      const r = this.state.reminders.find((x) => x.id === c.ref.id);
      if (r) await this.runPlan({ type: 'reminder.archive', id: r.id }, t, { done: `OK — I've dropped “${r.text}”.` });
      return;
    }
    if (c.ref.kind === 'shopping') {
      const i = this.state.shopping.find((x) => x.id === c.ref.id);
      if (i) await this.runPlan({ type: 'shopping.remove', ids: [i.id] }, t, { done: `Took ${i.name} off your list.` });
    }
  }

  private askClarify(action: string, cands: Candidate[], t: TurnCtx, payload: Record<string, any>) {
    const sameTitle = new Set(cands.map((c) => lower(c.label))).size === 1;
    const options = cands.map((c) => ({ label: action === 'person' ? c.label : optionLabel(c, t.tz, t.now, !sameTitle), value: `option:${c.ref.id}` }));
    const verb = action === 'cancel' ? 'cancel' : action === 'modify' ? 'change' : 'use';
    const text = action === 'person' ? `Which ${payload.name ? capitalize(payload.name) : 'one'} — ${listJoin(options.map((o) => o.label), 'or')}?` : `Which one — ${listJoin(options.map((o) => o.label), 'or')}?`;
    this.ask(t, {
      kind: 'clarify_target',
      text,
      options,
      optional: false,
      data: {
        action,
        payload,
        candidates: cands.map(serialiseCandidate),
        needText: action === 'person' ? `Tell me which ${capitalize(payload.name ?? 'person')} you meant.` : `Choose which ${sameTitle ? lcTitle(cands[0].label) : 'one'} to ${verb}.`,
      },
    });
  }

  // ---- modification -------------------------------------------------------------

  private async onModify(th: Extract<Thought, { kind: 'modify' }>, t: TurnCtx) {
    const r = resolveTarget(this.ctx(t), th.phrase, undefined, ['event', 'shopping', 'reminder'], { includeCancelledFocus: true });
    const mod = { when: th.when, quantity: th.quantity, rename: th.rename };
    if (r.status === 'found') return this.applyModify(r.candidate, mod, t);
    if (r.status === 'ambiguous') return this.askClarify('modify', r.candidates, t, serialiseMod(mod));
    t.out.lines.push("I'm not sure what you'd like to change — could you say which one?");
  }

  private async applyModify(c: Candidate, mod: { when?: ParsedWhen; quantity?: number; rename?: string }, t: TurnCtx) {
    if (c.ref.kind === 'shopping') {
      const i = this.state.shopping.find((x) => x.id === c.ref.id)!;
      if (mod.quantity !== undefined) {
        await this.runPlan({ type: 'shopping.update', id: i.id, quantity: mod.quantity }, t, { done: `Got it — ${mod.quantity} ${i.name}.` });
      } else if (mod.rename) {
        await this.runPlan({ type: 'shopping.update', id: i.id, name: mod.rename }, t, { done: `Changed it to ${mod.rename}.` });
      } else t.out.lines.push(`What should I change ${i.name} to?`);
      return;
    }
    if (c.ref.kind === 'reminder') {
      const r = this.state.reminders.find((x) => x.id === c.ref.id)!;
      const base = r.dueAt ? new Date(r.dueAt) : t.now;
      const due = mod.when ? this.shiftInstant(base, mod.when, t, !r.dueAt) : undefined;
      if (mod.rename) {
        await this.runPlan({ type: 'reminder.update', id: r.id, patch: { text: capitalize(mod.rename) } }, t, { done: `Changed it to “${capitalize(mod.rename)}”.` });
        return;
      }
      if (!due) {
        t.out.lines.push('When should I remind you instead?');
        return;
      }
      await this.runPlan({ type: 'reminder.update', id: r.id, patch: { dueAt: due.toISOString() } }, t, { done: `I'll remind you ${formatWhen(due, t.tz, t.now)} instead.` });
      return;
    }
    if (c.ref.kind === 'event') {
      const e = this.state.events.find((x) => x.id === c.ref.id) ?? t.events.find((x) => x.id === c.ref.id);
      if (!e) return;
      if (mod.rename && !(mod.when && (mod.when.date || mod.when.time || mod.when.shiftMs || mod.when.span))) {
        await this.runPlan({ type: 'calendar.update', id: e.id, patch: { title: capitalize(mod.rename) }, summary: `Renamed ${e.title} to ${capitalize(mod.rename)}` }, t, { done: `Renamed it to ${capitalize(mod.rename)}.` });
        return;
      }
      await this.rescheduleEvent(e.id, mod.when, t);
    }
  }

  /** Move an event (restoring it if it had just been cancelled). */
  private async rescheduleEvent(eventId: string, when: ParsedWhen | undefined, t: TurnCtx) {
    const e = this.state.events.find((x) => x.id === eventId) ?? t.events.find((x) => x.id === eventId);
    if (!e) return;
    const start = new Date(e.start);
    const dur = Date.parse(e.end) - start.getTime();
    const next = when ? this.shiftInstant(start, when, t, false) : undefined;
    if (!next) {
      this.ask(t, { kind: 'fill_slot', text: 'When would you like it?', optional: true, data: { slot: 'when', intent: { type: 'reschedule', eventId } } });
      return;
    }
    const wasCancelled = e.status === 'cancelled';
    const whenText = formatWhen(next, t.tz, t.now, e.allDay);
    const conflict = this.conflictNote(next, new Date(next.getTime() + dur), t, e.id);
    await this.runPlan(
      { type: 'calendar.update', id: e.id, patch: { start: next.toISOString(), end: new Date(next.getTime() + dur).toISOString(), status: 'confirmed', remindedAt: undefined }, summary: `${wasCancelled ? 'Rescheduled' : 'Moved'} ${e.title} to ${whenText}` },
      t,
      {
        done: wasCancelled ? `Done — ${lcTitle(e.title)} is rescheduled for ${whenText}.${conflict}` : `Done — ${lcTitle(e.title)} is now ${whenText}.${conflict}`,
        confirmText: `Move ${lcTitle(e.title)} to ${whenText}? Everyone invited will be told.`,
        confirmOptions: [
          { label: 'Move it', value: 'yes' },
          { label: 'Keep', value: 'no' },
        ],
        declineText: `OK, ${lcTitle(e.title)} stays as it was.`,
      },
    );
  }

  /** Apply a spoken change ("to Friday", "three", "an hour later", "next week") to an existing instant. */
  private shiftInstant(base: Date, when: ParsedWhen, t: TurnCtx, baseIsNow: boolean): Date | undefined {
    if (when.shiftMs !== undefined && !when.date && !when.time) return new Date(base.getTime() + when.shiftMs);
    if (when.relativeMs !== undefined) return new Date(t.now.getTime() + when.relativeMs);
    const p = zonedParts(base, t.tz);
    let date = { year: p.year, month: p.month, day: p.day };
    let changed = false;
    if (when.date) {
      date = when.date;
      changed = true;
    } else if (when.span) {
      // Same weekday in the target span ("change that to next week").
      let d = when.span.from;
      for (let i = 0; i < 7; i++) {
        const cand = addDays(when.span.from, i);
        if (new Date(Date.UTC(cand.year, cand.month - 1, cand.day)).getUTCDay() === p.weekday) {
          d = cand;
          break;
        }
      }
      date = d;
      changed = true;
    }
    let hour = p.hour;
    let minute = p.minute;
    if (when.time) {
      hour = when.time.hour;
      minute = when.time.minute;
      if (when.time.ambiguous && when.time.hour12 !== undefined && !baseIsNow) {
        // "make it 3" for a 2 PM event means 3 PM; for a 9 AM event "make it 10" means 10 AM.
        const h = when.time.hour12 % 12;
        const options = [h, h + 12];
        hour = options.sort((a, b) => Math.abs(a - p.hour) - Math.abs(b - p.hour))[0];
      }
      changed = true;
    } else if (when.part) {
      hour = { morning: 9, afternoon: 14, evening: 18, tonight: 19, lunchtime: 12, later: 18 }[when.part];
      minute = 0;
      changed = true;
    }
    if (!changed) return undefined;
    let out = zonedToUtc({ ...date, hour, minute }, t.tz);
    if (when.shiftMs) out = new Date(out.getTime() + when.shiftMs);
    return out;
  }

  private conflictNote(start: Date, end: Date, t: TurnCtx, ignoreId?: string): string {
    const clash = t.events.find((e) => e.id !== ignoreId && e.status === 'confirmed' && !e.allDay && Date.parse(e.start) < end.getTime() && Date.parse(e.end) > start.getTime());
    return clash ? ` Heads up: that overlaps with ${clash.title} at ${formatClock(new Date(clash.start), t.tz)}.` : '';
  }

  // ---- undo / send / done ------------------------------------------------------------

  private async onUndo(t: TurnCtx) {
    const mine = this.state.ledger.filter((e) => !e.undoneAt && e.batchId !== this.exec.batchId && (e.sessionId === t.session.id || Date.parse(e.at) > t.now.getTime() - 30 * 60000));
    const lastAny = mine[mine.length - 1];
    if (!lastAny) {
      t.out.lines.push("There's nothing recent to undo.");
      return;
    }
    const batch = lastAny.batchId ? mine.filter((e) => e.batchId === lastAny.batchId) : [lastAny];
    // Describe the most meaningful entry in the batch (the calendar change, not the bookkeeping).
    const rank = (e: LedgerEntry) => (e.entity === 'event' ? 0 : e.entity === 'shopping' || e.entity === 'reminder' ? 1 : e.entity === 'draft' ? 2 : 3);
    const last = [...batch].sort((x, y) => rank(x) - rank(y))[0];
    const sameKind = batch.filter((e) => e.actionType === last.actionType);
    let message = '';
    for (const entry of [...batch].reverse()) {
      if (!entry.undoable) {
        if (entry === last) {
          t.out.lines.push((await this.exec.undo(entry)).message);
          return;
        }
        continue;
      }
      await this.exec.undo(entry);
    }
    await this.refresh(t);
    const before = last.before as any;
    if (last.entity === 'event' && before) {
      message = `Put it back — ${lcTitle(before.title)} is ${formatWhen(new Date(before.start), t.tz, t.now)} again.`;
      this.focus(t, { kind: 'event', id: last.entityId });
    } else if (last.entity === 'event') message = `Undone — I've taken ${lcTitle((last.after as any)?.title ?? 'it')} off your calendar${batch.some((b) => b.entity === 'draft') ? ' and discarded the invite' : ''}.`;
    else if (last.entity === 'shopping' && !before) message = `Undone — took ${listJoin(sameKind.map((b) => (b.after as any)?.name))} off your list.`;
    else if (last.entity === 'shopping') message = `Put ${listJoin(sameKind.map((b) => (b.before as any)?.name))} back on your list.`;
    else if (last.entity === 'reminder' && !before) message = 'Undone — reminder removed.';
    else if (last.entity === 'reminder') message = `Put “${before.text}” back on your list.`;
    else message = `Undone: ${last.summary.charAt(0).toLowerCase()}${last.summary.slice(1)}.`;
    t.out.lines.push(message);
  }

  private async onSend(t: TurnCtx) {
    const focused = t.session.focus.find((f) => f.kind === 'draft' && this.state.drafts.find((d) => d.id === f.id && d.status === 'draft'));
    const draft = focused ? this.state.drafts.find((d) => d.id === focused.id) : [...this.state.drafts].reverse().find((d) => d.status === 'draft' && t.session.ledgerIds.length);
    if (!draft) {
      t.out.lines.push("There's nothing ready to send.");
      return;
    }
    await this.sendDraft(draft, t, true);
  }

  private async sendDraft(d: Draft, t: TurnCtx, explicit: boolean) {
    const contact = this.state.contacts.find((c) => c.id === d.to);
    const provider = d.channel === 'email' ? this.providers.email : this.providers.messaging;
    if (!provider?.capabilities.send) {
      if (explicit) {
        t.out.lines.push(`I can't send ${d.channel === 'email' ? 'email' : 'messages'} directly yet — tap to send it${contact ? ` to ${contact.name}` : ''} yourself.`);
        if (d.handoffUrl) t.out.links.push({ label: `Send to ${contact?.name ?? 'them'}`, url: d.handoffUrl });
      }
      return;
    }
    await this.runPlan({ type: 'message.send', draftId: d.id }, t, {
      done: `Sent to ${contact?.name ?? 'them'}.`,
      confirmText: `Send to ${contact?.name ?? 'them'}: “${d.body}”?`,
      confirmOptions: [
        { label: 'Send', value: 'yes' },
        { label: 'Not yet', value: 'no' },
      ],
      declineText: "OK — it's saved as a draft.",
      needText: `Your message to ${contact?.name ?? 'them'} is waiting for your OK.`,
      userConfirmed: explicit,
    });
  }

  private async onDone(th: Extract<Thought, { kind: 'done' }>, t: TurnCtx) {
    if (!th.phrase) {
      const ref = t.session.focus.find((f) => ['reminder', 'shopping', 'draft', 'waiting'].includes(f.kind) && entityCandidate(this.ctx(t), f));
      if (!ref) {
        t.out.lines.push('Nice one.');
        return;
      }
      return this.completeCandidate(entityCandidate(this.ctx(t), ref)!, t);
    }
    const query = `${th.verb ?? ''} ${th.phrase}`.trim();
    const person = th.phrase.split(' ')[0];
    const contact = this.state.contacts.find((c) => c.name.toLowerCase().split(' ')[0] === person.toLowerCase());
    const reminders = this.state.reminders
      .filter((r) => r.status === 'open')
      .map((r) => ({ r, s: Math.max(matchScore(query, r.text), matchScore(th.phrase, r.text), contact && r.personId === contact.id ? 0.9 : 0) }))
      .filter((x) => x.s >= 0.6)
      .sort((a, b) => b.s - a.s);
    let did = false;
    if (reminders.length) {
      const r = reminders[0].r;
      await this.runPlan({ type: 'reminder.complete', id: r.id }, t, { done: `Nice — ticked off “${r.text}”.` });
      did = true;
      for (const d of this.state.drafts.filter((x) => x.reminderId === r.id && x.status === 'draft')) {
        d.status = 'handed_off';
        d.updatedAt = t.now.toISOString();
      }
    }
    if (contact && /^(replied|messaged|texted|emailed|answered|called|rang|phoned|sent)$/.test(th.verb ?? '')) {
      const w = this.state.waiting.find((x) => x.status === 'waiting' && x.direction === 'me' && x.personId === contact.id);
      if (w) {
        await this.runPlan({ type: 'waiting.resolve', id: w.id }, t, { quiet: did, done: `Great — ${contact.name} is off your list.` });
        did = true;
      }
      for (const d of this.state.drafts.filter((x) => x.to === contact.id && x.status === 'draft')) {
        d.status = 'handed_off';
        d.updatedAt = t.now.toISOString();
      }
    }
    if (!did) {
      const item = this.findShopping(th.phrase);
      if (item) {
        await this.runPlan({ type: 'shopping.complete', ids: [item.id] }, t, { done: `Ticked off ${item.name}.` });
        return;
      }
      t.out.lines.push('Nice one.');
    }
  }

  private async completeCandidate(c: Candidate, t: TurnCtx) {
    switch (c.ref.kind) {
      case 'reminder':
        await this.runPlan({ type: 'reminder.complete', id: c.ref.id }, t, { done: `Nice — ticked off “${c.label}”.` });
        return;
      case 'shopping':
        await this.runPlan({ type: 'shopping.complete', ids: [c.ref.id] }, t, { done: `Ticked off ${c.label}.` });
        return;
      case 'draft': {
        const d = this.state.drafts.find((x) => x.id === c.ref.id);
        if (d) {
          d.status = 'handed_off';
          d.updatedAt = t.now.toISOString();
          if (d.reminderId) await this.runPlan({ type: 'reminder.complete', id: d.reminderId }, t, { quiet: true });
        }
        t.out.lines.push("Great — I'll mark that as sent.");
        return;
      }
      case 'waiting':
        await this.runPlan({ type: 'waiting.resolve', id: c.ref.id }, t, { done: 'Great — marked as done.' });
        return;
    }
    t.out.lines.push('Nice one.');
  }

  // ---- calendar ------------------------------------------------------------------

  private async onEventAdd(th: Extract<Thought, { kind: 'event_add' }>, t: TurnCtx) {
    const title = th.title || 'Event';
    const hasTime = !!th.when.time || th.when.relativeMs !== undefined || !!th.when.part;
    const start = resolveInstant(th.when, t.now, t.tz, { defaultHour: 9 });
    if (!start) {
      this.ask(t, { kind: 'fill_slot', text: `When is ${lcTitle(title)}?`, optional: true, data: { slot: 'when', intent: { type: 'event', title } } });
      return;
    }
    await this.createEvent(title, start, !hasTime, t, th.raw);
  }

  private async createEvent(title: string, start: Date, allDay: boolean, t: TurnCtx, statedAs?: string, extra: { durationMin?: number; attendees?: string[]; routineId?: string } = {}) {
    const same = t.events.filter((e) => sameLocalDay(new Date(e.start), start, t.tz) && matchScore(title, e.title) >= 0.8);
    if (same.length) {
      const ex = same[0];
      this.focus(t, { kind: 'event', id: ex.id });
      if (Math.abs(Date.parse(ex.start) - start.getTime()) < 15 * 60000 || allDay) {
        t.out.lines.push(`${ex.title} ${formatWhen(new Date(ex.start), t.tz, t.now, ex.allDay)} is already on your calendar.`);
        return;
      }
      const dur = Date.parse(ex.end) - Date.parse(ex.start);
      const plan: ActionPlan = { type: 'calendar.update', id: ex.id, patch: { start: start.toISOString(), end: new Date(start.getTime() + dur).toISOString() }, summary: `Moved ${ex.title} to ${formatWhen(start, t.tz, t.now)}` };
      this.ask(t, {
        kind: 'confirm_action',
        text: `You've already got ${lcTitle(ex.title)} ${formatWhen(new Date(ex.start), t.tz, t.now)} — move it to ${formatClock(start, t.tz)}?`,
        options: [
          { label: 'Move it', value: 'yes' },
          { label: 'Leave it', value: 'no' },
        ],
        optional: true,
        data: { plan, opts: { done: `Done — ${lcTitle(ex.title)} is now ${formatWhen(start, t.tz, t.now)}.`, declineText: "OK, I'll leave it." } },
      });
      return;
    }
    // People mentioned in the title ("dinner with Sarah") become attendees for context — nobody is invited.
    const attendees = [...(extra.attendees ?? [])];
    const withM = title.match(/\bwith ([a-z]+(?: and [a-z]+)?)$/i);
    if (withM && !extra.attendees) {
      for (const n of withM[1].split(/ and /i)) {
        if (!isLikelyPersonName(n)) continue;
        const pr = resolvePerson(this.state, t.session, n);
        if (pr.status === 'found') attendees.push(pr.contact.id);
      }
    }
    const dur = (extra.durationMin ?? DEFAULT_EVENT_MIN) * 60000;
    const whenText = formatWhen(start, t.tz, t.now, allDay);
    const st = allDay ? startOfLocalDay(start, t.tz) : start;
    const conflict = allDay ? '' : this.conflictNote(st, new Date(st.getTime() + dur), t);
    await this.runPlan(
      {
        type: 'calendar.create',
        event: { title: capitalize(title), start: st.toISOString(), end: new Date(st.getTime() + (allDay ? 86400000 : dur)).toISOString(), timeZone: t.tz, allDay, attendees, statedAs, routineId: extra.routineId },
        summary: `Added ${capitalize(title)} ${whenText}`,
      },
      t,
      { done: `Added ${lcTitle(title)} ${whenText}.${conflict}` },
    );
  }

  // ---- reminders -----------------------------------------------------------------

  private async onReminder(th: Extract<Thought, { kind: 'reminder' }>, t: TurnCtx) {
    let text = this.properNames(th.text);
    let personId: string | undefined;
    if (th.personName && isLikelyPersonName(th.personName)) {
      const pr = resolvePerson(this.state, t.session, th.personName);
      if (pr.status === 'found') personId = pr.contact.id;
      else if (pr.status === 'new' && pr.name && th.reminderKind === 'message') personId = await this.createContact(pr.name, t);
      if (personId) {
        const c = this.state.contacts.find((x) => x.id === personId)!;
        text = text.replace(new RegExp(`\\b${escapeRe(th.personName)}\\b`, 'i'), c.name);
        this.focus(t, { kind: 'contact', id: c.id });
      }
    }
    const due = th.when.found ? resolveInstant(th.when, t.now, t.tz, { defaultHour: 9 }) : undefined;
    const dup = this.state.reminders.find((r) => r.status === 'open' && matchScore(text, r.text) >= 0.9 && matchScore(r.text, text) >= 0.9);
    if (dup) {
      this.focus(t, { kind: 'reminder', id: dup.id });
      if (due && dup.dueAt !== due.toISOString()) {
        await this.runPlan({ type: 'reminder.update', id: dup.id, patch: { dueAt: due.toISOString() } }, t, { done: `That's already on your list — I'll remind you ${formatWhen(due, t.tz, t.now)}.` });
      } else t.out.lines.push("That's already on your list.");
      return;
    }
    await this.runPlan({ type: 'reminder.create', text, dueAt: due?.toISOString(), kind: th.reminderKind, personId }, t, {
      done: due ? `I'll remind you to ${lcFirst(text)} ${formatWhen(due, t.tz, t.now)}.` : `I'll remind you to ${lcFirst(text)}.`,
    });
  }

  private async onRecall(th: Extract<Thought, { kind: 'recall' }>, t: TurnCtx) {
    const r = resolveTarget(this.ctx(t), th.phrase, th.when, ['event', 'reminder']);
    if (r.status === 'found') {
      this.focus(t, r.candidate.ref);
      if (r.candidate.ref.kind === 'event') {
        const e = this.state.events.find((x) => x.id === r.candidate.ref.id) ?? t.events.find((x) => x.id === r.candidate.ref.id)!;
        const lead = e.leadMin ?? this.state.profile.preferences.defaultEventLeadMin;
        t.out.lines.push(`${e.title} is ${formatWhen(new Date(e.start), t.tz, t.now, e.allDay)} — it's on your calendar${th.forgot ? `, and I'll remind you ${lead} minutes before` : ''}.`);
      } else {
        const rem = this.state.reminders.find((x) => x.id === r.candidate.ref.id)!;
        t.out.lines.push(`It's on your list${rem.dueAt ? ` for ${formatWhen(new Date(rem.dueAt), t.tz, t.now)}` : ''}.`);
      }
      return;
    }
    if (r.status === 'ambiguous') {
      t.out.lines.push(`You've got ${listJoin(r.candidates.map((c) => optionLabel(c, t.tz, t.now, true)))}.`);
      return;
    }
    const title = capitalize((th.when.rest || th.phrase).replace(/^(?:about |the |my )/, ''));
    if (th.when.time) {
      const start = resolveInstant(th.when, t.now, t.tz)!;
      await this.createEvent(title, start, false, t, th.raw);
      return;
    }
    const due = th.when.found ? resolveInstant(th.when, t.now, t.tz, { defaultHour: 9 }) : undefined;
    const status = await this.runPlan({ type: 'reminder.create', text: title, dueAt: due?.toISOString(), kind: 'task' }, t, {
      done: due ? `I'll remind you about ${lcFirst(title)} ${formatDay(due, t.tz, t.now)} morning.` : `I'll remind you about ${lcFirst(title)}.`,
    });
    if (status === 'done' && th.when.date && due) {
      const reminderId = t.session.focus[0]?.id;
      this.ask(t, {
        kind: 'fill_slot',
        text: `What time is ${lcFirst(title)}? I'll put it in your calendar.`,
        optional: true,
        data: { slot: 'time', intent: { type: 'event_from_reminder', title, date: th.when.date, reminderId } },
      });
    }
  }

  // ---- people & communication ----------------------------------------------------------

  private async createContact(name: string, t: TurnCtx, patch: Partial<Contact> = {}): Promise<string> {
    const res = await this.exec.execute({ type: 'contact.upsert', name: titleCaseName(name), patch }, { auto: true, risk: 'low', sessionId: t.session.id });
    const c = res.data?.contact as Contact;
    this.focus(t, { kind: 'contact', id: c.id });
    return c.id;
  }

  /** Resolve a spoken name to a contact, asking when genuinely ambiguous. */
  private async personFor(name: string | undefined, th: Thought, t: TurnCtx, opts: { create: boolean }): Promise<Contact | 'asked' | undefined> {
    if (name?.startsWith('#id:')) return this.state.contacts.find((c) => c.id === name.slice(4));
    if (!name) {
      const c = t.session.lastPersonId ? this.state.contacts.find((x) => x.id === t.session.lastPersonId) : undefined;
      return c;
    }
    const pr = resolvePerson(this.state, t.session, name);
    if (pr.status === 'found') {
      this.focus(t, { kind: 'contact', id: pr.contact.id });
      return pr.contact;
    }
    if (pr.status === 'ambiguous') {
      const cands: Candidate[] = pr.contacts.map((c) => ({ ref: { kind: 'contact', id: c.id }, label: c.name, title: `${c.name} ${c.email ?? ''}`, score: 1 }));
      this.askClarify('person', cands, t, { thought: th, name });
      return 'asked';
    }
    if (!pr.name || !opts.create || !isLikelyPersonName(pr.name)) return undefined;
    const id = await this.createContact(pr.name, t);
    return this.state.contacts.find((c) => c.id === id);
  }

  private async onCommunicate(th: Extract<Thought, { kind: 'communicate' }>, t: TurnCtx) {
    const contact = await this.personFor(th.personName && !/^(her|him|them)$/.test(th.personName) ? th.personName : undefined, th, t, { create: true });
    if (contact === 'asked') return;
    if (!contact) {
      this.ask(t, { kind: 'fill_slot', text: 'Who is it for?', optional: true, data: { slot: 'person', intent: { type: 'person_for', thought: th } } });
      return;
    }
    const channel = th.channel ?? this.inferChannel(contact, t);
    if (th.body) {
      const reminderId = this.state.reminders.find((r) => r.status === 'open' && r.personId === contact.id && (r.kind === 'message' || r.kind === 'follow_up'))?.id;
      await this.draftMessage(contact.id, channel, th.body, t, reminderId);
      return;
    }
    const verb = th.verb === 'reply' ? 'Reply to' : th.verb === 'email' || th.verb === 'e-mail' ? 'Email' : th.verb === 'tell' ? 'Get back to' : 'Message';
    const text = `${verb} ${contact.name}`;
    const due = th.when.found ? resolveInstant(th.when, t.now, t.tz, { defaultHour: 18 }) : undefined;
    let reminderId = this.state.reminders.find((r) => r.status === 'open' && r.personId === contact.id && r.kind === 'message')?.id;
    if (!reminderId) {
      await this.runPlan({ type: 'reminder.create', text, dueAt: due?.toISOString(), kind: 'message', personId: contact.id }, t, {
        done: due ? `I'll remind you to ${lcFirst(text)} ${formatWhen(due, t.tz, t.now)}.` : th.later ? `I'll remind you to ${lcFirst(text)}.` : undefined,
      });
      reminderId = this.state.reminders.find((r) => r.status === 'open' && r.personId === contact.id && r.kind === 'message')?.id;
      this.focus(t, { kind: 'contact', id: contact.id });
    }
    this.ask(t, {
      kind: 'fill_slot',
      text: th.later ? `What do you want to say to ${contact.name}?` : 'What do you want to say?',
      optional: true,
      data: { slot: 'body', intent: { type: 'communicate', contactId: contact.id, channel, reminderId } },
    });
  }

  private inferChannel(c: Contact, t: TurnCtx): 'email' | 'message' {
    const recentEmail = this.state.mailbox.some((m) => (c.email && m.from.toLowerCase() === c.email.toLowerCase()) && Date.parse(m.receivedAt) > t.now.getTime() - 14 * 86400000);
    if (recentEmail) return 'email';
    if (c.email && !c.phone) return 'email';
    return 'message';
  }

  private async draftMessage(contactId: string, channel: 'email' | 'message', body: string, t: TurnCtx, reminderId?: string) {
    const c = this.state.contacts.find((x) => x.id === contactId)!;
    this.focus(t, { kind: 'contact', id: contactId });
    const status = await this.runPlan({ type: 'draft.create', channel, to: contactId, body, reminderId, subject: channel === 'email' ? `Re: ${this.lastSubjectFrom(c) ?? 'our conversation'}` : undefined }, t, { quiet: true });
    if (status !== 'done') return;
    const d = this.state.drafts[this.state.drafts.length - 1];
    const provider = channel === 'email' ? this.providers.email : this.providers.messaging;
    // Someone waiting on the user gets their answer when this goes out.
    const canSend = !!provider?.capabilities.send && hasPermission(this.state, channel === 'email' ? 'email' : 'messaging', 'act');
    if (canSend) {
      await this.sendDraft(d, t, false);
      if (!this.activeQuestion(t.session) && !t.session.pending.some((q) => !q.asked)) return;
      if (t.session.pending.some((q) => q.kind === 'confirm_action' && (q.data.plan as ActionPlan).type === 'message.send' && !q.asked)) {
        t.out.lines.push("Got it. I've drafted that.");
      }
      return;
    }
    t.out.lines.push(`Got it. I've drafted that${d.handoffUrl ? ' — tap to send it' : ''}.`);
    if (d.handoffUrl) t.out.links.push({ label: `Send to ${c.name}${channel === 'message' ? ' (WhatsApp)' : ' (email)'}`, url: d.handoffUrl });
  }

  private lastSubjectFrom(c: Contact): string | undefined {
    const m = [...this.state.mailbox].reverse().find((x) => c.email && x.from.toLowerCase() === c.email.toLowerCase());
    return m?.subject.replace(/^re:\s*/i, '');
  }

  // ---- meetings ---------------------------------------------------------------------

  private async onMeeting(th: Extract<Thought, { kind: 'meeting' }>, t: TurnCtx) {
    const people: string[] = [];
    const names = th.people.length ? th.people : [];
    for (const n of names) {
      const c = await this.personFor(n.startsWith('#id:') ? n : n, th, t, { create: true });
      if (c === 'asked') return;
      if (c) people.push(c.id);
    }
    if (!people.length) {
      this.ask(t, { kind: 'fill_slot', text: 'Who is the meeting with?', optional: true, data: { slot: 'person', intent: { type: 'person_for', thought: th } } });
      return;
    }
    const intent: Extract<Intent, { type: 'meeting' }> = { type: 'meeting', people, provider: th.provider, statedAs: th.raw };
    this.mergeWhen(intent, th.when, t);
    await this.continueMeeting(intent, t);
  }

  private mergeWhen(intent: { date?: { year: number; month: number; day: number }; time?: { hour: number; minute: number; ambiguous: boolean; hour12?: number } }, when: ParsedWhen, t: TurnCtx) {
    if (when.relativeMs !== undefined) {
      const at = new Date(t.now.getTime() + when.relativeMs);
      const p = zonedParts(at, t.tz);
      intent.date = { year: p.year, month: p.month, day: p.day };
      intent.time = { hour: p.hour, minute: p.minute, ambiguous: false };
      return;
    }
    if (when.date) intent.date = when.date;
    else if (when.span && !intent.date) intent.date = when.span.from;
    if (when.time) intent.time = when.time;
    else if (when.part && !intent.time) {
      const h = { morning: 10, afternoon: 14, evening: 18, tonight: 19, lunchtime: 12, later: 16 }[when.part];
      intent.time = { hour: h, minute: 0, ambiguous: false };
    }
  }

  private async continueMeeting(intent: Extract<Intent, { type: 'meeting' }>, t: TurnCtx) {
    const contacts = intent.people.map((id) => this.state.contacts.find((c) => c.id === id)!).filter(Boolean);
    const names = listJoin(contacts.map((c) => c.name));
    if (!intent.date) {
      this.ask(t, { kind: 'fill_slot', text: 'What day?', optional: false, data: { slot: 'when', intent, needText: `Pick a day for the call with ${names}.` } });
      return;
    }
    if (!intent.time) {
      this.ask(t, { kind: 'fill_slot', text: 'What time?', optional: false, data: { slot: 'when', intent, needText: `Pick a time for the call with ${names}.` } });
      return;
    }
    const other = contacts.find((c) => c.timeZone && c.timeZone !== this.tz);
    if (!intent.zone) {
      const hint = parseWhen(intent.statedAs, t.now, t.tz).zoneHint;
      if (hint?.kind === 'mine') intent.zone = this.tz;
      else if (hint?.kind === 'named') intent.zone = hint.tz;
      else if (hint?.kind === 'theirs' && other) intent.zone = other.timeZone;
    }
    if (!intent.zone && other) {
      const h = intent.time.hour % 12 === 0 ? 12 : intent.time.hour % 12;
      const clock = `${h}${intent.time.minute ? `:${String(intent.time.minute).padStart(2, '0')}` : ''} ${intent.time.hour < 12 ? 'AM' : 'PM'}`;
      this.ask(t, {
        kind: 'fill_slot',
        text: `${clock} your time or ${other.name.split(' ')[0]}'s?`,
        options: [
          { label: 'My time', value: 'my time' },
          { label: `${other.name.split(' ')[0]}'s time`, value: 'their time' },
        ],
        optional: false,
        data: { slot: 'zone', intent, needText: `Tell me whether the call with ${other.name} is your time or theirs.` },
      });
      return;
    }
    const zone = intent.zone ?? this.tz;
    const start = zonedToUtc({ ...intent.date, hour: intent.time.hour, minute: intent.time.minute }, zone);
    const end = new Date(start.getTime() + 30 * 60000);
    const providerName = intent.provider === 'zoom' ? 'Zoom' : intent.provider === 'meet' ? 'Google Meet' : intent.provider === 'teams' ? 'Teams' : intent.provider === 'facetime' ? 'FaceTime' : 'Call';
    const title = `${providerName} with ${names}`;
    const existing = t.events.find((e) => Math.abs(Date.parse(e.start) - start.getTime()) < 60 * 60000 && e.attendees.some((a) => intent.people.includes(a)));
    if (existing) {
      t.out.lines.push(`You've already got ${existing.title} ${formatWhen(new Date(existing.start), t.tz, t.now)}.`);
      this.focus(t, { kind: 'event', id: existing.id });
      return;
    }
    let meeting: { provider: string; url: string } | undefined;
    let linkNote = '';
    if (this.providers.meetings) {
      try {
        const m = await this.providers.meetings.create({ title, start, end, attendees: contacts });
        if (!intent.provider || m.provider === intent.provider || intent.provider === 'video') meeting = { provider: m.provider, url: m.url };
      } catch {
        /* no link available */
      }
    }
    if (!meeting && intent.provider && intent.provider !== 'facetime') {
      linkNote = ` ${providerName} isn't connected, so there's no link yet — connect it or tell me your personal ${providerName} link and I'll add it.`;
    }
    const status = await this.runPlan(
      {
        type: 'calendar.create',
        event: { title, start: start.toISOString(), end: end.toISOString(), timeZone: zone, attendees: intent.people, meeting, statedAs: intent.statedAs },
        summary: `Set up ${title} ${formatWhen(start, t.tz, t.now)}`,
      },
      t,
      { quiet: true },
    );
    if (status !== 'done') return;
    const eventId = t.session.focus[0].id;
    // Invitations are prepared for every attendee; they're sent only if the user has authorised sending.
    const draftIds: string[] = [];
    for (const c of contacts) {
      const theirTz = c.timeZone ?? this.tz;
      const theirWhen = `${formatDay(start, theirTz, t.now)} at ${formatClock(start, theirTz)}${theirTz !== this.tz ? ` your time` : ''}`;
      const body = `Hi ${c.name.split(' ')[0]}, I've set up a ${providerName === 'Call' ? 'call' : `${providerName} call`} for ${theirWhen}${meeting ? `: ${meeting.url}` : ''}. Does that work for you?`;
      const channel = c.email ? 'email' : 'message';
      const res = await this.exec.execute({ type: 'draft.create', channel, to: c.id, body, subject: title, relatedEventId: eventId }, { auto: true, risk: 'low', sessionId: t.session.id });
      this.recordResult(res, t);
      if (res.ok) draftIds.push(res.refs[0].id);
    }
    await this.exec.execute({ type: 'waiting.create', direction: 'them', personId: contacts[0].id, who: names, about: 'confirmed the meeting', relatedId: eventId }, { auto: true, risk: 'low', sessionId: t.session.id }).then((r) => this.recordResult(r, t));
    this.focus(t, { kind: 'event', id: eventId });

    const theirPart = other && (other.timeZone ?? this.tz) !== this.tz ? ` (${formatClock(start, other.timeZone!)} for ${other.name.split(' ')[0]})` : '';
    t.out.lines.push(`Done — ${title} is in your calendar ${formatWhen(start, t.tz, t.now)}${theirPart}.${linkNote}`);
    const drafts = draftIds.map((id) => this.state.drafts.find((d) => d.id === id)!).filter(Boolean);
    const sendable = drafts.filter((d) => {
      const p = d.channel === 'email' ? this.providers.email : this.providers.messaging;
      return p?.capabilities.send && hasPermission(this.state, d.channel === 'email' ? 'email' : 'messaging', 'act');
    });
    if (sendable.length) {
      for (const d of sendable) await this.sendDraft(d, t, false);
    } else if (drafts.length) {
      t.out.lines.push(`The invite to ${names} is ready to send.`);
      for (const d of drafts) if (d.handoffUrl) t.out.links.push({ label: `Send invite to ${this.state.contacts.find((c) => c.id === d.to)?.name}`, url: d.handoffUrl });
    }
  }

  private async continueIntent(intent: Intent, t: TurnCtx, when: ParsedWhen) {
    switch (intent.type) {
      case 'meeting':
        this.mergeWhen(intent, when, t);
        return this.continueMeeting(intent, t);
      case 'activity': {
        const at = resolveInstant(when, t.now, t.tz);
        if (!at) return;
        return this.continueActivity(intent.activity, at, t);
      }
      case 'event': {
        const start = resolveInstant(when.date ? when : { ...when, date: when.date ?? intent.date }, t.now, t.tz, { defaultHour: 9 });
        if (start) return this.createEvent(intent.title, start, !when.time && !when.part, t);
        return;
      }
      case 'reschedule':
        return this.rescheduleEvent(intent.eventId, when, t);
      case 'event_from_reminder': {
        const start = resolveInstant({ ...when, date: when.date ?? intent.date }, t.now, t.tz);
        if (!start) return;
        const r = this.state.reminders.find((x) => x.id === intent.reminderId && x.status === 'open');
        if (r) {
          r.status = 'archived';
          r.updatedAt = t.now.toISOString();
        }
        return this.createEvent(intent.title, start, false, t);
      }
      case 'booking':
        return this.onBooking({ kind: 'booking', raw: intent.service, service: intent.service, when }, t);
    }
  }

  // ---- bookings & purchases -----------------------------------------------------------

  private async onBooking(th: Extract<Thought, { kind: 'booking' }>, t: TurnCtx) {
    // "Book Rick for 2" — a person, so it's a meeting.
    const personish = th.service.split(' ')[0];
    const contact = this.state.contacts.find((c) => c.name.toLowerCase().split(' ')[0] === personish.toLowerCase());
    if (contact) return this.onMeeting({ kind: 'meeting', raw: th.raw, people: [`#id:${contact.id}`], when: th.when }, t);

    const service = th.service.replace(/^(?:a|an|the|my)\s+/, '');
    const whenText = describeWhen(th.when, t);
    const b = this.providers.bookings;
    if (!b) {
      const memory = this.state.memories.find((m) => m.kind === 'service' && contentTokens(m.subject).some((x) => contentTokens(service).includes(x)));
      const text = `Book ${service}${whenText ? ` (${whenText})` : ''}`;
      const dup = this.state.reminders.find((r) => r.status === 'open' && r.kind === 'booking' && matchScore(service, r.text) >= 0.8);
      if (!dup) await this.runPlan({ type: 'reminder.create', text, kind: 'booking' }, t, { quiet: true });
      this.executorObserve('booking', service.toLowerCase(), { manual: true });
      t.out.lines.push(`I can't book ${service} directly yet, so I've added it to your list${whenText ? ` for ${whenText}` : ''}${memory ? ` — your usual is ${memory.value}` : ''}.`);
      return;
    }
    const services = await b.findServices(service);
    if (!services.length) {
      t.out.lines.push(`I couldn't find anywhere to book ${service}. I've added it to your list instead.`);
      await this.runPlan({ type: 'reminder.create', text: `Book ${service}`, kind: 'booking' }, t, { quiet: true });
      return;
    }
    // Prefer a remembered provider.
    const remembered = this.state.memories.find((m) => m.kind === 'service' && m.subject.includes(service));
    const svc = services.find((s) => remembered && s.name.toLowerCase().includes(remembered.value.toLowerCase())) ?? services[0];
    const range = this.whenRange(th.when, t);
    let slots = await b.availability(svc.id, range.from, range.to);
    if (th.when.part) {
      const [lo, hi] = { morning: [6, 12], afternoon: [12, 17], evening: [17, 22], tonight: [17, 23], lunchtime: [11, 14], later: [12, 22] }[th.when.part];
      slots = slots.filter((s) => {
        const h = zonedParts(s.start, t.tz).hour;
        return h >= lo && h < hi;
      });
    }
    if (th.when.time) {
      const exact = slots.filter((s) => {
        const p = zonedParts(s.start, t.tz);
        return p.hour === th.when.time!.hour && p.minute === th.when.time!.minute;
      });
      if (exact.length) slots = exact;
    }
    if (!slots.length) {
      t.out.lines.push(`${svc.name} has nothing free ${whenText || 'then'}.`);
      this.ask(t, { kind: 'fill_slot', text: 'Want me to try another day?', optional: true, data: { slot: 'when', intent: { type: 'booking', service } } });
      return;
    }
    const serial = slots.slice(0, 3).map((s) => ({ id: s.id, start: s.start.toISOString(), end: s.end.toISOString(), label: `${formatDay(s.start, t.tz, t.now)} at ${formatClock(s.start, t.tz)}`, price: s.price }));
    if (serial.length === 1) return this.bookSlot(svc.id, service, serial[0], serial[0].price, t);
    this.ask(t, {
      kind: 'fill_slot',
      text: `${svc.name} can do ${listJoin(serial.map((s) => formatClock(new Date(s.start), t.tz)), 'or')} ${formatDay(new Date(serial[0].start), t.tz, t.now)} — which works?`,
      options: serial.map((s) => ({ label: formatClock(new Date(s.start), t.tz), value: `option:${s.id}` })),
      optional: false,
      data: { slot: 'booking_slot', serviceId: svc.id, service, slots: serial, needText: `You need to choose a ${service} time.` },
    });
  }

  private async bookSlot(serviceId: string, service: string, slot: { id: string; start: string; end: string; price?: { amount: number; currency: string } }, price: any, t: TurnCtx) {
    const p = slot.price ?? price;
    const when = formatWhen(new Date(slot.start), t.tz, t.now);
    await this.runPlan({ type: 'booking.create', serviceId, slotId: slot.id, service, start: slot.start, end: slot.end, price: p }, t, {
      done: `Booked — ${service} ${when}. It's in your calendar.`,
      confirmText: `Book ${service} ${when}${p ? ` for ${money(p)}` : ''}?`,
      confirmOptions: [
        { label: 'Book it', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
      declineText: "OK, I won't book it.",
      needText: `Confirm the ${service} booking ${when}.`,
    });
  }

  private whenRange(when: ParsedWhen, t: TurnCtx): { from: Date; to: Date } {
    if (when.date) {
      const from = zonedToUtc({ ...when.date, hour: 0, minute: 0 }, t.tz);
      return { from, to: new Date(from.getTime() + 86400000) };
    }
    if (when.span) {
      const from = zonedToUtc({ ...when.span.from, hour: 0, minute: 0 }, t.tz);
      const to = zonedToUtc({ ...addDays(when.span.to, 1), hour: 0, minute: 0 }, t.tz);
      return { from, to };
    }
    return { from: t.now, to: new Date(t.now.getTime() + 7 * 86400000) };
  }

  private async onPurchase(th: Extract<Thought, { kind: 'purchase' }>, t: TurnCtx) {
    const p = this.providers.purchases;
    const item = th.item.replace(/^(?:a|an|the)\s+/, '');
    if (!p) {
      await this.onShoppingAdd({ kind: 'shopping_add', raw: th.raw, items: [{ name: item }] }, t);
      t.out.lines.push("I can't buy things for you directly, so it's on your shopping list.");
      return;
    }
    const product = await p.find(item);
    if (!product) {
      t.out.lines.push(`I couldn't find ${item}.`);
      return;
    }
    await this.runPlan({ type: 'purchase.create', productId: product.id, name: product.name, price: product.price }, t, {
      done: `Ordered — ${product.name} for ${money(product.price)}.`,
      confirmText: `Buy ${product.name} for ${money(product.price)}?`,
      confirmOptions: [
        { label: 'Buy', value: 'yes' },
        { label: 'Cancel', value: 'no' },
      ],
      declineText: "OK, I haven't bought it.",
      needText: `Confirm buying ${product.name} for ${money(product.price)}.`,
    });
  }

  // ---- waiting ---------------------------------------------------------------------

  private async onWaiting(th: Extract<Thought, { kind: 'waiting' }>, t: TurnCtx) {
    const c = await this.personFor(th.personName, th, t, { create: true });
    if (c === 'asked') return;
    const who = c?.name ?? titleCaseName(th.personName);
    const existing = this.state.waiting.find((w) => w.status === 'waiting' && w.direction === th.direction && (c ? w.personId === c.id : w.who === who));
    if (existing) {
      if (th.about && !existing.about) existing.about = th.about;
      t.out.lines.push(th.direction === 'them' ? `I'm already keeping an eye out for ${who}.` : `Already on your list.`);
      return;
    }
    const canWatch = !!this.providers.email && Object.keys(this.state.integrations).some((k) => /mail|google/.test(k));
    await this.runPlan(
      { type: 'waiting.create', direction: th.direction, personId: c?.id, who, about: th.about.replace(/^(?:about|on|re) /, ''), notifyOnReply: canWatch },
      t,
      {
        done: th.direction === 'them'
          ? `Noted — I'll keep track of ${who}'s reply${canWatch ? ' and tell you when it comes in' : ''}.`
          : `Got it — ${who}'s waiting on you. I'll keep it in what needs you.`,
      },
    );
  }

  private async onReplied(personName: string, t: TurnCtx) {
    const pr = resolvePerson(this.state, t.session, personName);
    const id = pr.status === 'found' ? pr.contact.id : undefined;
    const w = this.state.waiting.find((x) => x.status === 'waiting' && x.direction === 'them' && (id ? x.personId === id : x.who.toLowerCase() === personName.toLowerCase()));
    if (!w) {
      t.out.lines.push('Good to know.');
      return;
    }
    await this.runPlan({ type: 'waiting.resolve', id: w.id }, t, { done: `Great — ${w.who} is off the waiting list.` });
  }

  // ---- queries ---------------------------------------------------------------------

  private async onQuery(th: Extract<Thought, { kind: 'query' }>, t: TurnCtx) {
    switch (th.topic) {
      case 'needs_me': {
        const items = needsMe(this.state, t.now);
        const undated = this.state.reminders.filter((r) => r.status === 'open' && !r.dueAt && r.kind === 'task').length;
        t.out.lines.push(needsMeText(items, undated));
        // Bring open questions from earlier conversations into this one so they can be answered now.
        for (const item of items.filter((i) => i.kind === 'question')) {
          for (const s of this.state.sessions) {
            if (s.id === t.session.id) continue;
            const q = s.pending.find((x) => x.id === item.id);
            if (q) {
              s.pending = s.pending.filter((x) => x.id !== q.id);
              t.session.pending.push({ ...q, asked: true, askedAt: t.now.toISOString() });
            }
          }
        }
        for (const i of items) {
          if (i.kind === 'reminder' || i.kind === 'booking') this.focus(t, { kind: 'reminder', id: i.id });
          if (i.kind === 'draft') this.focus(t, { kind: 'draft', id: i.id });
        }
        return;
      }
      case 'handled':
        t.out.lines.push(handledSummary(this.state, t.now, /week/i.test(th.raw) ? 'week' : 'today'));
        return;
      case 'schedule': {
        const w = parseWhen(th.raw, t.now, t.tz);
        let from: Date;
        let to: Date;
        let label: string;
        if (w.date) {
          from = zonedToUtc({ ...w.date, hour: 0, minute: 0 }, t.tz);
          to = new Date(from.getTime() + 86400000);
          label = formatDay(from, t.tz, t.now);
        } else if (w.span) {
          from = zonedToUtc({ ...w.span.from, hour: 0, minute: 0 }, t.tz);
          to = zonedToUtc({ ...addDays(w.span.to, 1), hour: 0, minute: 0 }, t.tz);
          label = w.span.label;
        } else if (/coming up|next\b/i.test(th.raw)) {
          from = t.now;
          to = new Date(t.now.getTime() + 7 * 86400000);
          label = 'the next week';
        } else {
          from = t.now;
          to = zonedToUtc({ ...addDays(zonedParts(t.now, t.tz), 1), hour: 0, minute: 0 }, t.tz);
          label = 'the rest of today';
        }
        const inRange = t.events.filter((e) => Date.parse(e.start) >= from.getTime() && Date.parse(e.start) < to.getTime());
        t.out.lines.push(scheduleSummary(t.events, t.tz, t.now, from, to, label));
        if (inRange.length === 1) this.focus(t, { kind: 'event', id: inRange[0].id });
        return;
      }
      case 'shopping': {
        const items = this.state.shopping.filter((s) => s.status === 'needed');
        t.out.lines.push(items.length ? `On your list: ${listJoin(items.map((i) => (i.quantity ? `${i.quantity} ${i.name}` : i.name)))}.` : 'Your shopping list is empty.');
        return;
      }
      case 'reminders': {
        const rs = this.state.reminders.filter((r) => r.status === 'open');
        t.out.lines.push(rs.length ? `You've got: ${listJoin(rs.slice(0, 8).map((r) => lcFirst(r.text) + (r.dueAt ? ` (${formatWhen(new Date(r.dueAt), t.tz, t.now)})` : '')))}${rs.length > 8 ? ` and ${rs.length - 8} more` : ''}.` : 'No reminders right now.');
        return;
      }
      case 'waiting': {
        const ws = this.state.waiting.filter((w) => w.status === 'waiting');
        t.out.lines.push(ws.length ? ws.map((w) => (w.direction === 'them' ? `Waiting on ${w.who}${w.about ? ` (${w.about})` : ''}.` : `${w.who} is waiting on you${w.about ? ` (${w.about})` : ''}.`)).join(' ') : "You're not waiting on anyone.");
        return;
      }
      case 'replied':
        return this.onHasReplied(th.personName ?? '', t);
      case 'memory': {
        const ms = this.state.memories.filter((m) => m.kind !== 'identity').slice(-10);
        const routines = this.state.routines;
        if (!ms.length && !routines.length) {
          t.out.lines.push("I don't know much about you yet — I'll learn as we go, and I'll always tell you what I've picked up.");
          return;
        }
        const parts = ms.map((m) => `${m.subject === 'fact' || m.subject === 'preference' ? m.value : `${capitalize(m.subject)}: ${m.value}`} (${provenanceLabel(m.provenance)})`);
        for (const r of routines) parts.push(`${r.title} on ${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][r.weekday]} (${r.status === 'automated' ? 'I handle it' : 'confirmed'})`);
        t.out.lines.push(`Here's what I know: ${parts.join('; ')}. You can change or delete any of it in settings.`);
        return;
      }
      case 'help':
        t.out.lines.push("Just tell me what's on your mind — things to buy, appointments, people to get back to — and I'll sort it. You can also ask “what still needs me?”, “what did you handle today?”, or say “undo”.");
        return;
      case 'name':
        t.out.lines.push(this.state.profile.assistantName ? `I'm ${this.state.profile.assistantName}.` : "I don't have a name yet — what would you like to call me?");
        return;
      case 'time':
        t.out.lines.push(`It's ${formatClock(t.now, t.tz)}.`);
        return;
    }
  }

  private async onHasReplied(personName: string, t: TurnCtx) {
    const pr = resolvePerson(this.state, t.session, personName);
    const contact = pr.status === 'found' ? pr.contact : undefined;
    const who = contact?.name ?? titleCaseName(personName);
    this.executorObserve('manual_check', who.toLowerCase());
    const w = this.state.waiting.find((x) => x.status === 'waiting' && x.direction === 'them' && (contact ? x.personId === contact.id : x.who.toLowerCase() === who.toLowerCase()));
    const since = w ? new Date(w.since) : new Date(t.now.getTime() - 7 * 86400000);
    if (this.providers.email && (contact?.email || contact)) {
      const msgs = await this.providers.email.search({ from: contact?.email ?? who, since });
      if (msgs.length) {
        const m = msgs[msgs.length - 1];
        t.out.lines.push(`Yes — ${who} replied ${formatDay(new Date(m.receivedAt), t.tz, t.now)}: “${m.subject}”.`);
        if (w) await this.runPlan({ type: 'waiting.resolve', id: w.id }, t, { quiet: true });
        return;
      }
    }
    if (!w) {
      t.out.lines.push(`Nothing from ${who} that I can see.`);
      await this.runPlan({ type: 'waiting.create', direction: 'them', personId: contact?.id, who, about: '' }, t, { quiet: true });
      return;
    }
    if (w.notifyOnReply) {
      t.out.lines.push(`Not yet — I'll let you know as soon as ${who.split(' ')[0]} replies.`);
      return;
    }
    t.out.lines.push('Not yet.');
    analyseBehaviour(this.state, this.ids, t.now);
    const sug = this.state.suggestions.find((s) => s.kind === 'notify_reply' && s.payload.waitingId === w.id && s.status === 'pending');
    if (sug) this.offerSuggestion(sug.id, sug.text, t);
  }

  private executorObserve(kind: 'manual_check' | 'booking' | 'activity', key: string, meta?: Record<string, unknown>) {
    this.exec.observe(kind, key, meta);
  }

  // ---- friction, briefing, suggestions ---------------------------------------------------------

  private async onFriction(t: TurnCtx) {
    analyseBehaviour(this.state, this.ids, t.now);
    const best = this.state.suggestions.filter((s) => s.status === 'pending' || s.status === 'offered').sort((a, b) => b.score - a.score)[0];
    if (!best) {
      const drafts = this.state.drafts.filter((d) => d.status === 'draft').length;
      t.out.lines.push(
        drafts
          ? `Nothing big yet. You do have ${drafts === 1 ? 'a draft' : `${drafts} drafts`} ready — if you let me send messages for you, that's one less step.`
          : "Nothing obvious right now. As I learn your routines I'll suggest ways to take more off your plate.",
      );
      return;
    }
    this.offerSuggestion(best.id, best.text, t);
  }

  offerSuggestion(id: string, text: string, t: TurnCtx) {
    const s = this.state.suggestions.find((x) => x.id === id);
    if (s) {
      s.status = 'offered';
      s.offeredAt = t.now.toISOString();
    }
    this.ask(t, {
      kind: 'suggestion',
      text,
      options: [
        { label: 'Yes', value: 'yes' },
        { label: 'No thanks', value: 'no' },
      ],
      optional: true,
      data: { suggestionId: id },
    });
  }

  private async acceptSuggestion(q: PendingQuestion, t: TurnCtx) {
    if (q.data.action) return this.acceptAction(q, t);
    const s = this.state.suggestions.find((x) => x.id === q.data.suggestionId);
    if (!s) return;
    s.status = 'accepted';
    s.respondedAt = t.now.toISOString();
    const p = s.payload as any;
    switch (s.kind) {
      case 'routine': {
        const res = await this.exec.execute(
          { type: 'routine.create', routine: { title: p.title, kind: p.kind, weekday: p.weekday, hour: p.hour, minute: p.minute, durationMin: p.durationMin ?? 60, status: 'confirmed' } },
          { auto: false, risk: 'low', sessionId: t.session.id },
        );
        this.recordResult(res, t);
        const routineId = res.refs[0]?.id;
        await this.exec.execute(
          { type: 'memory.store', memory: { kind: 'routine', subject: p.title.toLowerCase(), value: `${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][p.weekday]} at ${fmtHM(p.hour, p.minute)}`, provenance: 'confirmed', source: 'behaviour', confidence: 0.9, confirmed: true, automationAllowed: false } },
          { auto: true, risk: 'low', sessionId: t.session.id },
        );
        const r = this.state.routines.find((x) => x.id === routineId);
        if (r) {
          const m = this.state.memories.find((x) => x.kind === 'routine' && x.subject === p.title.toLowerCase());
          r.memoryId = m?.id;
        }
        t.out.lines.push("Got it — I'll remember that.");
        this.ask(t, {
          kind: 'suggestion',
          text: `Want me to add it to your calendar automatically each week?`,
          options: [
            { label: 'Yes', value: 'yes' },
            { label: 'Just remind me', value: 'no' },
          ],
          optional: true,
          data: { action: 'automate_routine', routineId },
        });
        return;
      }
      case 'staples': {
        const items: string[] = p.items ?? [];
        const weekday = mostCommonWeekday(this.state, items, t);
        const res = await this.exec.execute(
          { type: 'routine.create', routine: { title: 'Weekly staples', kind: 'shopping', weekday, hour: 9, minute: 0, durationMin: 0, status: 'automated', items } },
          { auto: false, risk: 'low', sessionId: t.session.id },
        );
        this.recordResult(res, t);
        t.out.lines.push(`Done — I'll add ${listJoin(items)} every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekday]} unless they're already on the list.`);
        return;
      }
      case 'notify_reply': {
        const w = this.state.waiting.find((x) => x.id === p.waitingId);
        if (w) w.notifyOnReply = true;
        t.out.lines.push(`Will do — I'll tell you as soon as ${w?.who ?? 'they'} replies.`);
        return;
      }
      case 'combine_capture':
        this.state.profile.preferences.shoppingDigest = { hour: 17 };
        t.out.lines.push("Done — I'll keep adding things quietly and send you one list at 5 PM on days you've added something.");
        return;
      case 'remember_provider':
        await this.exec.execute(
          { type: 'memory.store', memory: { kind: 'service', subject: p.service, value: String(p.provider ?? ''), provenance: 'confirmed', source: 'behaviour', confidence: 0.9, confirmed: true, automationAllowed: false } },
          { auto: true, risk: 'low', sessionId: t.session.id },
        );
        t.out.lines.push("Got it — I'll use them by default.");
        return;
      case 'nudge': {
        const w = this.state.waiting.find((x) => x.id === p.waitingId);
        if (!w) return;
        w.nudgedAt = t.now.toISOString();
        if (w.personId) await this.draftMessage(w.personId, 'message', `Hi ${w.who.split(' ')[0]}, just checking in${w.about ? ` on ${w.about}` : ''} — any update?`, t);
        return;
      }
      case 'prepare_routine': {
        const r = this.state.routines.find((x) => x.id === p.routineId);
        if (r) await this.materialiseRoutine(r, p.date, t);
        return;
      }
    }
  }

  private async acceptAction(q: PendingQuestion, t: TurnCtx) {
    const a = q.data.action as string;
    if (a === 'automate_routine') {
      const r = this.state.routines.find((x) => x.id === q.data.routineId);
      if (!r) return;
      r.status = 'automated';
      const m = r.memoryId ? this.state.memories.find((x) => x.id === r.memoryId) : undefined;
      if (m) m.automationAllowed = true;
      t.out.lines.push("Done — I'll add it each week. You can turn that off any time.");
      return;
    }
    if (a === 'run_setup') {
      const eventId = q.data.eventId as string;
      const e = this.state.events.find((x) => x.id === eventId);
      const playlist = q.data.playlist as string | undefined;
      const parts: string[] = [];
      if (playlist && this.providers.music) {
        const m = await this.providers.music.prepare(playlist);
        t.out.links.push({ label: m.label, url: m.url });
        parts.push('your playlist');
      }
      if (this.providers.fitness) {
        const f = await this.providers.fitness.prepare(q.data.activity ?? 'run');
        t.out.links.push({ label: f.label, url: f.url });
        parts.push(this.providers.fitness.label);
      }
      if (e) {
        const lead = 10;
        const at = new Date(Date.parse(e.start) - lead * 60000);
        await this.runPlan({ type: 'reminder.create', text: `Get ready for your ${q.data.activity ?? 'run'}`, dueAt: at.toISOString(), kind: 'task' }, t, { quiet: true });
      }
      t.out.lines.push(`Ready — I'll nudge you 10 minutes before${parts.length ? `, with ${listJoin(parts)} one tap away` : ''}.`);
      return;
    }
    if (a === 'notify_reply') {
      const w = this.state.waiting.find((x) => x.id === q.data.waitingId);
      if (w) w.notifyOnReply = true;
      t.out.lines.push("I'll let you know.");
    }
  }

  private declineSuggestion(q: PendingQuestion, t: TurnCtx) {
    if (q.data.action === 'automate_routine') {
      t.out.lines.push("OK — I'll just remind you the day before.");
      return;
    }
    if (q.data.action) {
      t.out.lines.push('OK.');
      return;
    }
    const s = this.state.suggestions.find((x) => x.id === q.data.suggestionId);
    if (s) {
      s.status = 'declined';
      s.respondedAt = t.now.toISOString();
      s.payload = { ...s.payload, declines: Number(s.payload.declines ?? 0) + 1 };
    }
    t.out.lines.push("No problem — I won't bring it up again for a while.");
  }

  /** Put one routine occurrence on the calendar (idempotent per date). */
  async materialiseRoutine(r: { id: string; title: string; hour: number; minute: number; durationMin: number; handled: string[] }, dateKey: string, t: TurnCtx) {
    if (r.handled.includes(dateKey)) return;
    const [y, m, d] = dateKey.split('-').map(Number);
    const start = zonedToUtc({ year: y, month: m, day: d, hour: r.hour, minute: r.minute }, t.tz);
    const exists = t.events.find((e) => sameLocalDay(new Date(e.start), start, t.tz) && matchScore(r.title, e.title) >= 0.8);
    r.handled.push(dateKey);
    if (exists) return;
    await this.createEvent(r.title, start, false, t, undefined, { durationMin: r.durationMin, routineId: r.id });
  }

  /** Used by the scheduler for automated routines: a quiet, system-owned turn. */
  async materialiseRoutineAt(routineId: string, key: string, now: Date): Promise<void> {
    const r = this.state.routines.find((x) => x.id === routineId);
    if (!r) return;
    let session = this.state.sessions.find((s) => s.device === 'automation' && !s.endedAt);
    if (!session) {
      session = { id: this.ids('ses'), startedAt: now.toISOString(), lastActivityAt: now.toISOString(), device: 'automation', turns: [], focus: [], pending: [], ledgerIds: [] };
      this.state.sessions.push(session);
    }
    const t = await this.turn(session, now);
    await this.materialiseRoutine(r, key, t);
    session.pending = [];
    session.endedAt = now.toISOString();
  }

  private onWeekly(t: TurnCtx) {
    t.out.lines.push(weeklyBriefing(this.state, t.events, t.now));
    this.ask(t, { kind: 'briefing', text: WEEKLY_PROMPTS[0], optional: true, data: { step: 0 } });
  }

  // ---- activities -----------------------------------------------------------------

  private async onActivity(th: Extract<Thought, { kind: 'activity' }>, t: TurnCtx) {
    const activity = th.activity === 'jog' ? 'run' : th.activity;
    if (!th.when.time && th.when.relativeMs === undefined) {
      const intent: Intent = { type: 'activity', activity };
      // A specific date without a time ("tomorrow") is kept for the answer.
      this.ask(t, { kind: 'fill_slot', text: 'What time?', optional: true, data: { slot: 'time', intent } });
      return;
    }
    const at = resolveInstant(th.when, t.now, t.tz)!;
    await this.continueActivity(activity, at, t);
  }

  private async continueActivity(activity: string, at: Date, t: TurnCtx) {
    this.executorObserve('activity', activity, { start: at.toISOString() });
    await this.createEvent(capitalize(activity), at, false, t, undefined, { durationMin: activity === 'run' ? 45 : 60 });
    const eventId = t.session.focus[0]?.kind === 'event' ? t.session.focus[0].id : undefined;
    const playlist = this.state.memories.find((m) => /(?:run|running|workout|gym) (?:playlist|music)|playlist/.test(m.subject) && (m.subject.includes(activity) || /run/.test(activity)))?.value;
    const routine = this.state.routines.find((r) => matchScore(activity, r.title) >= 0.8);
    if (eventId && (playlist || routine?.setup)) {
      this.ask(t, {
        kind: 'suggestion',
        text: `Want your usual ${activity} setup?`,
        options: [
          { label: 'Yes', value: 'yes' },
          { label: 'No', value: 'no' },
        ],
        optional: true,
        data: { action: 'run_setup', eventId, playlist: playlist ?? routine?.setup?.playlist?.name, activity },
      });
    }
  }

  // ---- memory & facts --------------------------------------------------------------

  private async onContactFact(th: Extract<Thought, { kind: 'contact_fact' }>, t: TurnCtx) {
    const c = await this.personFor(th.personName, th, t, { create: true });
    if (c === 'asked' || !c) return;
    const patch: Partial<Contact> = {};
    let text = '';
    if (th.field === 'email') {
      patch.email = th.value.replace(/\s+at\s+/i, '@').replace(/\s+dot\s+/gi, '.').replace(/\s/g, '').toLowerCase();
      text = `Got it — I'll use ${patch.email} for ${c.name}.`;
    } else if (th.field === 'phone') {
      patch.phone = th.value.replace(/[^\d+]/g, '');
      text = `Got it — saved ${c.name}'s number.`;
    } else {
      const tz = cityToTimeZone(th.value);
      patch.city = capitalize(th.value);
      if (tz) patch.timeZone = tz;
      const diff = tz && tz !== this.tz ? ` I'll keep the time difference in mind.` : '';
      text = `Got it — ${c.name} is in ${titleCaseName(th.value)}.${diff}`;
    }
    await this.runPlan({ type: 'contact.upsert', id: c.id, name: c.name, patch }, t, { done: text });
  }

  private onUserFact(th: Extract<Thought, { kind: 'user_fact' }>, t: TurnCtx) {
    if (th.field === 'name') {
      this.state.profile.displayName = titleCaseName(th.value);
      t.out.lines.push(`Nice to meet you, ${this.state.profile.displayName}.`);
      return;
    }
    const tz = cityToTimeZone(th.value);
    if (tz) {
      this.state.profile.timeZone = tz;
      t.out.lines.push(`Got it — I'll use ${titleCaseName(th.value)} time.`);
    } else t.out.lines.push(`Got it — you're in ${titleCaseName(th.value)}.`);
  }

  private async onRememberFact(th: Extract<Thought, { kind: 'remember_fact' }>, t: TurnCtx) {
    await this.runPlan(
      { type: 'memory.store', memory: { kind: th.memoryKind, subject: th.subject, value: th.value, provenance: 'told', source: 'conversation', confidence: 1, confirmed: true, automationAllowed: false } },
      t,
      { done: "Got it, I'll remember that." },
    );
  }

  private async onForget(th: Extract<Thought, { kind: 'forget' }>, t: TurnCtx) {
    let m = th.phrase
      ? this.state.memories.filter((x) => x.kind !== 'identity').map((x) => ({ x, s: matchScore(th.phrase, `${x.subject} ${x.value}`) })).filter((y) => y.s >= 0.5).sort((a, b) => b.s - a.s)[0]?.x
      : undefined;
    if (!m && !th.phrase) {
      const ref = t.session.focus.find((f) => f.kind === 'memory');
      m = ref ? this.state.memories.find((x) => x.id === ref.id) : undefined;
      if (!m) {
        // "forget that" right after adding something = undo it.
        return this.onUndo(t);
      }
    }
    if (!m) {
      t.out.lines.push("I don't have anything about that.");
      return;
    }
    await this.runPlan({ type: 'memory.delete', id: m.id }, t, { done: "Done — I've forgotten that." });
  }

  private onTrust(th: Extract<Thought, { kind: 'trust' }>, t: TurnCtx) {
    const recent = [...this.state.ledger].reverse().find((e) => e.sessionId === t.session.id && (th.grant ? !e.auto : e.auto));
    if (!recent) {
      t.out.lines.push(th.grant ? "Got it — I'll ask less." : "OK, I'll check with you first.");
      return;
    }
    const meta = recent.actionType === 'message.send' ? 'message.send' : recent.actionType;
    if (th.grant && recent.risk === 'high') {
      t.out.lines.push("I'll still check with you before anything involving money or that can't be undone — but everything else, I'll just handle.");
      return;
    }
    setTrust(this.state, meta, th.grant, t.now);
    t.out.lines.push(th.grant ? "Got it — I won't ask about that again." : "OK, I'll check with you first next time.");
  }

  private async onEmailClear(th: Extract<Thought, { kind: 'email_clear' }>, t: TurnCtx) {
    const email = this.providers.email;
    if (!email) {
      t.out.lines.push("I can't see your email yet — connect it in settings and I can tidy it for you.");
      return;
    }
    const promo = /promo|marketing|newsletter|sales?|offers?|spam|junk|those|these/.test(th.query) || th.query === '';
    const msgs = await email.search(promo ? { category: 'promotions' } : { text: th.query });
    const label = promo ? 'promotional emails' : `emails about ${th.query}`;
    if (!msgs.length) {
      t.out.lines.push(`No ${label} to clear.`);
      return;
    }
    const permanent = th.permanent || this.state.profile.preferences.clearMeans === 'delete';
    const ids = msgs.map((m) => m.id);
    if (permanent) {
      await this.runPlan({ type: 'email.delete', ids, label }, t, {
        done: `Deleted ${ids.length} ${label}.`,
        confirmText: `Delete ${ids.length} ${label}? This can't be undone.`,
        confirmOptions: [
          { label: 'Delete', value: 'yes' },
          { label: 'Archive instead', value: 'no' },
        ],
        declineText: 'OK, nothing deleted.',
      });
      return;
    }
    await this.runPlan({ type: 'email.archive', ids, label }, t, { done: `Archived ${ids.length} ${label}. Say “undo” if you want them back.` });
  }

  private async onNote(th: Extract<Thought, { kind: 'note' }>, t: TurnCtx) {
    const text = th.text.trim();
    if (/\?$/.test(th.raw) || /^(?:what|why|how|when|where|who|which|is|are|do|does|can|could|will|would)\b/i.test(text)) {
      t.out.lines.push("I'm not sure about that one — I'm best with things you need to remember, sort or do.");
      return;
    }
    if (text.split(' ').length <= 1 && !th.idea) {
      t.out.lines.push("Sorry, I didn't catch that.");
      return;
    }
    await this.runPlan({ type: 'note.create', text, idea: th.idea }, t, { done: th.idea ? 'Saved that idea.' : "Saved — I've noted that." });
  }

  // ---- helpers -------------------------------------------------------------------

  /** Capitalise known contact names inside free text. */
  private properNames(text: string): string {
    let out = text;
    for (const c of this.state.contacts) {
      const first = c.name.split(' ')[0];
      out = out.replace(new RegExp(`\\b${escapeRe(first)}\\b`, 'gi'), first);
    }
    return out;
  }

  // =========================================================================
  // Direct operations used by the UI (settings, ledger, notifications)
  // =========================================================================

  async undoEntry(ledgerId: string): Promise<{ ok: boolean; message: string }> {
    const e = this.state.ledger.find((x) => x.id === ledgerId);
    if (!e) return { ok: false, message: 'Not found.' };
    const r = await this.exec.undo(e);
    if (r.ok) this.state.version += 1;
    return r;
  }

  /** Act on a notification button (e.g. "Add it" for a routine prepared by the scheduler). */
  async actOnNotification(notificationId: string, value: string, now = this.clock()): Promise<Reply> {
    const n = this.state.notifications.find((x) => x.id === notificationId);
    const session = this.getSession(undefined, now, 'notification');
    const t = await this.turn(session, now);
    if (!n) {
      t.out.lines.push("That's no longer relevant.");
      return this.finish(t);
    }
    n.read = true;
    const data = n.data ?? {};
    if (value === 'dismiss' || value === 'no') {
      if (data.suggestionId) {
        const s = this.state.suggestions.find((x) => x.id === data.suggestionId);
        if (s) {
          s.status = 'declined';
          s.respondedAt = now.toISOString();
          s.payload = { ...s.payload, declines: Number(s.payload.declines ?? 0) + 1 };
        }
      }
      t.out.lines.push('OK.');
      return this.finish(t);
    }
    if (data.suggestionId) {
      const q: PendingQuestion = { id: 'n', kind: 'suggestion', text: n.text, askedAt: now.toISOString(), optional: true, asked: true, data: { suggestionId: data.suggestionId } };
      await this.acceptSuggestion(q, t);
      return this.finish(t);
    }
    if (data.routineId && data.date) {
      const r = this.state.routines.find((x) => x.id === data.routineId);
      if (r) await this.materialiseRoutine(r, String(data.date), t);
      return this.finish(t);
    }
    if (data.reminderId && value === 'done') {
      await this.runPlan({ type: 'reminder.complete', id: String(data.reminderId) }, t, { done: 'Done.' });
      return this.finish(t);
    }
    if (data.reminderId && value === 'snooze') {
      const due = new Date(now.getTime() + 3600000);
      await this.runPlan({ type: 'reminder.update', id: String(data.reminderId), patch: { dueAt: due.toISOString() } }, t, { done: `I'll remind you again at ${formatClock(due, this.tz)}.` });
      return this.finish(t);
    }
    if (value === 'briefing') {
      this.onWeekly(t);
      return this.finish(t);
    }
    t.out.lines.push('OK.');
    return this.finish(t);
  }

  proactiveSuggestion(now = this.clock()) {
    analyseBehaviour(this.state, this.ids, now);
    return pickProactive(this.state, now);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface SerialCandidate {
  ref: Ref;
  label: string;
  title: string;
  score: number;
  start?: string;
}

function serialiseCandidate(c: Candidate): SerialCandidate {
  return { ref: c.ref, label: c.label, title: c.title, score: c.score, start: c.start?.toISOString() };
}

function deserialiseCandidate(c: SerialCandidate): Candidate {
  return { ...c, start: c.start ? new Date(c.start) : undefined };
}

function serialiseMod(m: { when?: ParsedWhen; quantity?: number; rename?: string }) {
  return JSON.parse(JSON.stringify(m));
}

function deserialiseMod(p: Record<string, any>): { when?: ParsedWhen; quantity?: number; rename?: string } {
  return { when: p.when, quantity: p.quantity, rename: p.rename };
}

function stripOpts(o: RunOpts): RunOpts {
  const { done, declineText, after, needText, confirmText, confirmOptions } = o;
  return { done, declineText, after, needText, confirmText, confirmOptions };
}

function replacePerson(th: Thought, name: string, replacement: string): Thought {
  const x = JSON.parse(JSON.stringify(th));
  if ('personName' in x && x.personName && x.personName.toLowerCase() === String(name).toLowerCase()) x.personName = replacement;
  if ('people' in x) x.people = x.people.map((p: string) => (p.toLowerCase() === String(name).toLowerCase() ? replacement : p));
  return x;
}

function lcFirst(s: string): string {
  if (!s) return s;
  // Keep proper names ("Sarah") capitalised.
  const first = s.split(' ')[0];
  if (/^[A-Z][a-z]+$/.test(first) && ['Call', 'Message', 'Reply', 'Email', 'Book', 'Buy', 'Get', 'Pay', 'Send', 'Pick', 'Take', 'Check', 'Renew', 'Get', 'Tell', 'Text', 'Ring', 'Phone'].includes(first)) {
    return first.toLowerCase() + s.slice(first.length);
  }
  if (/^[A-Z][a-z]/.test(s) && !/^I\b/.test(s)) return s[0].toLowerCase() + s.slice(1);
  return s;
}

function lcTitle(s: string): string {
  // Event titles read naturally lower-case mid-sentence ("cancelled yoga"), except names/acronyms.
  if (/^(Zoom|Google|Teams|FaceTime|Call with)\b/.test(s) || /\bwith [A-Z]/.test(s)) return s;
  return lcFirst(s);
}

function cleanPhrase(s: string): string {
  return s.replace(/^(?:the|my|that|this)\s+/i, '').replace(/\s+(?:anymore|any more)$/i, '').trim() || 'that';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function money(p: { amount: number; currency: string }): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: p.currency }).format(p.amount);
  } catch {
    return `${p.amount} ${p.currency}`;
  }
}

function fmtHM(h: number, m: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

function provenanceLabel(p: string): string {
  return { told: 'you told me', observed: 'I noticed', inferred: 'my guess', suggested: 'suggested', confirmed: 'confirmed' }[p] ?? p;
}

function describeWhen(when: ParsedWhen, t: TurnCtx): string {
  const parts: string[] = [];
  if (when.date) parts.push(formatDay(zonedToUtc({ ...when.date, hour: 12, minute: 0 }, t.tz), t.tz, t.now));
  else if (when.span) parts.push(when.span.label);
  if (when.time) parts.push(`at ${fmtHM(when.time.hour, when.time.minute)}`);
  else if (when.part) parts.push(when.part === 'later' ? 'later' : `${when.part}`);
  return parts.join(' ').replace(/^(\w+) (morning|afternoon|evening)$/, '$1 $2');
}

function mostCommonWeekday(state: UserState, items: string[], t: TurnCtx): number {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const o of state.observations) if (o.kind === 'item_added' && items.includes(o.key)) counts[zonedParts(new Date(o.at), t.tz).weekday]++;
  const max = Math.max(...counts);
  return max ? counts.indexOf(max) : 6;
}

/** Pull a name out of an onboarding answer ("Milo", "let's go with Milo", "how about Nova?"). */
export function extractName(raw: string): string | undefined {
  let s = raw.trim().replace(/[.!?"“”]+/g, '').trim();
  s = s.replace(/^(?:um+|uh+|hmm+|er+m*)[, ]+/i, '');
  s = s.replace(/^(?:let'?s (?:go with|call you|do|try)|how about|what about|call you|i'?ll call you|i'?d like to call you|you can be|you'?re|maybe|i think|your name is|name you|i'?ll name you|you'?ll be|go with|call yourself)\s+/i, '');
  s = s.replace(/\s+(?:please|i think|maybe|then)$/i, '').trim();
  if (!/^[A-Za-z][A-Za-z'-]{0,20}(?: [A-Za-z][A-Za-z'-]{0,20})?$/.test(s)) return undefined;
  if (/^(yes|no|ok|okay|hello|hi|hey|what|i|nothing|anything|none|sure|thanks|thank you|help|start|why|who)$/i.test(s)) return undefined;
  if (isYes(s) || isNo(s)) return undefined;
  return s
    .split(' ')
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ');
}
