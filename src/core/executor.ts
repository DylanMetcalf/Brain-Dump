import type { Channel } from './types.js';
// Action Engine: plans are plain data (so a confirmation can be answered later, even
// after a restart). Execution goes through providers, is verified by reading state back,
// and is recorded in the Action Ledger with enough information to undo it.

import type { ActionMeta } from './policy.js';
import { isSensitiveText } from './policy.js';
import type { NewEvent, Providers } from './providers.js';
import type { IdGen } from './text.js';
import type {
  CalendarEvent, Contact, Draft, EntityKind, LedgerEntry, Memory, Observation, Reminder, ReminderKind, RiskLevel, Routine,
  ShoppingItem, UserState, WaitingItem,
} from './types.js';

export type ActionPlan =
  | { type: 'shopping.add'; items: { name: string; quantity?: number }[] }
  | { type: 'shopping.complete'; ids: string[] }
  | { type: 'shopping.remove'; ids: string[] }
  | { type: 'shopping.update'; id: string; quantity?: number; name?: string }
  | { type: 'reminder.create'; text: string; dueAt?: string; kind: ReminderKind; personId?: string }
  | { type: 'reminder.complete'; id: string }
  | { type: 'reminder.archive'; id: string }
  | { type: 'reminder.update'; id: string; patch: Partial<Pick<Reminder, 'dueAt' | 'text'>> }
  | { type: 'note.create'; text: string; idea: boolean }
  | { type: 'calendar.create'; event: NewEvent; summary: string }
  | { type: 'calendar.update'; id: string; patch: Partial<CalendarEvent>; summary: string }
  | { type: 'calendar.cancel'; id: string; summary: string }
  | { type: 'draft.create'; channel: Channel; to: string; body: string; subject?: string; reminderId?: string; relatedEventId?: string }
  | { type: 'message.send'; draftId: string }
  | { type: 'email.archive'; ids: string[]; label: string }
  | { type: 'email.delete'; ids: string[]; label: string }
  | { type: 'booking.create'; serviceId: string; slotId: string; service: string; start: string; end: string; price?: { amount: number; currency: string } }
  | { type: 'purchase.create'; productId: string; name: string; price: { amount: number; currency: string } }
  | { type: 'waiting.create'; direction: 'them' | 'me'; personId?: string; who: string; about: string; relatedId?: string; notifyOnReply?: boolean }
  | { type: 'waiting.resolve'; id: string }
  | { type: 'memory.store'; memory: Omit<Memory, 'id' | 'learnedAt' | 'lastObservedAt' | 'observationCount'> }
  | { type: 'memory.delete'; id: string }
  | { type: 'contact.upsert'; id?: string; name: string; patch: Partial<Contact> }
  | { type: 'routine.create'; routine: Omit<Routine, 'id' | 'createdAt' | 'handled'> }
  | { type: 'routine.update'; id: string; patch: Partial<Routine> };

export interface ExecResult {
  ok: boolean;
  entries: LedgerEntry[];
  /** Entity created/changed, for focus tracking. */
  refs: { kind: EntityKind; id: string }[];
  error?: string;
  data?: Record<string, unknown>;
}

export function metaFor(plan: ActionPlan, state: UserState): ActionMeta {
  switch (plan.type) {
    case 'shopping.add':
    case 'shopping.complete':
    case 'shopping.remove':
    case 'shopping.update':
      return { actionType: plan.type, scope: 'shopping', needs: 'act', reversible: true, external: false };
    case 'reminder.create':
    case 'reminder.complete':
    case 'reminder.archive':
    case 'reminder.update':
      return { actionType: plan.type, scope: 'reminders', needs: 'act', reversible: true, external: false };
    case 'note.create':
      return { actionType: plan.type, scope: 'notes', needs: 'act', reversible: true, external: false };
    case 'calendar.create':
      return { actionType: plan.type, scope: 'calendar', needs: 'act', reversible: true, external: false };
    case 'calendar.update':
    case 'calendar.cancel': {
      const e = state.events.find((x) => x.id === plan.id);
      // Only events with other attendees who would be notified count as external.
      const external = !!e && e.attendees.length > 0 && !!e.meeting;
      return { actionType: plan.type, scope: 'calendar', needs: 'act', reversible: true, external };
    }
    case 'draft.create':
      return { actionType: plan.type, scope: plan.channel === 'email' ? 'email' : 'messaging', needs: 'draft', reversible: true, external: false };
    case 'message.send': {
      const d = state.drafts.find((x) => x.id === plan.draftId);
      return {
        actionType: d?.channel === 'email' ? 'email.send' : 'message.send',
        scope: d?.channel === 'email' ? 'email' : 'messaging',
        needs: 'act',
        reversible: false,
        external: true,
        sensitive: d ? isSensitiveText(d.body) : false,
      };
    }
    case 'email.archive':
      return { actionType: plan.type, scope: 'email', needs: 'act', reversible: true, external: false };
    case 'email.delete':
      return { actionType: plan.type, scope: 'email', needs: 'act', reversible: false, external: false, destructive: true };
    case 'booking.create':
      return { actionType: plan.type, scope: 'bookings', needs: 'act', reversible: false, external: true, financial: plan.price };
    case 'purchase.create':
      return { actionType: plan.type, scope: 'purchases', needs: 'act', reversible: false, external: true, financial: plan.price };
    case 'waiting.create':
    case 'waiting.resolve':
      return { actionType: plan.type, scope: 'reminders', needs: 'act', reversible: true, external: false };
    case 'memory.store':
    case 'memory.delete':
      return { actionType: plan.type, scope: 'memory', needs: 'act', reversible: true, external: false };
    case 'contact.upsert':
      return { actionType: 'contact.update', scope: 'contacts', needs: 'act', reversible: true, external: false };
    case 'routine.create':
    case 'routine.update':
      return { actionType: plan.type, scope: 'memory', needs: 'act', reversible: true, external: false };
  }
}

export interface ExecutorDeps {
  state: () => UserState;
  providers: Providers;
  ids: IdGen;
  clock: () => Date;
}

function clone<T>(x: T): T {
  return x === undefined || x === null ? x : JSON.parse(JSON.stringify(x));
}

export class Executor {
  constructor(private d: ExecutorDeps) {}

  private get s() {
    return this.d.state();
  }

  private entry(
    plan: ActionPlan,
    summary: string,
    entity: EntityKind,
    entityId: string,
    before: unknown,
    after: unknown,
    verified: boolean,
    auto: boolean,
    risk: RiskLevel,
    sessionId?: string,
    undoable = true,
  ): LedgerEntry {
    const e: LedgerEntry = {
      id: this.d.ids('act'),
      at: this.d.clock().toISOString(),
      sessionId,
      batchId: this.batchId,
      actionType: plan.type,
      summary,
      entity,
      entityId,
      verified,
      auto,
      risk,
      before: clone(before),
      after: clone(after),
      undoable,
    };
    this.s.ledger.push(e);
    if (this.s.ledger.length > 2000) this.s.ledger.splice(0, this.s.ledger.length - 2000);
    return e;
  }

  observe(kind: Observation['kind'], key: string, meta?: Record<string, unknown>) {
    this.s.observations.push({ id: this.d.ids('obs'), at: this.d.clock().toISOString(), kind, key, meta: { ...(meta ?? {}), ...(this.sessionId ? { sessionId: this.sessionId } : {}) } });
    if (this.s.observations.length > 5000) this.s.observations.splice(0, this.s.observations.length - 5000);
  }

  /** Set by the orchestrator for the duration of one user request. */
  batchId?: string;
  private sessionId?: string;

  async execute(plan: ActionPlan, opts: { auto: boolean; risk: RiskLevel; sessionId?: string }): Promise<ExecResult> {
    this.sessionId = opts.sessionId;
    try {
      return await this.run(plan, opts);
    } catch (err) {
      return { ok: false, entries: [], refs: [], error: (err as Error).message };
    }
  }

  private async run(plan: ActionPlan, o: { auto: boolean; risk: RiskLevel; sessionId?: string }): Promise<ExecResult> {
    const now = this.d.clock().toISOString();
    const s = this.s;
    const res: ExecResult = { ok: true, entries: [], refs: [] };
    const push = (summary: string, entity: EntityKind, id: string, before: unknown, after: unknown, verified: boolean, undoable = true) => {
      res.entries.push(this.entry(plan, summary, entity, id, before, after, verified, o.auto, o.risk, o.sessionId, undoable));
      res.refs.push({ kind: entity, id });
      if (!verified) res.ok = false;
    };

    switch (plan.type) {
      case 'shopping.add': {
        for (const it of plan.items) {
          const existing = s.shopping.find((x) => x.name.toLowerCase() === it.name.toLowerCase() && x.status !== 'needed');
          if (existing) {
            const before = clone(existing);
            existing.status = 'needed';
            existing.quantity = it.quantity;
            existing.updatedAt = now;
            push(`Added ${it.name} to your shopping list`, 'shopping', existing.id, before, existing, existing.status === 'needed');
          } else {
            const item: ShoppingItem = { id: this.d.ids('item'), name: it.name, quantity: it.quantity, status: 'needed', addedAt: now, updatedAt: now };
            s.shopping.push(item);
            push(`Added ${it.name} to your shopping list`, 'shopping', item.id, null, item, !!s.shopping.find((x) => x.id === item.id));
          }
          this.observe('item_added', it.name.toLowerCase());
        }
        return res;
      }
      case 'shopping.complete':
      case 'shopping.remove': {
        for (const id of plan.ids) {
          const item = s.shopping.find((x) => x.id === id);
          if (!item) continue;
          const before = clone(item);
          item.status = plan.type === 'shopping.complete' ? 'got' : 'removed';
          item.updatedAt = now;
          push(`${plan.type === 'shopping.complete' ? 'Ticked off' : 'Removed'} ${item.name}`, 'shopping', id, before, item, (item.status as string) !== 'needed');
        }
        return res;
      }
      case 'shopping.update': {
        const item = s.shopping.find((x) => x.id === plan.id);
        if (!item) throw new Error('item not found');
        const before = clone(item);
        if (plan.quantity !== undefined) item.quantity = plan.quantity;
        if (plan.name) item.name = plan.name;
        item.updatedAt = now;
        push(`Updated ${item.name}${item.quantity ? ` (×${item.quantity})` : ''}`, 'shopping', item.id, before, item, true);
        return res;
      }
      case 'reminder.create': {
        const r: Reminder = { id: this.d.ids('rem'), text: plan.text, dueAt: plan.dueAt, status: 'open', kind: plan.kind, personId: plan.personId, createdAt: now, updatedAt: now };
        s.reminders.push(r);
        push(`Reminder: ${r.text}`, 'reminder', r.id, null, r, !!s.reminders.find((x) => x.id === r.id));
        this.observe('reminder_created', r.text.toLowerCase(), { dueAt: r.dueAt });
        return res;
      }
      case 'reminder.complete':
      case 'reminder.archive': {
        const r = s.reminders.find((x) => x.id === plan.id);
        if (!r) throw new Error('reminder not found');
        const before = clone(r);
        r.status = plan.type === 'reminder.complete' ? 'done' : 'archived';
        r.updatedAt = now;
        if (r.status === 'done') r.completedAt = now;
        push(`${r.status === 'done' ? 'Done' : 'Dropped'}: ${r.text}`, 'reminder', r.id, before, r, (r.status as string) !== 'open');
        return res;
      }
      case 'reminder.update': {
        const r = s.reminders.find((x) => x.id === plan.id);
        if (!r) throw new Error('reminder not found');
        const before = clone(r);
        Object.assign(r, plan.patch, { updatedAt: now, notifiedAt: undefined });
        push(`Updated reminder: ${r.text}`, 'reminder', r.id, before, r, true);
        return res;
      }
      case 'note.create': {
        const n = { id: this.d.ids('note'), text: plan.text, kind: plan.idea ? ('idea' as const) : ('note' as const), createdAt: now };
        s.notes.push(n);
        push(`Saved ${n.kind}: ${n.text}`, 'note', n.id, null, n, true);
        return res;
      }
      case 'calendar.create': {
        const e = await this.d.providers.calendar.create(plan.event);
        const check = await this.d.providers.calendar.get(e.id);
        push(plan.summary, 'event', e.id, null, check ?? e, !!check && check.status === 'confirmed');
        const start = new Date(e.start);
        this.observe('event_created', e.title.toLowerCase(), { start: e.start, timeZone: e.timeZone, routineId: e.routineId });
        res.data = { event: e, start };
        return res;
      }
      case 'calendar.update': {
        const before = clone(await this.d.providers.calendar.get(plan.id));
        if (!before) throw new Error('event not found');
        const e = await this.d.providers.calendar.update(plan.id, plan.patch);
        const check = await this.d.providers.calendar.get(e.id);
        const ok = !!check && (!plan.patch.start || check.start === plan.patch.start) && (plan.patch.status ? check.status === plan.patch.status : true);
        push(plan.summary, 'event', e.id, before, check, ok);
        return res;
      }
      case 'calendar.cancel': {
        const before = clone(await this.d.providers.calendar.get(plan.id));
        if (!before) throw new Error('event not found');
        await this.d.providers.calendar.cancel(plan.id);
        const check = await this.d.providers.calendar.get(plan.id);
        push(plan.summary, 'event', plan.id, before, check ?? null, !check || check.status === 'cancelled');
        return res;
      }
      case 'draft.create': {
        const contact = s.contacts.find((c) => c.id === plan.to);
        const d: Draft = {
          id: this.d.ids('draft'), channel: plan.channel, to: plan.to, body: plan.body, subject: plan.subject, status: 'draft',
          createdAt: now, updatedAt: now, reminderId: plan.reminderId, relatedEventId: plan.relatedEventId,
        };
        if (contact) d.handoffUrl = this.d.providers.messaging.handoffUrl(d, contact);
        s.drafts.push(d);
        push(`Drafted a ${plan.channel === 'email' ? 'email' : 'message'} to ${contact?.name ?? 'them'}`, 'draft', d.id, null, d, true);
        return res;
      }
      case 'message.send': {
        const d = s.drafts.find((x) => x.id === plan.draftId);
        if (!d) throw new Error('draft not found');
        const contact = s.contacts.find((c) => c.id === d.to);
        if (!contact) throw new Error('recipient not found');
        const before = clone(d);
        const provider = d.channel === 'email' ? this.d.providers.email : this.d.providers.messaging;
        if (!provider?.capabilities.send) throw new Error('cannot-send');
        await provider.send(d, contact);
        d.status = 'sent';
        d.sentAt = now;
        d.updatedAt = now;
        if (d.reminderId) {
          const r = s.reminders.find((x) => x.id === d.reminderId);
          if (r && r.status === 'open') {
            r.status = 'done';
            r.completedAt = now;
          }
        }
        push(`Sent ${d.channel === 'email' ? 'email' : 'message'} to ${contact.name}`, 'draft', d.id, before, d, true, false);
        return res;
      }
      case 'email.archive':
      case 'email.delete': {
        const email = this.d.providers.email;
        if (!email) throw new Error('no-email');
        if (plan.type === 'email.archive') await email.archive(plan.ids);
        else await email.trash(plan.ids);
        push(`${plan.type === 'email.archive' ? 'Archived' : 'Deleted'} ${plan.ids.length} ${plan.label}`, 'email', plan.ids.join(','), { ids: plan.ids }, { ids: plan.ids, action: plan.type }, true, plan.type === 'email.archive');
        return res;
      }
      case 'booking.create': {
        const b = this.d.providers.bookings;
        if (!b) throw new Error('no-bookings');
        const conf = await b.book(plan.serviceId, plan.slotId);
        const tz = s.profile.timeZone;
        const e = await this.d.providers.calendar.create({
          title: capital(plan.service), start: conf.start.toISOString(), end: conf.end.toISOString(), timeZone: tz, attendees: [],
          notes: `Booked via ${b.label}. Confirmation: ${conf.confirmation}`,
        });
        push(`Booked ${plan.service} (confirmation ${conf.confirmation})`, 'event', e.id, null, e, !!(await this.d.providers.calendar.get(e.id)), false);
        this.observe('booking', plan.service.toLowerCase(), { provider: b.id, serviceId: plan.serviceId });
        res.data = { confirmation: conf.confirmation, event: e };
        return res;
      }
      case 'purchase.create': {
        const p = this.d.providers.purchases;
        if (!p) throw new Error('no-purchases');
        const r = await p.purchase(plan.productId);
        push(`Bought ${plan.name} (order ${r.orderId})`, 'note', r.orderId, null, { orderId: r.orderId, name: plan.name, price: plan.price }, true, false);
        res.data = { orderId: r.orderId };
        return res;
      }
      case 'waiting.create': {
        const w: WaitingItem = {
          id: this.d.ids('wait'), direction: plan.direction, personId: plan.personId, who: plan.who, about: plan.about, since: now,
          status: 'waiting', relatedId: plan.relatedId, notifyOnReply: plan.notifyOnReply ?? false,
        };
        s.waiting.push(w);
        push(plan.direction === 'them' ? `Tracking: waiting for ${plan.who}${plan.about ? ` (${plan.about})` : ''}` : `${plan.who} is waiting on you${plan.about ? ` (${plan.about})` : ''}`, 'waiting', w.id, null, w, true);
        return res;
      }
      case 'waiting.resolve': {
        const w = s.waiting.find((x) => x.id === plan.id);
        if (!w) throw new Error('waiting item not found');
        const before = clone(w);
        w.status = 'resolved';
        w.resolvedAt = now;
        push(w.direction === 'them' ? `${w.who} replied` : `Answered ${w.who}`, 'waiting', w.id, before, w, true);
        return res;
      }
      case 'memory.store': {
        const existing = s.memories.find((m) => m.kind === plan.memory.kind && m.subject.toLowerCase() === plan.memory.subject.toLowerCase() && (m.kind !== 'fact' || m.value === plan.memory.value));
        if (existing) {
          const before = clone(existing);
          Object.assign(existing, plan.memory, { lastObservedAt: now, observationCount: existing.observationCount + 1 });
          push(`Remembered: ${existing.subject} — ${existing.value}`, 'memory', existing.id, before, existing, true);
          return res;
        }
        const m: Memory = { ...plan.memory, id: this.d.ids('mem'), learnedAt: now, lastObservedAt: now, observationCount: 1 };
        s.memories.push(m);
        push(`Remembered: ${m.subject} — ${m.value}`, 'memory', m.id, null, m, true);
        return res;
      }
      case 'memory.delete': {
        const i = s.memories.findIndex((m) => m.id === plan.id);
        if (i < 0) throw new Error('memory not found');
        const [m] = s.memories.splice(i, 1);
        push(`Forgot: ${m.subject} — ${m.value}`, 'memory', m.id, m, null, !s.memories.find((x) => x.id === plan.id));
        return res;
      }
      case 'contact.upsert': {
        let c = plan.id ? s.contacts.find((x) => x.id === plan.id) : undefined;
        if (c) {
          const before = clone(c);
          Object.assign(c, plan.patch);
          push(`Updated ${c.name}`, 'contact', c.id, before, c, true);
        } else {
          c = { id: this.d.ids('person'), name: plan.name, aliases: [], source: 'told', createdAt: now, ...plan.patch };
          s.contacts.push(c);
          push(`Added ${c.name} to people I know`, 'contact', c.id, null, c, true);
        }
        res.data = { contact: c };
        return res;
      }
      case 'routine.create': {
        const r: Routine = { ...plan.routine, id: this.d.ids('routine'), createdAt: now, handled: [] };
        s.routines.push(r);
        push(`Remembered routine: ${r.title}`, 'routine', r.id, null, r, true);
        return res;
      }
      case 'routine.update': {
        const r = s.routines.find((x) => x.id === plan.id);
        if (!r) throw new Error('routine not found');
        const before = clone(r);
        Object.assign(r, plan.patch);
        push(`Updated routine: ${r.title}`, 'routine', r.id, before, r, true);
        return res;
      }
    }
  }

  /** Reverse a ledger entry where possible. */
  async undo(entry: LedgerEntry): Promise<{ ok: boolean; message: string }> {
    const s = this.s;
    if (!entry.undoable || entry.undoneAt) {
      return { ok: false, message: entry.actionType === 'message.send' ? "That's already been sent, so I can't take it back." : "I can't undo that one." };
    }
    const now = this.d.clock().toISOString();
    const restoreIn = <T extends { id: string }>(list: T[], before: T | null, id: string, removeStatus?: Partial<T>) => {
      const i = list.findIndex((x) => x.id === id);
      if (before) {
        if (i >= 0) list[i] = clone(before);
        else list.push(clone(before));
      } else if (i >= 0) {
        if (removeStatus) Object.assign(list[i], removeStatus);
        else list.splice(i, 1);
      }
    };
    switch (entry.entity) {
      case 'event': {
        const before = entry.before as CalendarEvent | null;
        if (before) await this.d.providers.calendar.restore(before);
        else await this.d.providers.calendar.cancel(entry.entityId);
        break;
      }
      case 'reminder':
        restoreIn(s.reminders, entry.before as Reminder | null, entry.entityId, { status: 'archived' } as Partial<Reminder>);
        break;
      case 'shopping':
        restoreIn(s.shopping, entry.before as ShoppingItem | null, entry.entityId, { status: 'removed' } as Partial<ShoppingItem>);
        break;
      case 'note':
        restoreIn(s.notes, entry.before as any, entry.entityId);
        break;
      case 'draft':
        restoreIn(s.drafts, entry.before as Draft | null, entry.entityId, { status: 'discarded' } as Partial<Draft>);
        break;
      case 'waiting':
        restoreIn(s.waiting, entry.before as WaitingItem | null, entry.entityId);
        break;
      case 'memory':
        restoreIn(s.memories, entry.before as Memory | null, entry.entityId);
        break;
      case 'contact':
        restoreIn(s.contacts, entry.before as Contact | null, entry.entityId);
        break;
      case 'routine':
        restoreIn(s.routines, entry.before as Routine | null, entry.entityId);
        break;
      case 'email': {
        const ids = (entry.before as { ids: string[] }).ids;
        await this.d.providers.email?.unarchive(ids);
        break;
      }
    }
    entry.undoneAt = now;
    return { ok: true, message: 'Undone.' };
  }
}

function capital(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
