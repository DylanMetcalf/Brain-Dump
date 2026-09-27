// In-browser "server" for the phone test build: the same engine, running entirely on the
// device, with state kept in this browser's storage. Implements the subset of the HTTP API
// the web client uses, so the UI is identical to the full app.

import { Assistant } from '../core/assistant.js';
import { handledSummary, needsMe, needsMeText } from '../core/briefing.js';
import { tick } from '../core/scheduler.js';
import { ALL_SCOPES, createUserState, grantPermission, migrateState, setTrust } from '../core/state.js';
import { formatWhen, isValidTimeZone } from '../core/time.js';
import type { AppNotification, PermissionLevel, Scope, UserState } from '../core/types.js';
import { clientState } from '../core/view.js';

const KEY = 'bd.local.state';
type Listener = (type: string, data: unknown) => void;

export class LocalServer {
  private state: UserState;
  private listeners = new Set<Listener>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor() {
    this.state = this.load() ?? createUserState('local', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', new Date());
    this.save();
    setInterval(() => void this.runTick(), 30_000);
    setTimeout(() => void this.runTick(), 2000);
  }

  private load(): UserState | undefined {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? migrateState(JSON.parse(raw)) : undefined;
    } catch {
      return undefined;
    }
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.state));
    } catch {
      /* storage unavailable: keep working in memory */
    }
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: string, data: unknown) {
    for (const l of this.listeners) l(type, data);
  }

  private async runTick() {
    const out: AppNotification[] = [];
    await this.serial(async () => {
      const r = await tick(new Assistant(this.state), new Date());
      out.push(...r.notifications);
    });
    for (const n of out) this.emit('notification', n);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const before = this.state.version;
      const r = await fn();
      if (this.state.version !== before) this.save();
      return r;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  reset() {
    try {
      localStorage.removeItem(KEY);
    } catch {}
    this.state = createUserState('local', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', new Date());
    this.save();
  }

  async request(path: string, method: string, body: any): Promise<unknown> {
    const url = new URL(path, 'http://local');
    const p = url.pathname;
    const a = () => new Assistant(this.state);
    const s = () => this.state;
    const bump = () => (this.state.version += 1);
    const m = (re: RegExp) => p.match(re);
    let mm: RegExpMatchArray | null;

    return this.serial(async () => {
      if (p === '/api/auth/register') return { token: 'local', userId: 'local' };
      if (p === '/api/session/start') return a().start({ sessionId: body?.sessionId, device: 'phone' });
      if (p === '/api/utterance') return a().handle({ text: String(body?.text ?? ''), sessionId: body?.sessionId, clientId: body?.clientId, device: 'phone' });
      if (p === '/api/session/end') return a().end(String(body?.sessionId ?? ''));
      if (p === '/api/sync') return { replies: [] };
      if (p === '/api/state') return clientState(s(), new Date());
      if (p === '/api/overview') {
        const now = new Date();
        const st = s();
        const items = needsMe(st, now);
        const undated = st.reminders.filter((r) => r.status === 'open' && !r.dueAt && r.kind === 'task').length;
        return {
          version: st.version,
          assistantName: st.profile.assistantName,
          onboarding: st.profile.onboarding,
          needsMe: { text: needsMeText(items, undated), items },
          handledToday: handledSummary(st, now, 'today'),
          upcoming: st.events
            .filter((e) => e.status === 'confirmed' && Date.parse(e.end) > now.getTime() && Date.parse(e.start) < now.getTime() + 7 * 86400000)
            .sort((x, y) => Date.parse(x.start) - Date.parse(y.start))
            .slice(0, 12)
            .map((e) => ({ id: e.id, title: e.title, when: formatWhen(new Date(e.start), st.profile.timeZone, now, e.allDay), start: e.start, meeting: e.meeting })),
          unread: st.notifications.filter((n) => !n.read && n.kind !== 'system').length,
        };
      }
      if (p === '/api/history') {
        return {
          sessions: s().sessions.filter((x) => x.device !== 'automation').slice(-30).reverse().map((x) => ({ id: x.id, startedAt: x.startedAt, endedAt: x.endedAt, turns: x.turns })),
          ledger: s().ledger.slice(-300).reverse(),
        };
      }
      if ((mm = m(/^\/api\/undo\/(.+)$/))) return a().undoEntry(decodeURIComponent(mm[1]));
      if (p === '/api/profile') {
        const st = s();
        const b = body ?? {};
        if (typeof b.assistantName === 'string' && b.assistantName.trim()) st.profile.assistantName = b.assistantName.trim().slice(0, 40);
        if (typeof b.timeZone === 'string' && isValidTimeZone(b.timeZone)) st.profile.timeZone = b.timeZone;
        const q = b.preferences;
        if (q) {
          const pr = st.profile.preferences;
          if (typeof q.voiceReplies === 'boolean') pr.voiceReplies = q.voiceReplies;
          if (q.proactivity === 'quiet' || q.proactivity === 'normal') pr.proactivity = q.proactivity;
          if (q.clearMeans === 'archive' || q.clearMeans === 'delete') pr.clearMeans = q.clearMeans;
          if (Number.isFinite(q.defaultEventLeadMin)) pr.defaultEventLeadMin = Number(q.defaultEventLeadMin);
          if (q.weeklyBriefing) pr.weeklyBriefing = { ...pr.weeklyBriefing, enabled: !!q.weeklyBriefing.enabled };
        }
        bump();
        return { profile: st.profile };
      }
      if ((mm = m(/^\/api\/permissions\/(\w+)$/))) {
        const scope = mm[1] as Scope;
        const level = body?.level as PermissionLevel;
        if (!ALL_SCOPES.includes(scope) || !['none', 'read', 'draft', 'act'].includes(level)) throw new Error('bad scope or level');
        grantPermission(s(), scope, level, 'settings', new Date());
        bump();
        return { permissions: s().permissions };
      }
      if ((mm = m(/^\/api\/trust\/(.+)$/))) {
        setTrust(s(), decodeURIComponent(mm[1]), !!body?.trusted, new Date());
        bump();
        return { trust: s().trust };
      }
      if ((mm = m(/^\/api\/memories\/(.+)$/))) {
        const id = mm[1];
        if (method === 'DELETE') s().memories = s().memories.filter((x) => x.id !== id);
        else {
          const mem = s().memories.find((x) => x.id === id);
          if (mem && body?.confirmed) {
            mem.confirmed = true;
            mem.provenance = 'confirmed';
          }
        }
        bump();
        return { ok: true };
      }
      if ((mm = m(/^\/api\/routines\/(.+)$/))) {
        const id = mm[1];
        if (method === 'DELETE') s().routines = s().routines.filter((x) => x.id !== id);
        else {
          const r = s().routines.find((x) => x.id === id);
          if (r && ['confirmed', 'automated', 'paused'].includes(body?.status)) r.status = body.status;
        }
        bump();
        return { ok: true };
      }
      if ((mm = m(/^\/api\/items\/(\w+)\/(.+)$/))) {
        const [, kind, id] = mm;
        const action = String(body?.action ?? 'complete');
        const plan =
          kind === 'shopping' ? { type: action === 'remove' ? 'shopping.remove' : 'shopping.complete', ids: [id] }
          : kind === 'reminder' ? { type: action === 'remove' ? 'reminder.archive' : 'reminder.complete', id }
          : kind === 'waiting' ? { type: 'waiting.resolve', id }
          : undefined;
        if (plan) await a().exec.execute(plan as any, { auto: false, risk: 'low' });
        if (kind === 'draft') {
          const d = s().drafts.find((x) => x.id === id);
          if (d) d.status = action === 'discard' ? 'discarded' : 'handed_off';
        }
        bump();
        return { ok: true };
      }
      if ((mm = m(/^\/api\/notifications\/(.+)\/act$/))) return a().actOnNotification(mm[1], String(body?.value ?? ''));
      if (p === '/api/devices') return { devices: [{ id: 'local', name: 'This phone', createdAt: s().profile.createdAt, lastSeenAt: new Date().toISOString(), current: true }] };
      if (p === '/api/integrations') return { available: { google: false, services: [] }, connected: {} };
      if (p === '/api/account' && method === 'DELETE') {
        this.reset();
        return { ok: true };
      }
      throw new Error('That needs the full Brain Dump server — it isn’t available in the phone test version.');
    });
  }
}
