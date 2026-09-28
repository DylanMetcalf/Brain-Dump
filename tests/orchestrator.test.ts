// Integration & Setup Orchestrator: discovery, setup, device agent, health and repair.
// Drives the real server as the Brain Dump iPhone app would.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, App } from '../src/server/app.js';
import { integrationStatus, type OrchestratorFacts } from '../src/core/orchestrator.js';
import { createUserState } from '../src/core/state.js';
import { NOW, at } from './helpers.js';

let app: App;
let base: string;
let dir: string;
const clock = { now: NOW };
const pushes: string[] = [];
let pushGone = false;

async function api(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

const iphoneApp = (perms: Record<string, string>) => ({
  shell: 'ios', platform: 'ios', osVersion: '26.0', appVersion: '1.0',
  permissions: perms,
  features: ['voice-input', 'app-intents', 'widgets', 'alarmkit', 'eventkit', 'contacts', 'share-sheet', 'speech-synthesis'],
});
const ALL = { calendar: 'granted', reminders: 'granted', contacts: 'granted', microphone: 'granted', speech: 'granted', notifications: 'granted', alarms: 'granted' };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-orch-'));
  app = await createApp({
    dataDir: join(dir, 'data'), clock: () => clock.now, registrationsPerMinute: 1000,
    push: { publicKey: 'BPUB', send: async (s, p) => { pushes.push(p.body); return pushGone ? 'gone' : 'ok'; } },
  });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await app.close();
  await rm(dir, { recursive: true, force: true });
});

async function newUser(name = 'iPhone') {
  return (await api('/api/auth/register', { body: { deviceName: name, timeZone: 'Europe/London' } })).json.token as string;
}

describe('discovery: only what this device supports', () => {
  const facts = (device: any): OrchestratorFacts => ({
    device: device && { deviceId: 'd', reportedAt: '', ...device },
    otherDevices: [],
    server: { googleConfigured: false, pushConfigured: true, claude: { configured: true }, naturalVoice: { configured: false } },
    account: { pushForDevice: false },
    state: createUserState('u', 'Europe/London', NOW),
    now: NOW,
  });
  it('the iPhone app offers Contacts, real alarms and built-in Siri; no Shortcut to build', () => {
    const s = integrationStatus(facts(iphoneApp({})));
    const ids = s.filter((x) => x.selectable).map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['calendar', 'reminders', 'contacts', 'alarms', 'siri', 'voice', 'notifications']));
    expect(s.find((x) => x.id === 'siri')!.via).toMatch(/no Shortcut to build/);
    expect(s.find((x) => x.id === 'calendar')!).toMatchObject({ health: 'needs-you', fix: { kind: 'permission', target: 'calendar' } });
  });
  it('a desktop browser never sees Contacts, Siri or unsupported things; Mail only when Google is set up', () => {
    const s = integrationStatus(facts({ shell: 'web', platform: 'macos', permissions: { microphone: 'prompt' }, features: ['voice-input', 'push'] }));
    const ids = s.map((x) => x.id);
    expect(ids).not.toContain('contacts');
    expect(ids).not.toContain('siri');
    expect(ids).not.toContain('mail');
  });
  it('iPhone Safari (not installed) is told exactly how to get notifications', () => {
    const s = integrationStatus(facts({ shell: 'web', platform: 'ios', standalone: false, permissions: {}, features: ['voice-input'] }));
    expect(s.find((x) => x.id === 'notifications')!).toMatchObject({ health: 'needs-you', fix: { kind: 'install', target: 'home-screen' } });
  });
  it('a denied permission points to Settings, never just "failed"', () => {
    const s = integrationStatus(facts(iphoneApp({ calendar: 'denied' })));
    const cal = s.find((x) => x.id === 'calendar')!;
    expect(cal.message).toBe('Calendar access is off. Turn it on in Settings and I’ll finish the setup.');
    expect(cal.fix).toMatchObject({ kind: 'settings' });
  });
});

describe('acceptance 1: install → connect → test → talk', () => {
  it('select, grant, set up, then “I need to remember to buy milk, and I can’t make yoga tomorrow”', async () => {
    const t = await newUser();
    // Opens the app: it discovers what this iPhone can do (nothing granted yet).
    let r = await api('/api/device/caps', { token: t, body: iphoneApp({ calendar: 'prompt', reminders: 'prompt', contacts: 'prompt' }) });
    expect(r.json.choices.map((c: any) => c.id)).toEqual(expect.arrayContaining(['calendar', 'reminders', 'contacts', 'siri']));
    // Chooses Calendar, Reminders, Contacts and Siri & Shortcuts.
    r = await api('/api/setup/start', { token: t, body: { selected: ['calendar', 'reminders', 'contacts', 'siri'] } });
    expect(r.json.problems.map((p: any) => p.id)).toEqual(expect.arrayContaining(['calendar', 'reminders', 'contacts']));
    // Grants what Apple asks for; the app reports the new permissions.
    r = await api('/api/device/caps', { token: t, body: iphoneApp(ALL) });
    expect(r.json.problems).toEqual([]);
    // The app shares her calendar: yoga tomorrow evening.
    const yogaStart = at(9, 28, 18).toISOString();
    await api('/api/device/calendar', { token: t, body: { from: NOW.toISOString(), to: at(10, 27, 0).toISOString(), events: [
      { nativeId: 'EK-YOGA', title: 'Yoga', start: yogaStart, end: at(9, 28, 19).toISOString() },
      { nativeId: 'EK-DENTIST', title: 'Dentist', start: at(9, 30, 9).toISOString(), end: at(9, 30, 10).toISOString() },
    ] } });
    await api('/api/setup/complete', { token: t, body: { tested: true } });

    // Taps Talk.
    const s = (await api('/api/session/start', { token: t, body: {} })).json;
    const reply = (await api('/api/utterance', { token: t, body: { sessionId: s.sessionId, text: 'I need to remember to buy milk, and I can’t make yoga tomorrow' } })).json;
    expect(reply.text).toMatch(/milk/i);
    expect(reply.text).toMatch(/yoga/i);
    expect(reply.text).toMatch(/cancel/i);
    expect(reply.question?.text ?? reply.text).toMatch(/reschedule|another time|move it/i);

    // The phone gets the plain operations: a reminder and the yoga cancellation on her real calendar.
    const out = (await api('/api/phone/outbox', { token: t })).json.items;
    // "Buy milk" lands in her Reminders shopping list (a reminder the Reminders app groups as groceries).
    const todo = out.find((i: any) => ['todo', 'reminder', 'shopping'].includes(i.type));
    expect(todo.title).toMatch(/milk/i);
    const cancel = out.find((i: any) => i.type === 'event_cancel');
    expect(cancel).toMatchObject({ nativeId: 'EK-YOGA', title: 'Yoga' });
    expect(out.find((i: any) => i.nativeId === 'EK-DENTIST')).toBeUndefined();

    // It does them, reads them back, and reports: verified.
    const res = await api('/api/phone/results', { token: t, body: { results: [
      { key: todo.key, ok: true, nativeId: 'EK-R-MILK' },
      { key: cancel.key, ok: true },
    ] } });
    expect(res.json).toEqual({ ok: 2, failed: 0 });
    expect((await api('/api/phone/outbox', { token: t })).json.items).toEqual([]);

    // Declines rescheduling: finished, no loop.
    const done = (await api('/api/utterance', { token: t, body: { sessionId: reply.sessionId, text: 'no' } })).json;
    expect(done.question).toBeFalsy();

    // Ticking off a reminder in Brain Dump completes it on the phone too.
    await api('/api/utterance', { token: t, body: { text: 'Remind me to call the vet' } });
    const [vet] = (await api('/api/phone/outbox', { token: t })).json.items;
    await api('/api/phone/results', { token: t, body: { results: [{ key: vet.key, ok: true, nativeId: 'EK-R-VET' }] } });
    const state = (await api('/api/state', { token: t })).json;
    const r2 = state.reminders.find((x: any) => /vet/i.test(x.text));
    await api(`/api/items/reminder/${r2.id}`, { token: t, body: { action: 'complete' } });
    const after = (await api('/api/phone/outbox', { token: t })).json.items;
    expect(after).toEqual([expect.objectContaining({ type: 'reminder_complete', nativeId: 'EK-R-VET' })]);
  });
});

describe('acceptance 2: a queue of integrations, interrupted only by real permission prompts', () => {
  it('Calendar, Reminders, Notes, Contacts, Mail and Siri: only the device permissions need her', async () => {
    const t = await newUser();
    await api('/api/device/caps', { token: t, body: iphoneApp({ calendar: 'prompt', reminders: 'prompt', contacts: 'prompt', microphone: 'granted', speech: 'granted' }) });
    const r = await api('/api/setup/start', { token: t, body: { selected: ['calendar', 'reminders', 'notes', 'contacts', 'mail', 'siri'] } });
    const needs = r.json.problems.map((p: any) => [p.id, p.fix?.kind]);
    expect(needs).toEqual(expect.arrayContaining([['calendar', 'permission'], ['reminders', 'permission'], ['contacts', 'permission']]));
    expect(needs.find(([id]: string[]) => id === 'notes' || id === 'siri')).toBeUndefined();
    // Mail isn't offered at all without Google on this server (not shown, not "failed").
    expect(r.json.choices.map((c: any) => c.id)).not.toContain('mail');
  });
});

describe('acceptance 3: failure → diagnose → repair → retest', () => {
  it('Calendar permission revoked: the failed change is retried and the fix is exact', async () => {
    const t = await newUser();
    await api('/api/device/caps', { token: t, body: iphoneApp(ALL) });
    await api('/api/setup/start', { token: t, body: { selected: ['calendar'] } });
    clock.now = new Date(NOW.getTime() + 60_000);
    const s = (await api('/api/session/start', { token: t, body: {} })).json;
    await api('/api/utterance', { token: t, body: { sessionId: s.sessionId, text: 'Dinner with Sarah on Friday at 7' } });
    const [ev] = (await api('/api/phone/outbox', { token: t })).json.items;
    expect(ev).toMatchObject({ type: 'event', title: 'Dinner with Sarah', start: '2026-10-02T19:00:00+01:00' });
    // She turned Calendar off in Settings; the phone reports the failure.
    await api('/api/phone/results', { token: t, body: { results: [{ key: ev.key, ok: false, error: 'Calendar access denied', needs: 'calendar' }] } });
    let h = (await api('/api/health/integrations', { token: t })).json;
    expect(h.problems[0]).toMatchObject({ id: 'calendar', health: 'needs-you', fix: { kind: 'settings' } });
    // Repair: the change is back in the queue.
    const rep = (await api('/api/health/repair', { token: t, body: {} })).json;
    expect(rep.repaired.join(' ')).toMatch(/1 change waiting for your phone will be retried/);
    // She turns it back on; the retry succeeds; health is clear again.
    await api('/api/device/caps', { token: t, body: iphoneApp(ALL) });
    const [again] = (await api('/api/phone/outbox', { token: t })).json.items;
    expect(again.key).toBe(ev.key);
    await api('/api/phone/results', { token: t, body: { results: [{ key: ev.key, ok: true, nativeId: 'EK-1' }] } });
    h = (await api('/api/health/integrations', { token: t })).json;
    expect(h.problems.find((p: any) => p.id === 'calendar')).toBeUndefined();
    clock.now = NOW;
  });
  it('a notification link the phone no longer accepts is detected and removed, and the fix is offered', async () => {
    const t = await newUser('Her iPhone');
    await api('/api/device/caps', { token: t, body: { shell: 'web', platform: 'ios', standalone: true, permissions: { notifications: 'granted', microphone: 'granted' }, features: ['voice-input', 'push'] } });
    await api('/api/push/subscribe', { token: t, body: { subscription: { endpoint: 'https://push.example/x1', keys: { p256dh: 'BK', auth: 'a' } } } });
    pushGone = true;
    const rep = (await api('/api/health/repair', { token: t, body: { push: true } })).json;
    pushGone = false;
    expect(rep.repaired.join(' ')).toMatch(/notification link/);
    expect(rep.problems.find((p: any) => p.id === 'notifications')).toMatchObject({ fix: { kind: 'retry', target: 'notifications' } });
  });
});

describe('acceptance 4: setup is never shown again unless something changes', () => {
  it('after setup, only genuinely new integrations are offered', async () => {
    const t = await newUser();
    await api('/api/device/caps', { token: t, body: { shell: 'web', platform: 'ios', standalone: true, permissions: { notifications: 'granted', microphone: 'granted' }, features: ['voice-input', 'push'] } });
    await api('/api/setup/start', { token: t, body: { selected: ['calendar', 'reminders'] } });
    let r = (await api('/api/setup/complete', { token: t, body: { tested: true } })).json;
    expect(r.setup.completedAt).toBeTruthy();
    expect(r.newlyAvailable).toEqual([]);
    // Later she installs the Brain Dump iPhone app: Contacts becomes possible.
    r = (await api('/api/device/caps', { token: t, body: iphoneApp(ALL) })).json;
    expect(r.newlyAvailable.map((x: any) => x.id)).toContain('contacts');
    await api('/api/setup/offered', { token: t, body: { ids: ['contacts'] } });
    r = (await api('/api/health/integrations', { token: t })).json;
    expect(r.newlyAvailable.map((x: any) => x.id)).not.toContain('contacts');
  });
});

describe('device calendar sharing', () => {
  it('keeps her phone calendar in step without duplicating what Brain Dump put there', async () => {
    const t = await newUser();
    await api('/api/device/caps', { token: t, body: iphoneApp(ALL) });
    clock.now = new Date(NOW.getTime() + 60_000);
    const s = (await api('/api/session/start', { token: t, body: {} })).json;
    await api('/api/utterance', { token: t, body: { sessionId: s.sessionId, text: 'Lunch with Tom on Tuesday at 1' } });
    const [ev] = (await api('/api/phone/outbox', { token: t })).json.items;
    await api('/api/phone/results', { token: t, body: { results: [{ key: ev.key, ok: true, nativeId: 'EK-LUNCH' }] } });
    const window = { from: NOW.toISOString(), to: at(10, 27, 0).toISOString() };
    await api('/api/device/calendar', { token: t, body: { ...window, events: [
      { nativeId: 'EK-LUNCH', title: 'Lunch with Tom', start: at(9, 29, 13).toISOString(), end: at(9, 29, 14).toISOString() },
      { nativeId: 'EK-PILATES', title: 'Pilates', start: at(9, 29, 18).toISOString(), end: at(9, 29, 19).toISOString() },
    ] } });
    let st = (await api('/api/state', { token: t })).json;
    expect(st.events.filter((e: any) => e.status === 'confirmed').map((e: any) => e.title).sort()).toEqual(['Lunch with Tom', 'Pilates']);
    // Moved on the phone → moved here, and not echoed back.
    await api('/api/device/calendar', { token: t, body: { ...window, events: [
      { nativeId: 'EK-LUNCH', title: 'Lunch with Tom', start: at(9, 29, 13).toISOString(), end: at(9, 29, 14).toISOString() },
      { nativeId: 'EK-PILATES', title: 'Pilates', start: at(9, 29, 19).toISOString(), end: at(9, 29, 20).toISOString() },
    ] } });
    expect((await api('/api/phone/outbox', { token: t })).json.items).toEqual([]);
    // Deleted on the phone → gone here.
    await api('/api/device/calendar', { token: t, body: { ...window, events: [
      { nativeId: 'EK-LUNCH', title: 'Lunch with Tom', start: at(9, 29, 13).toISOString(), end: at(9, 29, 14).toISOString() },
    ] } });
    st = (await api('/api/state', { token: t })).json;
    expect(st.events.filter((e: any) => e.status === 'confirmed').map((e: any) => e.title)).toEqual(['Lunch with Tom']);
    expect((await api('/api/phone/outbox', { token: t })).json.items).toEqual([]);
    clock.now = NOW;
  });
});
