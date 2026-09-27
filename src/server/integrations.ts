// Connected services: OAuth 2.0 (authorisation code + PKCE), scoped per service,
// revocable, and tokens kept only in the encrypted secrets file.

import { createHash, randomBytes } from 'node:crypto';
import { LocalCalendar, Providers } from '../core/providers.js';
import { randomId } from '../core/text.js';
import type { UserState } from '../core/types.js';
import { CompositeCalendar, GmailProvider, GoogleAuth, GoogleCalendar, GoogleSecrets } from './google.js';
import type { Store } from './store.js';

export interface IntegrationConfig {
  google?: { clientId: string; clientSecret: string };
}

const GOOGLE_SCOPES: Record<string, string[]> = {
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  gmail: ['https://www.googleapis.com/auth/gmail.modify'],
  'gmail-send': ['https://www.googleapis.com/auth/gmail.send'],
};

export async function providersFor(
  state: UserState,
  secrets: Record<string, any>,
  cfg: IntegrationConfig,
  clock: () => Date,
  fetchImpl: typeof fetch = fetch,
  saveSecrets: (s: Record<string, any>) => Promise<void> = async () => undefined,
): Promise<Partial<Providers>> {
  const out: Partial<Providers> = {};
  const g = secrets.google as GoogleSecrets | undefined;
  if (cfg.google && g?.refresh_token && state.integrations.google) {
    const auth = new GoogleAuth(cfg.google, g, async (s) => saveSecrets({ ...secrets, google: s }), fetchImpl, clock);
    const scopes = state.integrations.google.scopes;
    if (scopes.includes('calendar')) {
      out.calendar = new CompositeCalendar(new GoogleCalendar(auth, () => state), new LocalCalendar(() => state, randomId, clock));
    }
    if (scopes.includes('gmail')) out.email = new GmailProvider(auth, scopes.includes('gmail-send'));
  }
  return out;
}

interface RouteDeps {
  route: (method: string, path: string, auth: boolean, handler: (c: any) => Promise<unknown>) => void;
  store: Store;
  clock: () => Date;
  config: IntegrationConfig;
  publicUrl?: string;
  fetchImpl?: typeof fetch;
  HttpError: new (status: number, message: string) => Error;
  bump: (userId: string) => Promise<void>;
}

export function integrationRoutes(d: RouteDeps) {
  const pending = new Map<string, { userId: string; verifier: string; services: string[]; expires: number }>();
  const fetchImpl = d.fetchImpl ?? fetch;
  const redirectUri = () => `${d.publicUrl ?? 'http://localhost:8787'}/api/integrations/google/callback`;

  d.route('GET', '/api/integrations', true, async (c) => {
    const s = await d.store.read(c.device.userId);
    return {
      available: {
        google: !!d.config.google,
        services: [
          { id: 'calendar', label: 'Google Calendar', provider: 'google', configured: !!d.config.google },
          { id: 'gmail', label: 'Gmail (read, archive, tidy)', provider: 'google', configured: !!d.config.google },
          { id: 'gmail-send', label: 'Gmail sending', provider: 'google', configured: !!d.config.google },
        ],
      },
      connected: Object.fromEntries(Object.entries(s.integrations).map(([k, v]) => [k, { connectedAt: v.connectedAt, scopes: v.scopes }])),
    };
  });

  d.route('POST', '/api/integrations/google/start', true, async (c) => {
    if (!d.config.google) throw new d.HttpError(400, 'Google integration is not configured on this server (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).');
    const requested: string[] = Array.isArray(c.body?.services) ? c.body.services.filter((x: string) => GOOGLE_SCOPES[x]) : ['calendar'];
    if (!requested.length) throw new d.HttpError(400, 'Choose at least one service.');
    const s = await d.store.read(c.device.userId);
    const services = [...new Set([...(s.integrations.google?.scopes ?? []), ...requested])];
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url');
    pending.set(state, { userId: c.device.userId, verifier, services, expires: Date.now() + 10 * 60_000 });
    const params = new URLSearchParams({
      client_id: d.config.google.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: services.flatMap((x) => GOOGLE_SCOPES[x]).join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
  });

  d.route('GET', '/api/integrations/google/callback', false, async (c) => {
    const stateParam = c.url.searchParams.get('state') ?? '';
    const code = c.url.searchParams.get('code') ?? '';
    const p = pending.get(stateParam);
    pending.delete(stateParam);
    const done = (ok: boolean, msg: string) => {
      c.res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      c.res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:2rem"><p>${msg}</p><p><a href="/#settings">Back to Brain Dump</a></p></body>`);
      return undefined;
    };
    if (!p || p.expires < Date.now() || !code || !d.config.google) return done(false, 'That connection link has expired. Please try again.');
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: d.config.google.clientId,
        client_secret: d.config.google.clientSecret,
        redirect_uri: redirectUri(),
        grant_type: 'authorization_code',
        code_verifier: p.verifier,
      }),
    });
    if (!res.ok) return done(false, 'Google did not accept the connection. Nothing was changed.');
    const tok = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
    const secrets = await d.store.readSecrets(p.userId);
    const prev = (secrets.google ?? {}) as GoogleSecrets;
    secrets.google = { ...prev, access_token: tok.access_token, refresh_token: tok.refresh_token ?? prev.refresh_token, expires_at: d.clock().getTime() + tok.expires_in * 1000, scope: tok.scope };
    await d.store.writeSecrets(p.userId, secrets);
    // Only record services whose scopes Google actually granted.
    const granted = p.services.filter((svc) => GOOGLE_SCOPES[svc].every((sc) => tok.scope.includes(sc)));
    await d.store.withUser(p.userId, async (s) => {
      s.integrations.google = { connectedAt: d.clock().toISOString(), scopes: granted };
      s.version += 1;
    });
    await d.bump(p.userId);
    return done(true, `Connected: ${granted.join(', ') || 'nothing'}. You can close this tab.`);
  });

  d.route('DELETE', '/api/integrations/:name', true, async (c) => {
    const name = c.params.name;
    const secrets = await d.store.readSecrets(c.device.userId);
    const tok = secrets[name]?.refresh_token ?? secrets[name]?.access_token;
    if (name === 'google' && tok) {
      await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tok)}`, { method: 'POST' }).catch(() => undefined);
    }
    delete secrets[name];
    await d.store.writeSecrets(c.device.userId, secrets);
    await d.store.withUser(c.device.userId, async (s) => {
      delete s.integrations[name];
      if (name === 'google') s.events = s.events.filter((e) => e.source !== 'google');
      s.version += 1;
    });
    await d.bump(c.device.userId);
    return { ok: true };
  });

  void randomId;
}
