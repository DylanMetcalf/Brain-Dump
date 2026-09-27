import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, App } from '../src/server/app.js';
import { NOW } from './helpers.js';

let app: App;
let base: string;
let dir: string;
const clock = { now: NOW };

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

async function onboard(token: string) {
  await api('/api/profile', { method: 'PATCH', token, body: { assistantName: 'Milo' } });
  const s = await api('/api/session/start', { token, body: {} });
  const r = await api('/api/utterance', { token, body: { text: 'Yes', sessionId: s.json.sessionId } });
  return r;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-'));
  const web = join(dir, 'web');
  await mkdir(web);
  await writeFile(join(web, 'index.html'), '<!doctype html><title>Brain Dump</title>');
  app = await createApp({ dataDir: join(dir, 'data'), webDir: web, clock: () => clock.now, publicUrl: 'http://test' });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

describe('server', () => {
  it('rejects unauthenticated API calls', async () => {
    expect((await api('/api/state')).status).toBe(401);
    expect((await api('/api/utterance', { body: { text: 'hi' }, token: 'nope' })).status).toBe(401);
  });

  it('registers a device (no password) and runs onboarding', async () => {
    const reg = await api('/api/auth/register', { body: { deviceName: 'Phone', timeZone: 'Europe/London' } });
    expect(reg.status).toBe(200);
    const t = reg.json.token;
    const start = await api('/api/session/start', { token: t, body: {} });
    expect(start.json.text).toMatch(/What would you like to call me\?/);
    const r1 = await api('/api/utterance', { token: t, body: { text: 'Milo', sessionId: start.json.sessionId } });
    expect(r1.json.text).toMatch(/^Milo it is\./);
    const r2 = await api('/api/utterance', { token: t, body: { text: 'yes', sessionId: start.json.sessionId } });
    expect(r2.json.text).toMatch(/What's on your mind/);
  });

  it('syncs across paired devices, with live SSE notification', async () => {
    const phone = (await api('/api/auth/register', { body: { deviceName: 'Phone', timeZone: 'Europe/London' } })).json.token;
    await onboard(phone);
    const pair = await api('/api/auth/pair/start', { token: phone, body: {} });
    expect(pair.json.code).toMatch(/^\d{6}$/);
    const laptop = await api('/api/auth/pair/complete', { body: { code: pair.json.code, deviceName: 'Laptop' } });
    expect(laptop.status).toBe(200);
    // Codes are single use.
    expect((await api('/api/auth/pair/complete', { body: { code: pair.json.code } })).status).toBe(400);

    // Laptop listens for changes.
    const ctrl = new AbortController();
    const stream = await fetch(`${base}/api/stream?token=${laptop.json.token}`, { signal: ctrl.signal });
    const reader = stream.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toMatch(/event: sync/);

    await api('/api/utterance', { token: phone, body: { text: 'I need to buy shampoo' } });
    const pushed = new TextDecoder().decode((await reader.read()).value);
    expect(pushed).toMatch(/event: sync/);
    ctrl.abort();

    const state = await api('/api/state', { token: laptop.json.token });
    expect(state.json.shopping.map((s: any) => s.name)).toContain('shampoo');
    expect(state.json.processed).toBeUndefined();
    const devices = await api('/api/devices', { token: phone });
    expect(devices.json.devices).toHaveLength(2);
  });

  it('replays offline captures idempotently, using capture time', async () => {
    const t = (await api('/api/auth/register', { body: { deviceName: 'Phone', timeZone: 'Europe/London' } })).json.token;
    await onboard(t);
    const captures = [
      { clientId: 'off-1', text: 'Remember to buy batteries', capturedAt: new Date(Date.now() - 3600_000).toISOString() },
      { clientId: 'off-2', text: 'Remind me to call mum tomorrow at 10', capturedAt: new Date(Date.now() - 3600_000).toISOString() },
    ];
    const a = await api('/api/sync', { token: t, body: { captures } });
    expect(a.json.replies).toHaveLength(2);
    await api('/api/sync', { token: t, body: { captures } }); // replay (e.g. flaky network)
    const s = await api('/api/state', { token: t });
    expect(s.json.shopping.filter((i: any) => i.name === 'batteries')).toHaveLength(1);
    expect(s.json.reminders.filter((r: any) => /call mum/i.test(r.text))).toHaveLength(1);
  });

  it('encrypts user data at rest', async () => {
    const t = (await api('/api/auth/register', { body: { deviceName: 'Phone' } })).json.token;
    await onboard(t);
    await api('/api/utterance', { token: t, body: { text: 'Add pineapple-marker-xyz' } });
    const raw = (await app.store.rawFiles()).join('\n');
    expect(raw).not.toMatch(/pineapple/);
    expect(raw).toMatch(/^BD1:/m);
  });

  it('gives the user control: permissions, memory, export, delete', async () => {
    const t = (await api('/api/auth/register', { body: { deviceName: 'Phone' } })).json.token;
    await onboard(t);
    await api('/api/utterance', { token: t, body: { text: 'My dentist is Dr Patel' } });
    const st = await api('/api/state', { token: t });
    const mem = st.json.memories.find((m: any) => m.subject === 'dentist');
    expect(mem).toMatchObject({ provenance: 'told', value: 'Dr Patel' });
    await api(`/api/memories/${mem.id}`, { method: 'DELETE', token: t });
    expect((await api('/api/state', { token: t })).json.memories.find((m: any) => m.subject === 'dentist')).toBeUndefined();
    const perm = await api('/api/permissions/calendar', { method: 'PUT', token: t, body: { level: 'none' } });
    expect(perm.json.permissions.find((p: any) => p.scope === 'calendar').level).toBe('none');
    expect((await api('/api/permissions/calendar', { method: 'PUT', token: t, body: { level: 'root' } })).status).toBe(400);
    const exp = await api('/api/export', { token: t });
    expect(exp.json.profile.assistantName).toBe('Milo');
    expect((await api('/api/account', { method: 'DELETE', token: t, body: {} })).status).toBe(400);
    expect((await api('/api/account', { method: 'DELETE', token: t, body: { confirm: 'delete everything' } })).status).toBe(200);
    expect((await api('/api/state', { token: t })).status).toBe(401);
  });

  it('serves the app with security headers and blocks path traversal', async () => {
    const r = await fetch(base + '/');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const bad = await fetch(base + '/..%2f..%2fpackage.json');
    expect(bad.status).toBe(404);
  });

  it('publishes a private ICS feed', async () => {
    const t = (await api('/api/auth/register', { body: { deviceName: 'Phone', timeZone: 'Europe/London' } })).json.token;
    await onboard(t);
    await api('/api/utterance', { token: t, body: { text: 'Dentist on Friday at 10' } });
    const feed = await api('/api/calendar/feed', { token: t, body: {} });
    const path = feed.json.url.replace('http://test', '');
    const ics = await fetch(base + path);
    const body = await ics.text();
    expect(body).toMatch(/BEGIN:VCALENDAR/);
    expect(body).toMatch(/SUMMARY:Dentist/);
    expect((await fetch(base + '/api/calendar.ics?feed=wrong')).status).toBe(404);
  });

  it('rate-limits pairing-code guessing', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await api('/api/auth/pair/complete', { body: { code: String(100000 + i) } })).status;
    expect(last).toBe(429);
  });

  it('delivers scheduler notifications', async () => {
    const t = (await api('/api/auth/register', { body: { deviceName: 'Phone', timeZone: 'Europe/London' } })).json.token;
    await onboard(t);
    await api('/api/utterance', { token: t, body: { text: 'Remind me to stretch in 10 minutes' } });
    clock.now = new Date(NOW.getTime() + 11 * 60000);
    await app.tickAll(clock.now);
    const s = await api('/api/state', { token: t });
    const n = s.json.notifications.find((x: any) => x.text === 'Stretch');
    expect(n).toBeTruthy();
    const act = await api(`/api/notifications/${n.id}/act`, { token: t, body: { value: 'done' } });
    expect(act.json.text).toBe('Done.');
    clock.now = NOW;
  });
});
