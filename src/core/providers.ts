// Provider abstractions. The intelligence engine only talks to these interfaces,
// so it stays independent of Google/Apple/Microsoft/Zoom/etc.
// Local providers keep data in the user's own Brain Dump state and are honest about
// what they cannot do (e.g. they cannot send an email — they prepare a hand-off link).

import type { CalendarEvent, Contact, Draft, EmailMessage, UserState } from './types.js';
import type { IdGen } from './text.js';

export interface ProviderCapabilities {
  write: boolean;
  /** Can deliver messages/invites on the user's behalf (not just prepare them). */
  send?: boolean;
}

export type NewEvent = Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt' | 'source' | 'status'>;

export interface CalendarProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  list(from: Date, to: Date): Promise<CalendarEvent[]>;
  get(id: string): Promise<CalendarEvent | undefined>;
  create(ev: NewEvent): Promise<CalendarEvent>;
  update(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent>;
  cancel(id: string): Promise<void>;
  /** Restore a previously cancelled event (reversibility). */
  restore(ev: CalendarEvent): Promise<CalendarEvent>;
}

export interface EmailQuery {
  from?: string;
  since?: Date;
  category?: 'promotions' | 'social' | 'updates' | 'inbox';
  text?: string;
  limit?: number;
}

export interface EmailProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  search(q: EmailQuery): Promise<EmailMessage[]>;
  archive(ids: string[]): Promise<void>;
  unarchive(ids: string[]): Promise<void>;
  trash(ids: string[]): Promise<void>;
  /** Deliver a message. Only called when capabilities.send is true and policy allows. */
  send(draft: Draft, to: Contact): Promise<{ id: string }>;
}

export interface MessagingProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  /** A deep link that opens the user's own messaging app with the text ready. */
  handoffUrl(draft: Draft, to: Contact): string | undefined;
  send(draft: Draft, to: Contact): Promise<{ id: string }>;
}

export interface MeetingProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  create(input: { title: string; start: Date; end: Date; attendees: Contact[] }): Promise<{ url: string; provider: string; id?: string }>;
}

export interface BookingSlot {
  id: string;
  start: Date;
  end: Date;
  label?: string;
  price?: { amount: number; currency: string };
}

export interface BookingService {
  id: string;
  name: string;
  provider: string;
}

export interface BookingProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  findServices(query: string): Promise<BookingService[]>;
  availability(serviceId: string, from: Date, to: Date): Promise<BookingSlot[]>;
  book(serviceId: string, slotId: string): Promise<{ confirmation: string; start: Date; end: Date }>;
}

export interface Product {
  id: string;
  name: string;
  price: { amount: number; currency: string };
}

export interface PurchaseProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  find(query: string): Promise<Product | undefined>;
  purchase(productId: string): Promise<{ orderId: string }>;
}

export interface MusicProvider {
  readonly id: string;
  readonly label: string;
  /** Returns a deep link that starts the playlist in the user's music app. */
  prepare(playlist: string): Promise<{ url: string; label: string }>;
}

export interface FitnessProvider {
  readonly id: string;
  readonly label: string;
  prepare(activity: string): Promise<{ url: string; label: string }>;
}

export interface Providers {
  calendar: CalendarProvider;
  email?: EmailProvider;
  messaging: MessagingProvider;
  meetings?: MeetingProvider;
  bookings?: BookingProvider;
  purchases?: PurchaseProvider;
  music?: MusicProvider;
  fitness?: FitnessProvider;
}

// ---------------------------------------------------------------------------
// Local implementations
// ---------------------------------------------------------------------------

export class LocalCalendar implements CalendarProvider {
  readonly id = 'local';
  readonly label = 'Brain Dump calendar';
  readonly capabilities = { write: true };
  constructor(private getState: () => UserState, private ids: IdGen, private clock: () => Date) {}

  async list(from: Date, to: Date): Promise<CalendarEvent[]> {
    const f = from.getTime();
    const t = to.getTime();
    return this.getState()
      .events.filter((e) => e.status === 'confirmed' && Date.parse(e.end) > f && Date.parse(e.start) < t)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }
  async get(id: string) {
    return this.getState().events.find((e) => e.id === id);
  }
  async create(ev: NewEvent): Promise<CalendarEvent> {
    const now = this.clock().toISOString();
    const e: CalendarEvent = { ...ev, id: this.ids('evt'), status: 'confirmed', source: 'local', createdAt: now, updatedAt: now };
    this.getState().events.push(e);
    return e;
  }
  async update(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const e = this.getState().events.find((x) => x.id === id);
    if (!e) throw new Error(`event ${id} not found`);
    Object.assign(e, patch, { id, updatedAt: this.clock().toISOString() });
    return e;
  }
  async cancel(id: string): Promise<void> {
    // Soft cancel: kept for undo and history.
    await this.update(id, { status: 'cancelled' });
  }
  async restore(ev: CalendarEvent): Promise<CalendarEvent> {
    const s = this.getState();
    const existing = s.events.find((x) => x.id === ev.id);
    if (existing) {
      Object.assign(existing, ev, { updatedAt: this.clock().toISOString() });
      return existing;
    }
    s.events.push({ ...ev });
    return ev;
  }
}

/** Local mailbox: used when no email account is connected (and in tests). Cannot send. */
export class LocalMailbox implements EmailProvider {
  readonly id = 'local-mail';
  readonly label = 'Mailbox';
  readonly capabilities = { write: true, send: false };
  constructor(private getState: () => UserState) {}
  async search(q: EmailQuery): Promise<EmailMessage[]> {
    let list = this.getState().mailbox.filter((m) => !m.labels.includes('TRASH'));
    if (q.category === 'promotions') list = list.filter((m) => m.labels.includes('CATEGORY_PROMOTIONS'));
    else if (q.category !== undefined || !q.from) list = list.filter((m) => m.labels.includes('INBOX') || q.category === undefined);
    if (q.from) {
      const f = q.from.toLowerCase();
      list = list.filter((m) => m.from.toLowerCase().includes(f) || (m.fromName ?? '').toLowerCase().includes(f));
    }
    if (q.since) list = list.filter((m) => Date.parse(m.receivedAt) >= q.since!.getTime());
    if (q.text) {
      const t = q.text.toLowerCase();
      list = list.filter((m) => `${m.subject} ${m.snippet}`.toLowerCase().includes(t));
    }
    return list.slice(0, q.limit ?? 100);
  }
  async archive(ids: string[]) {
    for (const m of this.getState().mailbox) if (ids.includes(m.id)) m.labels = m.labels.filter((l) => l !== 'INBOX');
  }
  async unarchive(ids: string[]) {
    for (const m of this.getState().mailbox) if (ids.includes(m.id) && !m.labels.includes('INBOX')) m.labels.push('INBOX');
  }
  async trash(ids: string[]) {
    for (const m of this.getState().mailbox) if (ids.includes(m.id)) m.labels = ['TRASH'];
  }
  async send(): Promise<{ id: string }> {
    throw new Error('No email account is connected, so I can only prepare emails.');
  }
}

/**
 * Hand-off messaging: prepares the message in the user's own app (WhatsApp / SMS / mail)
 * via official deep links. It never pretends to have sent anything.
 */
export class HandoffMessaging implements MessagingProvider {
  readonly id = 'handoff';
  readonly label = 'your messaging app';
  readonly capabilities = { write: true, send: false };
  handoffUrl(draft: Draft, to: Contact): string | undefined {
    return handoffLinks(draft, to)[0]?.url;
  }
  async send(): Promise<{ id: string }> {
    throw new Error('Direct sending is not connected; the message was prepared for you instead.');
  }
}

/** Official deep links that open the user's own app with the message ready to send. */
export function handoffLinks(draft: Pick<Draft, 'channel' | 'body' | 'subject'>, to: Pick<Contact, 'name' | 'phone' | 'email'>): { label: string; url: string }[] {
  const text = encodeURIComponent(draft.body);
  const phone = (to.phone ?? '').replace(/[^\d+]/g, '');
  const first = to.name.split(' ')[0];
  const whatsapp = { label: `Send to ${first} on WhatsApp`, url: phone ? `https://wa.me/${phone.replace(/^\+/, '')}?text=${text}` : `https://wa.me/?text=${text}` };
  // iOS Messages: sms:<number>&body=… (the & form is what iOS expects).
  const sms = { label: `Send to ${first} in Messages`, url: `sms:${phone}&body=${text}` };
  const mail = { label: `Open email to ${first}`, url: `mailto:${to.email ?? ''}?subject=${encodeURIComponent(draft.subject ?? '')}&body=${text}` };
  switch (draft.channel) {
    case 'email':
      return [mail];
    case 'whatsapp':
      return [whatsapp];
    case 'sms':
      return [sms];
    default:
      return [whatsapp, sms];
  }
}

/** Music: universal links open Spotify / Apple Music at a search for what was asked. */
export function musicLinks(query: string, service?: string): { label: string; url: string }[] {
  const q = encodeURIComponent(query);
  const spotify = { label: 'Play in Spotify', url: `https://open.spotify.com/search/${q}` };
  const apple = { label: 'Play in Apple Music', url: `https://music.apple.com/search?term=${q}` };
  const youtube = { label: 'Play in YouTube Music', url: `https://music.youtube.com/search?q=${q}` };
  if (service && /spotify/.test(service)) return [spotify];
  if (service && /apple/.test(service)) return [apple];
  if (service && /youtube/.test(service)) return [youtube];
  return [spotify, apple];
}

/** Uses the user's own personal meeting link (e.g. Zoom personal room) when no meeting API is connected. */
export class PersonalLinkMeetings implements MeetingProvider {
  readonly id = 'personal-link';
  readonly label = 'your personal meeting link';
  readonly capabilities = { write: true };
  constructor(private getState: () => UserState) {}
  async create(): Promise<{ url: string; provider: string }> {
    const link = this.getState().profile.preferences.personalMeetingLink;
    if (!link) throw new Error('no-meeting-link');
    return { url: link.url, provider: link.provider };
  }
}

/** Spotify / Apple Music deep links — opening a playlist is fully supported without an API key. */
export class DeepLinkMusic implements MusicProvider {
  readonly id = 'spotify-link';
  readonly label = 'Spotify';
  async prepare(playlist: string) {
    return { url: `spotify:search:${encodeURIComponent(playlist)}`, label: `Open "${playlist}" in Spotify` };
  }
}

export class DeepLinkFitness implements FitnessProvider {
  readonly id = 'strava-link';
  readonly label = 'Strava';
  async prepare(activity: string) {
    return { url: 'strava://record', label: `Open Strava to record your ${activity}` };
  }
}

export function localProviders(getState: () => UserState, ids: IdGen, clock: () => Date): Providers {
  return {
    calendar: new LocalCalendar(getState, ids, clock),
    email: new LocalMailbox(getState),
    messaging: new HandoffMessaging(),
    meetings: new PersonalLinkMeetings(getState),
    music: new DeepLinkMusic(),
    fitness: new DeepLinkFitness(),
  };
}
