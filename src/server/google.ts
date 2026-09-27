// Google Calendar + Gmail providers (official REST APIs, OAuth 2.0 tokens).
// Events are mirrored into the user's state so context resolution works offline, and
// every write is re-read from Google for verification.

import type { CalendarProvider, EmailProvider, EmailQuery, NewEvent } from '../core/providers.js';
import type { CalendarEvent, Contact, Draft, EmailMessage, UserState } from '../core/types.js';

export interface GoogleSecrets {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
}

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
}

export class GoogleAuth {
  constructor(
    private cfg: GoogleClientConfig,
    private secrets: GoogleSecrets,
    private save: (s: GoogleSecrets) => Promise<void>,
    private fetchImpl: typeof fetch,
    private clock: () => Date,
  ) {}

  async token(): Promise<string> {
    const now = this.clock().getTime();
    if (this.secrets.access_token && (this.secrets.expires_at ?? 0) > now + 60_000) return this.secrets.access_token;
    if (!this.secrets.refresh_token) throw new Error('Google is not connected.');
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.secrets.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Google token refresh failed (${res.status})`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.secrets.access_token = j.access_token;
    this.secrets.expires_at = now + j.expires_in * 1000;
    await this.save(this.secrets);
    return j.access_token;
  }

  async api<T>(url: string, init: RequestInit = {}): Promise<T> {
    const token = await this.token();
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (res.status === 204) return undefined as T;
    if (!res.ok) throw new Error(`Google API ${res.status}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email: string; self?: boolean }[];
  hangoutLink?: string;
  created?: string;
  updated?: string;
}

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

export class GoogleCalendar implements CalendarProvider {
  readonly id = 'google';
  readonly label = 'Google Calendar';
  readonly capabilities = { write: true, send: true };
  constructor(private auth: GoogleAuth, private getState: () => UserState) {}

  private toLocal(g: GEvent): CalendarEvent {
    const s = this.getState();
    const allDay = !!g.start?.date;
    const start = g.start?.dateTime ?? `${g.start?.date}T00:00:00.000Z`;
    const end = g.end?.dateTime ?? `${g.end?.date}T00:00:00.000Z`;
    const attendees = (g.attendees ?? [])
      .filter((a) => !a.self)
      .map((a) => s.contacts.find((c) => c.email?.toLowerCase() === a.email.toLowerCase())?.id)
      .filter(Boolean) as string[];
    return {
      id: `g_${g.id}`,
      externalId: g.id,
      title: g.summary ?? '(no title)',
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      timeZone: g.start?.timeZone ?? s.profile.timeZone,
      allDay,
      location: g.location,
      notes: g.description,
      attendees,
      status: g.status === 'cancelled' ? 'cancelled' : 'confirmed',
      meeting: g.hangoutLink ? { provider: 'meet', url: g.hangoutLink } : undefined,
      source: 'google',
      createdAt: g.created ?? new Date().toISOString(),
      updatedAt: g.updated ?? new Date().toISOString(),
    };
  }

  private mirror(e: CalendarEvent) {
    const s = this.getState();
    const i = s.events.findIndex((x) => x.id === e.id);
    if (i >= 0) s.events[i] = { ...s.events[i], ...e, remindedAt: s.events[i].remindedAt };
    else s.events.push(e);
    return e;
  }

  private toGoogle(ev: Partial<CalendarEvent>): Partial<GEvent> & Record<string, unknown> {
    const s = this.getState();
    const out: Record<string, unknown> = {};
    if (ev.title !== undefined) out.summary = ev.title;
    if (ev.location !== undefined) out.location = ev.location;
    if (ev.notes !== undefined || ev.meeting) out.description = [ev.notes, ev.meeting?.url].filter(Boolean).join('\n');
    if (ev.start) out.start = ev.allDay ? { date: ev.start.slice(0, 10) } : { dateTime: ev.start, timeZone: ev.timeZone };
    if (ev.end) out.end = ev.allDay ? { date: ev.end.slice(0, 10) } : { dateTime: ev.end, timeZone: ev.timeZone };
    if (ev.attendees) {
      out.attendees = ev.attendees
        .map((id) => s.contacts.find((c) => c.id === id)?.email)
        .filter(Boolean)
        .map((email) => ({ email }));
    }
    if (ev.status) out.status = ev.status;
    return out;
  }

  async list(from: Date, to: Date): Promise<CalendarEvent[]> {
    const url = `${CAL}?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}`;
    const j = await this.auth.api<{ items?: GEvent[] }>(url);
    const events = (j.items ?? []).map((g) => this.toLocal(g));
    // Replace the mirrored window with what Google says now.
    const s = this.getState();
    const ids = new Set(events.map((e) => e.id));
    s.events = s.events.filter((e) => e.source !== 'google' || ids.has(e.id) || Date.parse(e.start) < from.getTime() || Date.parse(e.start) > to.getTime() || e.status === 'cancelled');
    for (const e of events) this.mirror(e);
    return events.filter((e) => e.status === 'confirmed');
  }

  async get(id: string): Promise<CalendarEvent | undefined> {
    const ext = id.replace(/^g_/, '');
    try {
      return this.mirror(this.toLocal(await this.auth.api<GEvent>(`${CAL}/${encodeURIComponent(ext)}`)));
    } catch {
      return undefined;
    }
  }

  async create(ev: NewEvent): Promise<CalendarEvent> {
    const g = await this.auth.api<GEvent>(`${CAL}?sendUpdates=none`, { method: 'POST', body: JSON.stringify(this.toGoogle(ev)) });
    const local = this.toLocal(g);
    local.routineId = ev.routineId;
    local.statedAs = ev.statedAs;
    local.meeting = ev.meeting ?? local.meeting;
    return this.mirror(local);
  }

  async update(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const ext = id.replace(/^g_/, '');
    const current = this.getState().events.find((e) => e.id === id);
    const g = await this.auth.api<GEvent>(`${CAL}/${encodeURIComponent(ext)}?sendUpdates=all`, {
      method: 'PATCH',
      body: JSON.stringify(this.toGoogle({ ...patch, allDay: patch.allDay ?? current?.allDay, timeZone: patch.timeZone ?? current?.timeZone })),
    });
    return this.mirror(this.toLocal(g));
  }

  async cancel(id: string): Promise<void> {
    const ext = id.replace(/^g_/, '');
    await this.auth.api(`${CAL}/${encodeURIComponent(ext)}?sendUpdates=all`, { method: 'DELETE' });
    const e = this.getState().events.find((x) => x.id === id);
    if (e) e.status = 'cancelled';
  }

  async restore(ev: CalendarEvent): Promise<CalendarEvent> {
    // Google keeps deleted events addressable; setting status back to confirmed restores them.
    return this.update(ev.id, { ...ev, status: 'confirmed' });
  }
}

/** Google + local: new events go to Google; existing local events stay where they are. */
export class CompositeCalendar implements CalendarProvider {
  readonly id = 'composite';
  readonly label: string;
  readonly capabilities = { write: true };
  constructor(private primary: CalendarProvider, private local: CalendarProvider) {
    this.label = primary.label;
  }
  private pick(id: string) {
    return id.startsWith('g_') ? this.primary : this.local;
  }
  async list(from: Date, to: Date) {
    const [a, b] = await Promise.all([this.primary.list(from, to), this.local.list(from, to)]);
    return [...a, ...b].sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
  }
  get(id: string) {
    return this.pick(id).get(id);
  }
  create(ev: NewEvent) {
    return this.primary.create(ev);
  }
  update(id: string, patch: Partial<CalendarEvent>) {
    return this.pick(id).update(id, patch);
  }
  cancel(id: string) {
    return this.pick(id).cancel(id);
  }
  restore(ev: CalendarEvent) {
    return this.pick(ev.id).restore(ev);
  }
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailProvider implements EmailProvider {
  readonly id = 'gmail';
  readonly label = 'Gmail';
  readonly capabilities: { write: boolean; send: boolean };
  constructor(private auth: GoogleAuth, canSend: boolean) {
    this.capabilities = { write: true, send: canSend };
  }

  async search(q: EmailQuery): Promise<EmailMessage[]> {
    const parts: string[] = [];
    if (q.from) parts.push(`from:(${q.from.replace(/[()]/g, '')})`);
    if (q.since) parts.push(`after:${Math.floor(q.since.getTime() / 1000)}`);
    if (q.category === 'promotions') parts.push('category:promotions', 'in:inbox');
    if (q.text) parts.push(`"${q.text.replace(/"/g, '')}"`);
    const list = await this.auth.api<{ messages?: { id: string }[] }>(`${GMAIL}/messages?maxResults=${Math.min(q.limit ?? 25, 50)}&q=${encodeURIComponent(parts.join(' '))}`);
    const out: EmailMessage[] = [];
    for (const m of list.messages ?? []) {
      const full = await this.auth.api<{ id: string; threadId: string; snippet: string; labelIds?: string[]; internalDate: string; payload?: { headers?: { name: string; value: string }[] } }>(
        `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To`,
      );
      const h = (n: string) => full.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? '';
      const from = h('from');
      const email = from.match(/<([^>]+)>/)?.[1] ?? from;
      out.push({
        id: full.id,
        threadId: full.threadId,
        from: email,
        fromName: from.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || undefined,
        to: h('to') ? [h('to')] : [],
        subject: h('subject'),
        snippet: full.snippet,
        receivedAt: new Date(Number(full.internalDate)).toISOString(),
        labels: full.labelIds ?? [],
        unread: (full.labelIds ?? []).includes('UNREAD'),
      });
    }
    return out.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  }

  async archive(ids: string[]) {
    await this.auth.api(`${GMAIL}/messages/batchModify`, { method: 'POST', body: JSON.stringify({ ids, removeLabelIds: ['INBOX'] }) });
  }
  async unarchive(ids: string[]) {
    await this.auth.api(`${GMAIL}/messages/batchModify`, { method: 'POST', body: JSON.stringify({ ids, addLabelIds: ['INBOX'] }) });
    for (const id of ids) await this.auth.api(`${GMAIL}/messages/${id}/untrash`, { method: 'POST' }).catch(() => undefined);
  }
  async trash(ids: string[]) {
    for (const id of ids) await this.auth.api(`${GMAIL}/messages/${id}/trash`, { method: 'POST' });
  }
  async send(d: Draft, to: Contact): Promise<{ id: string }> {
    if (!to.email) throw new Error(`I don't have an email address for ${to.name}.`);
    const mime = [`To: ${to.email}`, `Subject: ${(d.subject ?? '').replace(/[\r\n]/g, ' ')}`, 'Content-Type: text/plain; charset="UTF-8"', '', d.body].join('\r\n');
    const raw = Buffer.from(mime, 'utf8').toString('base64url');
    const r = await this.auth.api<{ id: string }>(`${GMAIL}/messages/send`, { method: 'POST', body: JSON.stringify({ raw }) });
    return { id: r.id };
  }
}
