// Getting things into the iPhone's own apps (via the Brain Dump Shortcut) and natural voice.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, App } from '../src/server/app.js';
import { phoneOutbox, enablePhoneSync, markSentToPhone, localISO } from '../src/core/phone.js';
import { setup, at, NOW } from './helpers.js';

describe('phone outbox', () => {
  it('hands over new alarms, timers, reminders, events, notes and shopping once', async () => {
    const h = setup();
    enablePhoneSync(h.state, h.clock.now, true);
    h.advance(1);
    await h.say('Wake me at 6:30');
    await h.say('Set a timer for 10 minutes');
    await h.say('Remind me to call the dentist tomorrow at 9');
    await h.say('Dinner with Sarah on Friday at 7');
    await h.say('Make a note that the wifi password is sunflower22');
    await h.say('I need oat milk');
    const out = phoneOutbox(h.state, h.clock.now);
    const byType = Object.fromEntries(out.map((o) => [o.type, o]));
    expect(byType.alarm.time).toBe('06:30');
    expect(byType.timer.minutes).toBe('10');
    expect(byType.reminder.start).toBe('2026-09-28T09:00:00+01:00');
    expect(byType.event).toMatchObject({ title: 'Dinner with Sarah', start: '2026-10-02T19:00:00+01:00', end: '2026-10-02T20:00:00+01:00' });
    expect(byType.note.title).toMatch(/sunflower22/);
    expect(byType.shopping).toMatchObject({ title: 'oat milk', list: 'Shopping' });
    markSentToPhone(h.state, out.map((o) => o.id), h.clock.now);
    expect(phoneOutbox(h.state, h.clock.now)).toHaveLength(0);
  });
  it('nothing goes across until it is switched on, and old things are never flooded in', async () => {
    const h = setup();
    await h.say('Remind me to pay rent on Friday');
    expect(phoneOutbox(h.state, h.clock.now)).toHaveLength(0);
    h.advance(1);
    enablePhoneSync(h.state, h.clock.now, true);
    expect(phoneOutbox(h.state, h.clock.now)).toHaveLength(0);
    await h.say('Remind me to water the plants');
    expect(phoneOutbox(h.state, h.clock.now).map((o) => o.type)).toEqual(['todo']);
  });
  it('writes local times with the right offset across the clock change', () => {
    expect(localISO(at(10, 20, 9).toISOString(), 'Europe/London')).toBe('2026-10-20T09:00:00+01:00');
    expect(localISO(at(11, 2, 9).toISOString(), 'Europe/London')).toBe('2026-11-02T09:00:00+00:00');
  });
});

describe('Shortcut and voice endpoints', () => {
  let app: App;
  let base: string;
  let dir: string;
  const clock = { now: NOW };
  const spoken: string[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/audio/speech')) {
      spoken.push(JSON.parse(String(init?.body)).voice);
      return new Response(new Uint8Array([0xff, 0xfb, 1, 2]), { status: 200 });
    }
    if (u.endsWith('/models')) return new Response('{}', { status: String((init?.headers as Record<string, string>)?.Authorization).includes('bad') ? 401 : 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  const api = async (path: string, opts: { method?: string; token?: string; body?: unknown } = {}) => {
    const res = await fetch(base + path, {
      method: opts.method ?? (opts.body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: res.status, json: await res.json().catch(() => ({})), res };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bd-iphone-'));
    app = await createApp({ dataDir: join(dir, 'data'), clock: () => clock.now, registrationsPerMinute: 1000, fetchImpl: fakeFetch, shortcutUrl: 'https://www.icloud.com/shortcuts/abc' });
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('“Hey Siri, Brain Dump” → the Shortcut gets the reply and what to create natively', async () => {
    const t = (await api('/api/auth/register', { body: { deviceName: 'iPhone', timeZone: 'Europe/London' } })).json.token;
    const sc = (await api('/api/auth/shortcut', { token: t, body: {} })).json;
    expect(sc.appLink).toMatch(/\/api\/quick\?key=/);
    await api('/api/phone', { method: 'PUT', token: t, body: { enabled: true } });
    clock.now = new Date(NOW.getTime() + 60_000);
    const r = await fetch(sc.appLink, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Set an alarm for 7am tomorrow and remind me to take the bins out at 8' }) }).then((x) => x.json());
    expect(r.text).toBeTruthy();
    expect(r.listen).toBe('no');
    expect(r.phone.map((p: { type: string }) => p.type).sort()).toEqual(['alarm', 'reminder']);
    expect(r.phone.find((p: { type: string }) => p.type === 'alarm').time).toBe('07:00');
    // Handed over once only.
    const again = await fetch(sc.appLink, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'sync' }) }).then((x) => x.json());
    expect(again.phone).toEqual([]);
    // Added in the app → the app's "Add to iPhone" run picks it up.
    await api('/api/create/note', { token: t, body: { text: 'Door code 4821' } });
    const st = (await api('/api/phone', { token: t })).json;
    expect(st).toMatchObject({ enabled: true, pending: 1, summary: 'a note', shortcutUrl: 'https://www.icloud.com/shortcuts/abc' });
    const s2 = await fetch(sc.appLink, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'sync' }) }).then((x) => x.json());
    expect(s2.phone).toHaveLength(1);
    expect(s2.text).toBe('Added a note to your iPhone.');
  });

  it('a question makes the Shortcut listen again', async () => {
    const t = (await api('/api/auth/register', { body: { deviceName: 'iPhone', timeZone: 'Europe/London' } })).json.token;
    const sc = (await api('/api/auth/shortcut', { token: t, body: {} })).json;
    const r = await fetch(sc.appLink, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Add lunch with Tom to my calendar' }) }).then((x) => x.json());
    expect(r.text).toMatch(/When/);
    expect(r.listen).toBe('yes');
  });

  it('natural voice: key saved, voice chosen, speech returned as audio', async () => {
    const t = (await api('/api/auth/register', { body: { deviceName: 'iPhone', timeZone: 'Europe/London' } })).json.token;
    expect((await api('/api/voice', { token: t })).json.natural).toBe(false);
    expect((await api('/api/tts', { token: t, body: { text: 'Hello' } })).status).toBe(404);
    expect((await api('/api/voice/key', { method: 'PUT', token: t, body: { apiKey: 'sk-bad-aaaaaaaaaaaaaaaaaaaaaaaa' } })).status).toBe(400);
    expect((await api('/api/voice/key', { method: 'PUT', token: t, body: { apiKey: 'sk-good-aaaaaaaaaaaaaaaaaaaaaaaa' } })).json.natural).toBe(true);
    await api('/api/profile', { method: 'PATCH', token: t, body: { preferences: { voice: 'coral' } } });
    const v = (await api('/api/voice', { token: t })).json;
    expect(v).toMatchObject({ natural: true, voice: 'coral', source: 'settings' });
    const res = await fetch(base + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify({ text: 'Hello there' }) });
    expect(res.headers.get('content-type')).toBe('audio/mpeg');
    expect((await res.arrayBuffer()).byteLength).toBe(4);
    expect(spoken.at(-1)).toBe('coral');
  });
});
