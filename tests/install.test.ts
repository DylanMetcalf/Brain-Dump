// The pieces that make a hosted install work for real people.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, App } from '../src/server/app.js';
import type { PushSubscriptionRecord, PushPayload } from '../src/server/push.js';
import { loadVapid } from '../src/server/push.js';
import { NOW } from './helpers.js';

let app: App;
let base: string;
let dir: string;
const clock = { now: NOW };
const pushed: { sub: PushSubscriptionRecord; payload: PushPayload }[] = [];
let gone = new Set<string>();

async function api(path: string, opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function newUser() {
  const r = await api('/api/auth/register', { body: { deviceName: 'Her iPhone', timeZone: 'Europe/London', inviteCode: 'Sage Garden' } });
  const t = r.json.token as string;
  await api('/api/profile', { method: 'PATCH', token: t, body: { assistantName: 'Milo' } });
  const s = await api('/api/session/start', { token: t, body: {} });
  await api('/api/utterance', { token: t, body: { text: 'yes', sessionId: s.json.sessionId } });
  return t;
}

const sub = (n: number) => ({ endpoint: `https://push.example.com/sub/${n}`, keys: { p256dh: 'BKey' + n, auth: 'auth' + n } });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-install-'));
  app = await createApp({
    dataDir: join(dir, 'data'),
    clock: () => clock.now,
    signupCode: 'sage garden',
    push: {
      publicKey: 'BPUBLIC',
      send: async (s, payload) => {
        if (gone.has(s.endpoint)) return 'gone';
        pushed.push({ sub: s, payload });
        return 'ok';
      },
    },
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('invite-only sign up', () => {
  it('tells the app an invite is needed and rejects wrong codes', async () => {
    expect((await api('/api/auth/config')).json).toEqual({ inviteRequired: true, push: true });
    expect((await api('/api/auth/register', { body: { inviteCode: 'nope' } })).status).toBe(403);
    expect((await api('/api/auth/register', { body: {} })).status).toBe(403);
  });
  it('accepts the invite code regardless of capitals and spacing at the ends', async () => {
    expect((await api('/api/auth/register', { body: { inviteCode: '  SAGE GARDEN ' } })).status).toBe(200);
  });
});

describe('backup code', () => {
  it('gets someone back into their own account on a new phone', async () => {
    const t = await newUser();
    await api('/api/utterance', { token: t, body: { text: 'Add lavender oil' } });
    const { code } = (await api('/api/auth/recovery', { token: t, body: {} })).json;
    expect(code).toMatch(/^[0-9A-F]{5}(-[0-9A-F]{5}){3}$/);
    expect((await api('/api/auth/recovery', { token: t })).json.exists).toBe(true);
    const back = await api('/api/auth/recover', { body: { code: code.toLowerCase().replace(/-/g, ' '), deviceName: 'New iPhone' } });
    expect(back.status).toBe(200);
    const state = await api('/api/state', { token: back.json.token });
    expect(state.json.shopping.map((i: any) => i.name)).toContain('lavender oil');
    expect((await api('/api/auth/recover', { body: { code: 'AAAAA-BBBBB-CCCCC-DDDDD' } })).status).toBe(400);
  });
  it('a new backup code replaces the old one', async () => {
    const t = await newUser();
    const first = (await api('/api/auth/recovery', { token: t, body: {} })).json.code;
    await api('/api/auth/recovery', { token: t, body: {} });
    expect((await api('/api/auth/recover', { body: { code: first } })).status).toBe(400);
  });
});

describe('push notifications', () => {
  it('delivers due reminders to the phone and drops dead subscriptions', async () => {
    const t = await newUser();
    expect((await api('/api/push/key', { token: t })).json.publicKey).toBe('BPUBLIC');
    expect((await api('/api/push/subscribe', { token: t, body: { subscription: { endpoint: 'http://insecure' } } })).status).toBe(400);
    await api('/api/push/subscribe', { token: t, body: { subscription: sub(1) } });
    const test = await api('/api/push/test', { token: t, body: {} });
    expect(test.json.sent).toBe(1);
    pushed.length = 0;
    await api('/api/utterance', { token: t, body: { text: 'Remind me to water the plants in 5 minutes' } });
    clock.now = new Date(NOW.getTime() + 6 * 60000);
    await app.tickAll(clock.now);
    expect(pushed.map((p) => `${p.payload.title}: ${p.payload.body}`)).toContain('Milo: Water the plants');
    // Phone uninstalled the app: the push service says the subscription is gone.
    gone = new Set([sub(1).endpoint]);
    await api('/api/utterance', { token: t, body: { text: 'Remind me to stretch in 1 minute' } });
    clock.now = new Date(clock.now.getTime() + 2 * 60000);
    await app.tickAll(clock.now);
    gone = new Set();
    pushed.length = 0;
    expect((await api('/api/push/test', { token: t, body: {} })).json.sent).toBe(0);
    clock.now = NOW;
  });
});

describe('address detection', () => {
  it('builds Shortcut links from the address people actually use', async () => {
    const t = await newUser();
    const r = await api('/api/auth/shortcut', { token: t, body: {}, headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'brain-dump.onrender.com' } });
    expect(r.json.url).toBe('https://brain-dump.onrender.com/api/quick');
  });
});

describe('push keys', () => {
  it('generates VAPID keys once and reuses them', async () => {
    const a = await loadVapid(join(dir, 'vapid'), {});
    const b = await loadVapid(join(dir, 'vapid'), {});
    expect(a.publicKey).toBe(b.publicKey);
    expect(a.publicKey.length).toBeGreaterThan(40);
  });
});

describe('one-link Siri Shortcut', () => {
  it('works with just the link plus the dictated words, and continues the conversation', async () => {
    const t = await newUser();
    const { link } = (await api('/api/auth/shortcut', { token: t, body: {} })).json;
    expect(link).toMatch(/\/api\/quick\?format=text&key=.+&text=$/);
    const path = link.replace(/^https?:\/\/[^/]+/, '');
    const say = async (words: string) => (await fetch(base + path + encodeURIComponent(words))).text();
    expect(await say('I need oat milk and remind me to call the vet tomorrow at 9')).toMatch(/Added oat milk.*remind you to call the vet tomorrow at 9 AM/);
    expect(await say('Organise a zoom with Rick')).toBe('What day?');
    expect(await say('Friday')).toBe('What time?');
    // A key in the link only works for this one endpoint.
    const key = new URL(link).searchParams.get('key');
    expect((await fetch(`${base}/api/state?key=${key}`)).status).toBe(401);
    expect((await fetch(`${base}/api/quick?format=text&key=wrong&text=hi`)).status).toBe(401);
  });

  it('reports setup progress for the Home screen checklist', async () => {
    const t = await newUser();
    expect((await api('/api/setup', { token: t })).json).toMatchObject({ backupCode: false, shortcutCreated: false, push: false, claude: false });
    await api('/api/auth/recovery', { token: t, body: {} });
    await api('/api/auth/shortcut', { token: t, body: {} });
    await api('/api/push/subscribe', { token: t, body: { subscription: sub(9) } });
    expect((await api('/api/setup', { token: t })).json).toMatchObject({ backupCode: true, shortcutCreated: true, push: true });
  });

  it('Test Claude explains when no key is set', async () => {
    const t = await newUser();
    const r = await api('/api/ai/test', { token: t, body: {} });
    expect(r.json).toMatchObject({ ok: false });
    expect(r.json.message).toMatch(/ANTHROPIC_API_KEY on Render/);
  });
});
