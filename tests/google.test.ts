import { describe, it, expect } from 'vitest';
import { providersFor } from '../src/server/integrations.js';
import { Assistant } from '../src/core/assistant.js';
import { createUserState, grantEverydayPermissions } from '../src/core/state.js';
import { NOW, TZ, at } from './helpers.js';

/** Minimal fake of the Google Calendar API. */
function fakeGoogle() {
  const events = new Map<string, any>();
  let n = 0;
  const calls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url.split('?')[0]}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'fresh', expires_in: 3600 });
    const m = url.match(/calendars\/primary\/events(?:\/([^?]+))?/);
    if (m) {
      const id = m[1] && decodeURIComponent(m[1]);
      if (method === 'GET' && !id) return json({ items: [...events.values()].filter((e) => e.status !== 'cancelled') });
      if (method === 'GET') return events.has(id!) ? json(events.get(id!)) : json({}, 404);
      if (method === 'POST') {
        const e = { ...JSON.parse(String(init.body)), id: `ge${++n}`, status: 'confirmed' };
        events.set(e.id, e);
        return json(e);
      }
      if (method === 'PATCH') {
        const e = { ...events.get(id!), ...JSON.parse(String(init.body)) };
        events.set(id!, e);
        return json(e);
      }
      if (method === 'DELETE') {
        events.get(id!).status = 'cancelled';
        return new Response(null, { status: 204 });
      }
    }
    return json({ error: 'unexpected ' + url }, 500);
  }) as typeof fetch;
  return { events, fetchImpl, calls };
}

describe('Google Calendar provider', () => {
  it('cancels a Google event through the engine and verifies it', async () => {
    const g = fakeGoogle();
    g.events.set('yoga1', { id: 'yoga1', status: 'confirmed', summary: 'Yoga', start: { dateTime: at(9, 29, 14).toISOString() }, end: { dateTime: at(9, 29, 15).toISOString() } });
    const state = createUserState('u', TZ, NOW);
    state.profile.onboarding = 'done';
    grantEverydayPermissions(state, 'test', NOW);
    state.integrations.google = { connectedAt: NOW.toISOString(), scopes: ['calendar'] };
    const secrets = { google: { refresh_token: 'r', access_token: 'old', expires_at: 0 } };
    const providers = await providersFor(state, secrets, { google: { clientId: 'id', clientSecret: 's' } }, () => NOW, g.fetchImpl);
    const a = new Assistant(state, { providers, clock: () => NOW });
    const r = await a.handle({ text: "I can't make yoga" });
    expect(r.text).toMatch(/cancelled yoga Tuesday at 2 PM/);
    expect(g.events.get('yoga1').status).toBe('cancelled');
    expect(g.calls).toContain('POST https://oauth2.googleapis.com/token'); // refreshed the expired token
    const u = await a.handle({ text: 'undo', sessionId: r.sessionId });
    expect(u.text).toMatch(/yoga is Tuesday at 2 PM again/);
    expect(g.events.get('yoga1').status).toBe('confirmed');
    // New events go to Google.
    await a.handle({ text: 'Dentist on Friday at 10', sessionId: r.sessionId });
    expect([...g.events.values()].some((e) => e.summary === 'Dentist' && e.start.dateTime === at(10, 2, 10).toISOString())).toBe(true);
  });
});
