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

export interface AppOptions {
  dataDir: string;
  key?: string;
  webDir?: string;
  clock?: () => Date;
  publicUrl?: string;
  integrations?: IntegrationConfig;
  /** Extra/override providers (tests, self-hosted adapters). */
  providers?: (userId: string) => Partial<Providers>;
  tickIntervalMs?: number;
  corsOrigins?: string[];
  fetchImpl?: typeof fetch;
}

export interface App {
  server: Server;
  store: Store;
  tickAll(now?: Date): Promise<number>;
  close(): Promise<void>;
}

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
    return new Assistant(state, { providers, clock });
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
  route('POST', '/api/auth/register', false, async (c) => {
    limit(`reg:${c.ip}`, 10, 60_000);
    const tz = typeof c.body?.timeZone === 'string' && isValidTimeZone(c.body.timeZone) ? c.body.timeZone : 'UTC';
    const userId = randomId('user');
    await store.create(userId, tz, clock());
    const token = newToken();
    const device = await addDevice(userId, deviceName(c.body?.deviceName), token);
    return { token, userId, deviceId: device.id };
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
    return { url: `${opts.publicUrl ?? ''}/api/calendar.ics?feed=${token}` };
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
