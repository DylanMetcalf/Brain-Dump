// Brain Dump HTTP server: a thin, secure shell around the core engine.
//  • Passwordless auth: each device holds a random bearer token (stored hashed);
//    more devices join via a short-lived 6-digit pairing code.
//  • Every user document is encrypted at rest.
//  • Server-Sent Events push "something changed" to all of a user's devices.

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { Assistant } from '../core/assistant.js';
import { handledSummary, needsMe, needsMeText } from '../core/briefing.js';
import type { Providers } from '../core/providers.js';
import { tick } from '../core/scheduler.js';
import { ALL_SCOPES, grantPermission, setTrust } from '../core/state.js';
import { randomId } from '../core/text.js';
import { formatWhen, isValidTimeZone } from '../core/time.js';
import type { AppNotification, PermissionLevel, Scope, UserState } from '../core/types.js';
import { clientState } from '../core/view.js';
import { hashToken, newToken, pairingCode, safeEqual } from './crypto.js';
import { toICS } from './ics.js';
import { DeviceRecord, loadOrCreateKey, Store } from './store.js';
import { integrationRoutes, providersFor, IntegrationConfig } from './integrations.js';
import { makeAskClaude, verifyKey } from './claude.js';
import { makeAskOpenAI, OPENAI_VOICES, speak, verifyOpenAIKey, withBackup } from './openai.js';
import { describeOutbox, enablePhoneSync, markSentToPhone, phoneOutbox } from '../core/phone.js';
import type { AskClaude } from '../core/assist.js';
import { isValidSubscription, PushSender, PushSubscriptionRecord } from './push.js';
import { createHmac, randomBytes } from 'node:crypto';
import { zonedToUtc, formatWhen as fmtWhen } from '../core/time.js';

export interface AppOptions {
  dataDir: string;
  key?: string;
  webDir?: string;
  clock?: () => Date;
  publicUrl?: string;
  integrations?: IntegrationConfig;
  /** Extra/override providers (tests, self-hosted adapters). */
  providers?: (userId: string) => Partial<Providers>;
  /** Server-wide Anthropic key (ANTHROPIC_API_KEY); a key saved in Settings takes precedence. */
  anthropicApiKey?: string;
  /** OpenAI key (ChatGPT) for natural-sounding spoken replies, and as a backup brain. */
  openaiApiKey?: string;
  /** An iCloud link to the ready-made Brain Dump Shortcut, so others install it in one tap. */
  shortcutUrl?: string;
  /** Test hook: replaces the real Claude call. */
  askClaude?: (userId: string) => AskClaude | undefined;
  tickIntervalMs?: number;
  /** When set, new accounts need this invite code (so a public server isn't open to strangers). */
  signupCode?: string;
  /** Web Push: public VAPID key for browsers, and the sender used by the scheduler. */
  push?: { publicKey: string; send: PushSender };
  corsOrigins?: string[];
  fetchImpl?: typeof fetch;
  /** New accounts allowed per IP per minute (default 10). */
  registrationsPerMinute?: number;
}

export interface App {
  server: Server;
  store: Store;
  tickAll(now?: Date): Promise<number>;
  close(): Promise<void>;
}

type PushPayloadLite = { title: string; body: string; tag?: string };

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: any;
  device?: DeviceRecord;
  ip: string;
}

type Handler = (c: Ctx) => Promise<unknown>;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export async function createApp(opts: AppOptions): Promise<App> {
  const clock = opts.clock ?? (() => new Date());
  const key = await loadOrCreateKey(opts.dataDir, opts.key);
  const store = new Store(opts.dataDir, key);
  await store.init();
  const webDir = opts.webDir ? resolve(opts.webDir) : undefined;

  const pairing = new Map<string, { userId: string; expires: number; attempts: number }>();
  const sse = new Map<string, Set<ServerResponse>>();
  const rate = new Map<string, { n: number; reset: number }>();

  function limit(bucket: string, max: number, windowMs: number) {
    const now = Date.now();
    const r = rate.get(bucket);
    if (!r || r.reset < now) {
      rate.set(bucket, { n: 1, reset: now + windowMs });
      return;
    }
    r.n += 1;
    if (r.n > max) throw new HttpError(429, 'Too many requests — try again shortly.');
  }

  /** The address people reach this server at: PUBLIC_URL, or worked out from the request. */
  function baseUrl(c: Ctx): string {
    if (opts.publicUrl && !/localhost|127\.0\.0\.1/.test(opts.publicUrl)) return opts.publicUrl.replace(/\/$/, '');
    const proto = String(c.req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http';
    const host = String(c.req.headers['x-forwarded-host'] ?? c.req.headers.host ?? 'localhost').split(',')[0].trim();
    return `${proto}://${host}`;
  }

  function broadcast(userId: string, event: string, data: unknown) {
    const set = sse.get(userId);
    if (!set) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(payload);
  }

  async function assistantFor(userId: string, state: UserState) {
    const secrets = await store.readSecrets(userId);
    const providers = {
      ...(await providersFor(state, secrets, opts.integrations ?? {}, clock, opts.fetchImpl, (s) => store.writeSecrets(userId, s))),
      ...(opts.providers?.(userId) ?? {}),
    };
    const key = typeof secrets.anthropic?.apiKey === 'string' ? secrets.anthropic.apiKey : opts.anthropicApiKey;
    const openaiKey = openaiKeyFrom(secrets);
    const askClaude = opts.askClaude ? opts.askClaude(userId) : withBackup(key ? makeAskClaude(key) : undefined, openaiKey ? makeAskOpenAI(openaiKey, opts.fetchImpl) : undefined);
    return new Assistant(state, { providers, clock, askClaude });
  }

  /** Run engine work for a user; persists and notifies other devices on change. */
  async function withAssistant<T>(userId: string, fn: (a: Assistant, s: UserState) => Promise<T>): Promise<T> {
    let version = -1;
    const result = await store.withUser(userId, async (state) => {
      const before = state.version;
      const a = await assistantFor(userId, state);
      const r = await fn(a, state);
      if (state.version !== before) version = state.version;
      return r;
    });
    if (version >= 0) broadcast(userId, 'sync', { version });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  const routes: { method: string; pattern: RegExp; keys: string[]; auth: boolean; handler: Handler }[] = [];
  function route(method: string, path: string, auth: boolean, handler: Handler) {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_m, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, pattern, keys, auth, handler });
  }

  // ---- auth ----
  route('GET', '/api/auth/config', false, async () => ({ inviteRequired: !!opts.signupCode, push: !!opts.push }));

  route('POST', '/api/auth/register', false, async (c) => {
    limit(`reg:${c.ip}`, opts.registrationsPerMinute ?? 10, 60_000);
    if (opts.signupCode) {
      const given = String(c.body?.inviteCode ?? '').trim().toLowerCase();
      if (!given || !safeEqual(hashToken(given), hashToken(opts.signupCode.trim().toLowerCase()))) {
        throw new HttpError(403, 'That invite code isn’t right. Ask the person who set up Brain Dump for it.');
      }
    }
    const tz = typeof c.body?.timeZone === 'string' && isValidTimeZone(c.body.timeZone) ? c.body.timeZone : 'UTC';
    const userId = randomId('user');
    await store.create(userId, tz, clock());
    const token = newToken();
    const device = await addDevice(userId, deviceName(c.body?.deviceName), token);
    return { token, userId, deviceId: device.id };
  });

  /** Create (or replace) this person's backup code. Shown once; store it somewhere safe. */
  route('POST', '/api/auth/recovery', true, async (c) => {
    const raw = randomBytes(10).toString('hex').toUpperCase(); // 20 hex chars
    const code = raw.match(/.{1,5}/g)!.join('-');
    await store.mutateIndex((idx) => {
      idx.recovery = (idx.recovery ?? []).filter((r) => r.userId !== c.device!.userId);
      idx.recovery.push({ codeHash: hashToken(raw), userId: c.device!.userId, createdAt: clock().toISOString() });
    });
    return { code };
  });

  route('GET', '/api/auth/recovery', true, async (c) => {
    const r = store.recovery.find((x) => x.userId === c.device!.userId);
    return { exists: !!r, createdAt: r?.createdAt };
  });

  /** Sign in on a new phone with the backup code. */
  route('POST', '/api/auth/recover', false, async (c) => {
    limit(`recover:${c.ip}`, 8, 10 * 60_000);
    const raw = String(c.body?.code ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();
    const h = hashToken(raw);
    const r = raw.length === 20 ? store.recovery.find((x) => safeEqual(x.codeHash, h)) : undefined;
    if (!r) throw new HttpError(400, 'That backup code didn’t match. Check it and try again.');
    const token = newToken();
    const device = await addDevice(r.userId, deviceName(c.body?.deviceName), token);
    broadcast(r.userId, 'devices', {});
    return { token, userId: r.userId, deviceId: device.id };
  });

  route('POST', '/api/auth/pair/start', true, async (c) => {
    limit(`pairstart:${c.device!.userId}`, 10, 60_000);
    let code = pairingCode();
    while (pairing.has(code)) code = pairingCode();
    const expires = Date.now() + 10 * 60_000;
    pairing.set(code, { userId: c.device!.userId, expires, attempts: 0 });
    return { code, expiresAt: new Date(expires).toISOString() };
  });

  route('POST', '/api/auth/pair/complete', false, async (c) => {
    limit(`pair:${c.ip}`, 10, 10 * 60_000);
    const code = String(c.body?.code ?? '').replace(/\D/g, '');
    const entry = pairing.get(code);
    if (!entry || entry.expires < Date.now()) {
      throw new HttpError(400, 'That code has expired or is wrong.');
    }
    pairing.delete(code); // single use
    const token = newToken();
    const device = await addDevice(entry.userId, deviceName(c.body?.deviceName), token);
    broadcast(entry.userId, 'devices', {});
    return { token, userId: entry.userId, deviceId: device.id };
  });

  route('GET', '/api/devices', true, async (c) => ({
    devices: store.devices.filter((d) => d.userId === c.device!.userId).map((d) => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, current: d.id === c.device!.id })),
  }));

  route('DELETE', '/api/devices/:id', true, async (c) => {
    const d = store.devices.find((x) => x.id === c.params.id && x.userId === c.device!.userId);
    if (!d) throw new HttpError(404, 'No such device');
    await store.mutateIndex((idx) => {
      idx.devices = idx.devices.filter((x) => x.id !== d.id);
    });
    return { ok: true };
  });

  // ---- conversation ----
  route('POST', '/api/session/start', true, async (c) =>
    withAssistant(c.device!.userId, (a) => a.start({ sessionId: str(c.body?.sessionId), device: c.device!.name })),
  );

  route('POST', '/api/utterance', true, async (c) => {
    limit(`utt:${c.device!.userId}`, 120, 60_000);
    const text = str(c.body?.text);
    if (!text) throw new HttpError(400, 'text is required');
    return withAssistant(c.device!.userId, (a) =>
      a.handle({ text, sessionId: str(c.body?.sessionId), clientId: str(c.body?.clientId), capturedAt: validDate(c.body?.capturedAt), device: c.device!.name }),
    );
  });

  route('POST', '/api/session/end', true, async (c) =>
    withAssistant(c.device!.userId, (a) => a.end(String(c.body?.sessionId ?? ''))),
  );

  /** Offline captures replayed in order; idempotent by clientId. */
  route('POST', '/api/sync', true, async (c) => {
    const captures = Array.isArray(c.body?.captures) ? c.body.captures.slice(0, 100) : [];
    return withAssistant(c.device!.userId, async (a) => {
      const replies = [];
      for (const cap of captures) {
        const text = str(cap?.text);
        const clientId = str(cap?.clientId);
        if (!text || !clientId) continue;
        const r = await a.handle({ text, clientId, capturedAt: validDate(cap?.capturedAt), device: c.device!.name, now: clock() });
        // Offline captures are fire-and-forget: close their session so questions surface in "needs me".
        const s = a.state.sessions.find((x) => x.id === r.sessionId);
        if (s && !s.endedAt) a.closeSession(s, clock());
        replies.push({ clientId, reply: r });
      }
      return { replies };
    });
  });

  // ---- state & overview ----
  route('GET', '/api/state', true, async (c) => store.withUser(c.device!.userId, async (s) => clientState(s, clock())));

  route('GET', '/api/overview', true, async (c) =>
    store.withUser(c.device!.userId, async (s) => {
      const now = clock();
      const items = needsMe(s, now);
      const undated = s.reminders.filter((r) => r.status === 'open' && !r.dueAt && r.kind === 'task').length;
      const tz = s.profile.timeZone;
      return {
        version: s.version,
        assistantName: s.profile.assistantName,
        onboarding: s.profile.onboarding,
        needsMe: { text: needsMeText(items, undated), items },
        handledToday: handledSummary(s, now, 'today'),
        upcoming: s.events
          .filter((e) => e.status === 'confirmed' && Date.parse(e.end) > now.getTime() && Date.parse(e.start) < now.getTime() + 7 * 86400000)
          .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
          .slice(0, 12)
          .map((e) => ({ id: e.id, title: e.title, when: formatWhen(new Date(e.start), tz, now, e.allDay), start: e.start, meeting: e.meeting })),
        unread: s.notifications.filter((n) => !n.read && n.kind !== 'system').length,
      };
    }),
  );

  route('GET', '/api/history', true, async (c) =>
    store.withUser(c.device!.userId, async (s) => ({
      sessions: s.sessions.filter((x) => x.device !== 'automation').slice(-30).reverse().map((x) => ({ id: x.id, startedAt: x.startedAt, endedAt: x.endedAt, turns: x.turns })),
      ledger: s.ledger.slice(-300).reverse(),
    })),
  );

  route('POST', '/api/undo/:id', true, async (c) =>
    withAssistant(c.device!.userId, async (a) => {
      const r = await a.undoEntry(c.params.id);
      return r;
    }),
  );

  // ---- user control ----
  route('PATCH', '/api/profile', true, async (c) =>
    withAssistant(c.device!.userId, async (_a, s) => {
      const b = c.body ?? {};
      if (typeof b.assistantName === 'string' && b.assistantName.trim()) {
        s.profile.assistantName = b.assistantName.trim().slice(0, 40);
        s.profile.nameAliases = [];
        if (s.profile.onboarding === 'name') s.profile.onboarding = 'permissions';
      }
      if (typeof b.displayName === 'string') s.profile.displayName = b.displayName.trim().slice(0, 60) || undefined;
      if (typeof b.timeZone === 'string' && isValidTimeZone(b.timeZone)) s.profile.timeZone = b.timeZone;
      if (Array.isArray(b.nameAliases)) s.profile.nameAliases = b.nameAliases.filter((x: unknown) => typeof x === 'string').slice(0, 10);
      if (b.preferences && typeof b.preferences === 'object') {
        const p = s.profile.preferences;
        const q = b.preferences;
        if (q.clearMeans === 'archive' || q.clearMeans === 'delete') p.clearMeans = q.clearMeans;
        if (typeof q.voiceReplies === 'boolean') p.voiceReplies = q.voiceReplies;
        if (typeof q.voice === 'string' && (OPENAI_VOICES as readonly string[]).includes(q.voice)) p.voice = q.voice;
        if (q.proactivity === 'quiet' || q.proactivity === 'normal') p.proactivity = q.proactivity;
        if (Number.isFinite(q.defaultEventLeadMin)) p.defaultEventLeadMin = Math.max(0, Math.min(1440, Number(q.defaultEventLeadMin)));
        if (q.weeklyBriefing && typeof q.weeklyBriefing === 'object') {
          p.weeklyBriefing = {
            enabled: !!q.weeklyBriefing.enabled,
            weekday: clampInt(q.weeklyBriefing.weekday, 0, 6, p.weeklyBriefing.weekday),
            hour: clampInt(q.weeklyBriefing.hour, 0, 23, p.weeklyBriefing.hour),
          };
        }
        if (q.shoppingDigest === null) delete p.shoppingDigest;
      }
      if (b.onboarding === 'done') s.profile.onboarding = 'done';
      s.version += 1;
      return { profile: s.profile };
    }),
  );

  route('PUT', '/api/permissions/:scope', true, async (c) =>
    withAssistant(c.device!.userId, async (_a, s) => {
      const scope = c.params.scope as Scope;
      const level = c.body?.level as PermissionLevel;
      if (!ALL_SCOPES.includes(scope) || !['none', 'read', 'draft', 'act'].includes(level)) throw new HttpError(400, 'bad scope or level');
      grantPermission(s, scope, level, 'settings', clock());
      s.version += 1;
      return { permissions: s.permissions };
    }),
  );

  route('PATCH', '/api/trust/:actionType', true, async (c) =>
    withAssistant(c.device!.userId, async (_a, s) => {
      setTrust(s, decodeURIComponent(c.params.actionType), !!c.body?.trusted, clock());
      s.version += 1;
      return { trust: s.trust };
    }),
  );

  route('PATCH', '/api/memories/:id', true, async (c) =>
    withAssistant(c.device!.userId, async (_a, s) => {
      const m = s.memories.find((x) => x.id === c.params.id);
      if (!m) throw new HttpError(404, 'Not found');
      if (typeof c.body?.value === 'string') m.value = c.body.value.slice(0, 500);
      if (c.body?.confirmed === true) {
        m.confirmed = true;
        m.provenance = 'confirmed';
      }
      if (typeof c.body?.automationAllowed === 'boolean') m.automationAllowed = c.body.automationAllowed;
      s.version += 1;
      return { memory: m };
    }),
  );

  route('DELETE', '/api/memories/:id', true, async (c) =>
    withAssistant(c.device!.userId, async (_a, s) => {
      s.memories = s.memories.filter((x) => x.id !== c.params.id);
      s.version += 1;
      return { ok: true };
    }),
  );

  route('PATCH', '/api/routines/:id', true, async (c) =>
    withAssistant(c.device!.userId, async (_a, s) => {
      const r = s.routines.find((x) => x.id === c.params.id);
      if (!r) throw new HttpError(404, 'Not found');
      if (['confirmed', 'automated', 'paused'].includes(c.body?.status)) r.status = c.body.status;
      if (r.memoryId) {
        const m = s.memories.find((x) => x.id === r.memoryId);
        if (m) m.automationAllowed = r.status === 'automated';
      }
      s.version += 1;
      return { routine: r };
    }),
  );

  route('DELETE', '/api/routines/:id', true, async (c) =>
    withAssistant(c.device!.userId, async (_a, s) => {
      s.routines = s.routines.filter((x) => x.id !== c.params.id);
      s.version += 1;
      return { ok: true };
    }),
  );

  // ---- Quick add (no talking needed) ----
  route('POST', '/api/create/:kind', true, async (c) =>
    withAssistant(c.device!.userId, async (a, s) => {
      const b = c.body ?? {};
      const tz = s.profile.timeZone;
      const text = String(b.text ?? b.title ?? b.name ?? '').trim().slice(0, 500);
      if (!text) throw new HttpError(400, 'Please add some text.');
      const at = (): Date | undefined => {
        if (typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return undefined;
        const [y, m, d] = b.date.split('-').map(Number);
        const [hh, mm] = typeof b.time === 'string' && /^\d{2}:\d{2}$/.test(b.time) ? b.time.split(':').map(Number) : [9, 0];
        return zonedToUtc({ year: y, month: m, day: d, hour: hh, minute: mm }, tz);
      };
      const now = clock();
      let summary = '';
      let result;
      switch (c.params.kind) {
        case 'event': {
          const start = at();
          if (!start) throw new HttpError(400, 'Pick a date.');
          const allDay = !b.time;
          const dur = Math.max(5, Math.min(24 * 60, Number(b.durationMin) || 60)) * 60000;
          summary = `Added ${text} ${fmtWhen(start, tz, now, allDay)}`;
          result = await a.exec.execute({ type: 'calendar.create', event: { title: text, start: start.toISOString(), end: new Date(start.getTime() + (allDay ? 86400000 : dur)).toISOString(), timeZone: tz, allDay, attendees: [] }, summary }, { auto: false, risk: 'low' });
          break;
        }
        case 'reminder': {
          const due = at();
          summary = due ? `I'll remind you ${fmtWhen(due, tz, now)}.` : 'Added to your reminders.';
          result = await a.exec.execute({ type: 'reminder.create', text, dueAt: due?.toISOString(), kind: 'task' }, { auto: false, risk: 'low' });
          break;
        }
        case 'note':
          summary = 'Saved to your notes.';
          result = await a.exec.execute({ type: 'note.create', text, idea: false }, { auto: false, risk: 'low' });
          break;
        case 'shopping':
          summary = `Added ${text}.`;
          result = await a.exec.execute({ type: 'shopping.add', items: text.split(/\s*,\s*/).filter(Boolean).map((name) => ({ name: name.toLowerCase() })) }, { auto: false, risk: 'low' });
          break;
        default:
          throw new HttpError(400, 'Unknown kind');
      }
      if (!result.ok) throw new HttpError(500, result.error ?? 'That didn’t work.');
      s.version += 1;
      return { ok: true, message: summary, id: result.refs[0]?.id };
    }),
  );

  /** A signed, per-event link that iPhone opens as "Add to Calendar". */
  function eventSig(userId: string, eventId: string) {
    return createHmac('sha256', key).update(`ics:${userId}:${eventId}`).digest('base64url').slice(0, 32);
  }
  route('GET', '/api/events/:id/ics-link', true, async (c) => ({
    url: `${baseUrl(c)}/api/ics/${c.device!.userId}/${encodeURIComponent(c.params.id)}.ics?sig=${eventSig(c.device!.userId, c.params.id)}`,
  }));
  route('GET', '/api/ics/:userId/:file', false, async (c) => {
    const eventId = c.params.file.replace(/\.ics$/, '');
    if (!safeEqual(String(c.url.searchParams.get('sig') ?? ''), eventSig(c.params.userId, eventId))) throw new HttpError(404, 'Not found');
    const s = await store.read(c.params.userId).catch(() => undefined);
    if (!s?.events.some((e) => e.id === eventId)) throw new HttpError(404, 'Not found');
    c.res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="event.ics"`, 'Cache-Control': 'no-store' });
    c.res.end(toICS(s, clock(), eventId));
    return undefined;
  });

  route('POST', '/api/items/:kind/:id', true, async (c) =>
    withAssistant(c.device!.userId, async (a, s) => {
      // Tap-to-complete on lists; goes through the executor so it is ledgered and undoable.
      const { kind, id } = c.params;
      const action = String(c.body?.action ?? 'complete');
      const plan =
        kind === 'shopping'
          ? { type: action === 'remove' ? 'shopping.remove' : 'shopping.complete', ids: [id] }
          : kind === 'reminder'
            ? { type: action === 'remove' ? 'reminder.archive' : 'reminder.complete', id }
            : kind === 'waiting'
              ? { type: 'waiting.resolve', id }
              : undefined;
      if (plan) {
        const r = await a.exec.execute(plan as any, { auto: false, risk: 'low' });
        s.version += 1;
        return { ok: r.ok };
      }
      if (kind === 'note') {
        const n = s.notes.find((x) => x.id === id);
        if (!n) throw new HttpError(404, 'Not found');
        if (action === 'remove') s.notes = s.notes.filter((x) => x.id !== id);
        else if (action === 'edit' && typeof c.body?.text === 'string' && c.body.text.trim()) n.text = c.body.text.trim().slice(0, 2000);
        s.version += 1;
        return { ok: true };
      }
      if (kind === 'event') {
        const e = s.events.find((x) => x.id === id);
        if (!e) throw new HttpError(404, 'Not found');
        const r = await a.exec.execute({ type: 'calendar.cancel', id, summary: `Removed ${e.title}` }, { auto: false, risk: 'medium' });
        s.version += 1;
        return { ok: r.ok };
      }
      if (kind === 'draft') {
        const d = s.drafts.find((x) => x.id === id);
        if (!d) throw new HttpError(404, 'Not found');
        d.status = action === 'discard' ? 'discarded' : 'handed_off';
        d.updatedAt = clock().toISOString();
        if (d.status === 'handed_off' && d.reminderId) {
          const rem = s.reminders.find((x) => x.id === d.reminderId);
          if (rem && rem.status === 'open') {
            rem.status = 'done';
            rem.completedAt = clock().toISOString();
          }
        }
        const w = s.waiting.find((x) => x.status === 'waiting' && x.direction === 'me' && x.personId === d.to);
        if (w && d.status === 'handed_off') {
          w.status = 'resolved';
          w.resolvedAt = clock().toISOString();
        }
        s.version += 1;
        return { ok: true };
      }
      throw new HttpError(400, 'Unsupported item');
    }),
  );

  route('POST', '/api/notifications/:id/act', true, async (c) =>
    withAssistant(c.device!.userId, (a) => a.actOnNotification(c.params.id, String(c.body?.value ?? ''))),
  );

  route('POST', '/api/notifications/read', true, async (c) =>
    withAssistant(c.device!.userId, async (_a, s) => {
      const ids: string[] | undefined = Array.isArray(c.body?.ids) ? c.body.ids : undefined;
      for (const n of s.notifications) if (!ids || ids.includes(n.id)) n.read = true;
      s.version += 1;
      return { ok: true };
    }),
  );

  route('GET', '/api/export', true, async (c) =>
    store.withUser(c.device!.userId, async (s) => {
      const { processed: _p, ...rest } = s;
      return rest;
    }),
  );

  route('DELETE', '/api/account', true, async (c) => {
    if (c.body?.confirm !== 'delete everything') throw new HttpError(400, 'Send {"confirm":"delete everything"} to delete your account.');
    const userId = c.device!.userId;
    for (const res of sse.get(userId) ?? []) res.end();
    sse.delete(userId);
    await store.deleteUser(userId);
    return { ok: true };
  });

  // ---- calendar feed (read-only ICS for Apple/Google/Outlook subscription) ----
  route('POST', '/api/calendar/feed', true, async (c) => {
    const token = newToken(24);
    await store.mutateIndex((idx) => {
      idx.feeds = idx.feeds.filter((f) => f.userId !== c.device!.userId);
      idx.feeds.push({ tokenHash: hashToken(token), userId: c.device!.userId, createdAt: clock().toISOString() });
    });
    const url = `${baseUrl(c)}/api/calendar.ics?feed=${token}`;
    return { url, webcal: url.replace(/^https?:/, 'webcal:') };
  });

  route('GET', '/api/calendar.ics', false, async (c) => {
    const feed = c.url.searchParams.get('feed') ?? '';
    const f = store.feeds.find((x) => safeEqual(x.tokenHash, hashToken(feed)));
    if (!f) throw new HttpError(404, 'Not found');
    const s = await store.read(f.userId);
    c.res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' });
    c.res.end(toICS(s, clock()));
    return undefined;
  });

  // ---- live sync ----
  route('GET', '/api/stream', true, async (c) => {
    const userId = c.device!.userId;
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const s = await store.read(userId);
    c.res.write(`event: sync\ndata: ${JSON.stringify({ version: s.version })}\n\n`);
    const set = sse.get(userId) ?? new Set();
    set.add(c.res);
    sse.set(userId, set);
    const hb = setInterval(() => c.res.write(': ping\n\n'), 25_000);
    c.req.on('close', () => {
      clearInterval(hb);
      set.delete(c.res);
    });
    return undefined;
  });

  // ---- Claude connection (optional) ----
  route('GET', '/api/ai', true, async (c) => {
    const secrets = await store.readSecrets(c.device!.userId);
    return { connected: !!secrets.anthropic?.apiKey || !!opts.anthropicApiKey, source: secrets.anthropic?.apiKey ? 'settings' : opts.anthropicApiKey ? 'server' : null, hint: secrets.anthropic?.hint };
  });

  route('PUT', '/api/ai', true, async (c) => {
    limit(`aikey:${c.device!.userId}`, 10, 60_000);
    const key = String(c.body?.apiKey ?? '').trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw new HttpError(400, 'That doesn’t look like an Anthropic API key (it starts with sk-ant-).');
    const check = await verifyKey(key);
    if (!check.ok) throw new HttpError(400, check.error ?? 'That key didn’t work.');
    const secrets = await store.readSecrets(c.device!.userId);
    secrets.anthropic = { apiKey: key, hint: `…${key.slice(-4)}`, savedAt: clock().toISOString() };
    await store.writeSecrets(c.device!.userId, secrets);
    return { connected: true, hint: secrets.anthropic.hint };
  });

  route('DELETE', '/api/ai', true, async (c) => {
    const secrets = await store.readSecrets(c.device!.userId);
    delete secrets.anthropic;
    await store.writeSecrets(c.device!.userId, secrets);
    return { connected: !!opts.anthropicApiKey };
  });

  // ---- ChatGPT (optional): natural voice + backup brain ----
  function openaiKeyFrom(secrets: Record<string, any>): string | undefined {
    return typeof secrets.openai?.apiKey === 'string' ? secrets.openai.apiKey : opts.openaiApiKey;
  }

  route('GET', '/api/voice', true, async (c) => {
    const secrets = await store.readSecrets(c.device!.userId);
    const state = await store.withUser(c.device!.userId, async (s) => s);
    return {
      natural: !!openaiKeyFrom(secrets),
      source: secrets.openai?.apiKey ? 'settings' : opts.openaiApiKey ? 'server' : null,
      hint: secrets.openai?.hint ?? null,
      voice: state.profile.preferences.voice ?? 'sage',
      voices: OPENAI_VOICES,
    };
  });

  route('PUT', '/api/voice/key', true, async (c) => {
    limit(`oaikey:${c.device!.userId}`, 10, 60_000);
    const key = String(c.body?.apiKey ?? '').trim();
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) throw new HttpError(400, 'That doesn’t look like an OpenAI API key (it starts with sk-).');
    const check = await verifyOpenAIKey(key, opts.fetchImpl);
    if (!check.ok) throw new HttpError(400, check.error ?? 'That key didn’t work.');
    const secrets = await store.readSecrets(c.device!.userId);
    secrets.openai = { apiKey: key, hint: `…${key.slice(-4)}`, savedAt: clock().toISOString() };
    await store.writeSecrets(c.device!.userId, secrets);
    return { natural: true, hint: secrets.openai.hint };
  });

  route('DELETE', '/api/voice/key', true, async (c) => {
    const secrets = await store.readSecrets(c.device!.userId);
    delete secrets.openai;
    await store.writeSecrets(c.device!.userId, secrets);
    return { natural: !!opts.openaiApiKey };
  });

  /** Natural speech for a reply. The app falls back to the phone's own voice on any error. */
  route('POST', '/api/tts', true, async (c) => {
    limit(`tts:${c.device!.userId}`, 60, 60_000);
    const text = String(c.body?.text ?? '').trim();
    if (!text) throw new HttpError(400, 'Nothing to say.');
    const secrets = await store.readSecrets(c.device!.userId);
    const key = openaiKeyFrom(secrets);
    if (!key) throw new HttpError(404, 'Natural voice isn’t set up.');
    const state = await store.withUser(c.device!.userId, async (s) => s);
    let audio: Buffer;
    try {
      audio = await speak(key, text, String(c.body?.voice ?? state.profile.preferences.voice ?? 'sage'), opts.fetchImpl);
    } catch {
      throw new HttpError(502, 'The voice service didn’t answer.');
    }
    c.res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.length), 'Cache-Control': 'no-store' });
    c.res.end(audio);
    return undefined;
  });

  // ---- One-tap talking (Siri Shortcut / Action Button / widgets) ----
  /** Creates a dedicated key for a Shortcut. Shown once; revocable under Devices. */
  route('POST', '/api/auth/shortcut', true, async (c) => {
    const token = newToken();
    const device = await addDevice(c.device!.userId, 'Siri Shortcut', token);
    return {
      token,
      deviceId: device.id,
      url: `${baseUrl(c)}/api/quick`,
      /** The whole Shortcut in one link: the dictated words go on the end. */
      link: `${baseUrl(c)}/api/quick?format=text&key=${encodeURIComponent(token)}&text=`,
      /** For the full Shortcut: JSON back, including what to add to the iPhone's own apps. */
      appLink: `${baseUrl(c)}/api/quick?key=${encodeURIComponent(token)}`,
    };
  });

  /**
   * Plain-text in, plain-text out, for Shortcuts: dictated text → reply to speak.
   * Consecutive calls within the idle window continue the same conversation, so a
   * follow-up question ("What time?") can be answered by running the Shortcut again.
   */
  const quickSessions = new Map<string, string>();
  const quick: Handler = async (c) => {
    limit(`quick:${c.device!.id}`, 60, 60_000);
    const text = ((c.url.searchParams.get('text') ?? '').trim() || (typeof c.body === 'string' ? c.body : str(c.body?.text)) || '').trim();
    // "sync" (or nothing, from the app's "Add to iPhone" button): just hand over what's new.
    const syncOnly = !text || /^sync$/i.test(text) || c.url.searchParams.get('sync') === '1';
    if (syncOnly && c.url.searchParams.get('format') === 'text') throw new HttpError(400, 'Nothing was heard.');
    const userId = c.device!.userId;
    let r: Awaited<ReturnType<Assistant['handle']>> | undefined;
    if (!syncOnly) {
      r = await withAssistant(userId, (a) => a.handle({ text, sessionId: quickSessions.get(c.device!.id), device: c.device!.name }));
      if (r.sessionEnded) quickSessions.delete(c.device!.id);
      else quickSessions.set(c.device!.id, r.sessionId);
    }
    if (c.url.searchParams.get('format') === 'text') {
      c.res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      c.res.end(r!.text);
      return undefined;
    }
    // Everything new goes to the phone's own apps in the same run.
    const phone = await store.withUser(userId, async (state) => {
      const items = phoneOutbox(state, clock());
      if (items.length) {
        markSentToPhone(state, items.map((i) => i.id), clock());
        state.version++;
      } else if (state.phoneSync?.enabled) state.phoneSync.lastRunAt = clock().toISOString();
      return { items, version: state.version };
    });
    if (phone.items.length) broadcast(userId, 'sync', { version: phone.version });
    return {
      text: r?.text ?? (phone.items.length ? `Added ${describeOutbox(phone.items)} to your iPhone.` : ''),
      question: !!r?.question,
      /** "yes" when Brain Dump asked something: the Shortcut runs itself again to hear the answer. */
      listen: r?.question ? 'yes' : 'no',
      done: r ? r.settled || r.sessionEnded : true,
      phone: phone.items,
    };
  };
  route('POST', '/api/quick', true, quick);
  route('GET', '/api/quick', true, quick);

  // ---- iPhone apps (Clock, Reminders, Calendar, Notes) through the Shortcut ----
  route('GET', '/api/phone', true, async (c) => {
    return store.withUser(c.device!.userId, async (state) => {
    const items = phoneOutbox(state, clock());
    return {
      enabled: !!state.phoneSync?.enabled,
      pending: items.length,
      summary: describeOutbox(items),
      lastRunAt: state.phoneSync?.lastRunAt ?? null,
      shoppingList: state.phoneSync?.shoppingList ?? 'Shopping',
      shortcutName: 'Brain Dump',
      shortcutUrl: opts.shortcutUrl ?? null,
    };
    });
  });

  route('PUT', '/api/phone', true, async (c) => {
    return withAssistant(c.device!.userId, async (_a, state) => {
      const sync = enablePhoneSync(state, clock(), c.body?.enabled !== false);
      const list = (str(c.body?.shoppingList) ?? '').trim();
      if (list) sync.shoppingList = list.slice(0, 40);
      state.version++;
      return { enabled: sync.enabled, shoppingList: sync.shoppingList ?? 'Shopping' };
    });
  });

  // ---- Setup progress (the Home screen checklist) ----
  route('GET', '/api/setup', true, async (c) => {
    const userId = c.device!.userId;
    const secrets = await store.readSecrets(userId);
    return {
      backupCode: store.recovery.some((r) => r.userId === userId),
      shortcut: store.devices.some((d) => d.userId === userId && d.name === 'Siri Shortcut' && d.lastSeenAt !== d.createdAt),
      shortcutCreated: store.devices.some((d) => d.userId === userId && d.name === 'Siri Shortcut'),
      push: (secrets.push ?? []).some((p: PushSubscriptionRecord) => p.deviceId === c.device!.id),
      claude: !!secrets.anthropic?.apiKey || !!opts.anthropicApiKey,
    };
  });

  /** Check the Claude connection for real, with whichever key is in use. */
  route('POST', '/api/ai/test', true, async (c) => {
    limit(`aitest:${c.device!.userId}`, 5, 60_000);
    const secrets = await store.readSecrets(c.device!.userId);
    const key = secrets.anthropic?.apiKey ?? opts.anthropicApiKey;
    if (!key) return { ok: false, message: 'No key is set yet. Add one here, or set ANTHROPIC_API_KEY on Render.' };
    const r = await verifyKey(key);
    return r.ok
      ? { ok: true, message: `Claude is connected${secrets.anthropic?.apiKey ? '' : ' (using the key on Render)'}.` }
      : { ok: false, message: r.error ?? 'Claude didn’t answer.' };
  });

  // ---- Push notifications ----
  route('GET', '/api/push/key', true, async () => {
    if (!opts.push) throw new HttpError(404, 'Push notifications are not set up on this server.');
    return { publicKey: opts.push.publicKey };
  });

  route('POST', '/api/push/subscribe', true, async (c) => {
    if (!opts.push) throw new HttpError(404, 'Push notifications are not set up on this server.');
    const sub = c.body?.subscription;
    if (!isValidSubscription(sub)) throw new HttpError(400, 'That subscription isn’t valid.');
    const secrets = await store.readSecrets(c.device!.userId);
    const list: PushSubscriptionRecord[] = (secrets.push ?? []).filter((x: PushSubscriptionRecord) => x.endpoint !== sub.endpoint && x.deviceId !== c.device!.id);
    list.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, deviceId: c.device!.id, createdAt: clock().toISOString() });
    secrets.push = list.slice(-10);
    await store.writeSecrets(c.device!.userId, secrets);
    return { ok: true };
  });

  route('POST', '/api/push/unsubscribe', true, async (c) => {
    const secrets = await store.readSecrets(c.device!.userId);
    secrets.push = (secrets.push ?? []).filter((x: PushSubscriptionRecord) => x.deviceId !== c.device!.id && x.endpoint !== c.body?.endpoint);
    await store.writeSecrets(c.device!.userId, secrets);
    return { ok: true };
  });

  route('POST', '/api/push/test', true, async (c) => {
    const n = await pushTo(c.device!.userId, [{ title: 'Brain Dump', body: 'Notifications are working. I’ll only use them when something needs you.', tag: 'test' }]);
    return { sent: n };
  });

  route('GET', '/api/health', false, async () => ({ ok: true }));

  // Integrations (OAuth). Registered from integrations.ts.
  integrationRoutes({
    route: (method, path, auth, handler) => route(method, path, auth, handler as Handler),
    store,
    clock,
    config: opts.integrations ?? {},
    publicUrl: opts.publicUrl,
    fetchImpl: opts.fetchImpl,
    HttpError,
    bump: async (userId) => {
      await store.withUser(userId, async (s) => {
        s.version += 1;
      });
      const s = await store.read(userId);
      broadcast(userId, 'sync', { version: s.version });
    },
  });

  // ---------------------------------------------------------------------------

  async function addDevice(userId: string, name: string, token: string): Promise<DeviceRecord> {
    const now = clock().toISOString();
    const device: DeviceRecord = { id: randomId('dev'), userId, name, tokenHash: hashToken(token), createdAt: now, lastSeenAt: now };
    await store.mutateIndex((idx) => {
      idx.devices.push(device);
    });
    return device;
  }

  function authenticate(req: IncomingMessage, url: URL): DeviceRecord | undefined {
    const header = req.headers.authorization ?? '';
    let token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    // EventSource cannot set headers; the stream endpoint alone accepts ?token=.
    if (!token && url.pathname === '/api/stream') token = url.searchParams.get('token') ?? '';
    // Siri Shortcuts: a dedicated, revocable Shortcut key may ride in the link itself.
    if (!token && url.pathname === '/api/quick') token = url.searchParams.get('key') ?? '';
    if (!token) return undefined;
    const h = hashToken(token);
    const d = store.devices.find((x) => safeEqual(x.tokenHash, h));
    if (d) d.lastSeenAt = clock().toISOString();
    return d;
  }

  async function serveStatic(url: URL, res: ServerResponse): Promise<boolean> {
    if (!webDir) return false;
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || !extname(p)) p = '/index.html';
    const file = normalize(join(webDir, p));
    if (!file.startsWith(webDir)) return false;
    try {
      const st = await stat(file);
      if (!st.isFile()) return false;
      const body = await readFile(file);
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': p === '/sw.js' || p === '/index.html' ? 'no-cache' : 'public, max-age=300',
      });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const origin = req.headers.origin;
    if (origin && opts.corsOrigins?.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const ip = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && (await serveStatic(url, res))) return;
        throw new HttpError(404, 'Not found');
      }
      const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
      if (!r) throw new HttpError(404, 'Not found');
      const m = url.pathname.match(r.pattern)!;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const device = authenticate(req, url);
      if (r.auth && !device) throw new HttpError(401, 'Not signed in');
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') ? await readJson(req) : undefined;
      const result = await r.handler({ req, res, url, params, body, device, ip });
      if (res.headersSent) return;
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result ?? { ok: true }));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[brain-dump]', err);
      if (!res.headersSent) {
        res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong.' : (err as Error).message }));
      }
    }
  });

  async function pushTo(userId: string, payloads: PushPayloadLite[]): Promise<number> {
    if (!opts.push || !payloads.length) return 0;
    const secrets = await store.readSecrets(userId);
    const subs: PushSubscriptionRecord[] = secrets.push ?? [];
    if (!subs.length) return 0;
    let sent = 0;
    const dead = new Set<string>();
    for (const p of payloads) {
      for (const sub of subs) {
        const r = await opts.push.send(sub, { ...p, url: '/' });
        if (r === 'ok') sent++;
        if (r === 'gone') dead.add(sub.endpoint);
      }
    }
    if (dead.size) {
      secrets.push = subs.filter((x) => !dead.has(x.endpoint));
      await store.writeSecrets(userId, secrets);
    }
    return sent;
  }

  async function tickAll(now = clock()): Promise<number> {
    let n = 0;
    for (const userId of store.userIds()) {
      try {
        const out: AppNotification[] = [];
        await withAssistant(userId, async (a) => {
          const r = await tick(a, now);
          out.push(...r.notifications);
        });
        for (const note of out) broadcast(userId, 'notification', note);
        const assistantName = (await store.read(userId)).profile.assistantName ?? 'Brain Dump';
        await pushTo(userId, out.map((n) => ({ title: assistantName, body: n.text, tag: n.key.slice(0, 60) })));
        n += out.length;
      } catch (err) {
        console.error('[brain-dump] tick failed for', userId, err);
      }
    }
    for (const [code, p] of pairing) if (p.expires < Date.now()) pairing.delete(code);
    return n;
  }

  let timer: NodeJS.Timeout | undefined;
  if (opts.tickIntervalMs) timer = setInterval(() => void tickAll(), opts.tickIntervalMs);

  return {
    server,
    store,
    tickAll,
    async close() {
      if (timer) clearInterval(timer);
      for (const set of sse.values()) for (const res of set) res.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ---------------------------------------------------------------------------

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, 'Request too large');
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!/json/.test(req.headers['content-type'] ?? 'application/json')) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x.length ? x.slice(0, 4000) : undefined;
}

function validDate(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined;
  const t = Date.parse(x);
  // Captures can't come from the future, nor from more than 30 days ago.
  if (!Number.isFinite(t) || t > Date.now() + 5 * 60000 || t < Date.now() - 30 * 86400000) return undefined;
  return new Date(t).toISOString();
}

function deviceName(x: unknown): string {
  return typeof x === 'string' && x.trim() ? x.trim().slice(0, 60) : 'Device';
}

function clampInt(x: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(x);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

export { clientState } from '../core/view.js';
