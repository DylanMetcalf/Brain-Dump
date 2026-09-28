// Server side of the Integration & Setup Orchestrator: device capability reports, setup
// progress, live health checks with automatic repair, and the native app's device-agent
// endpoints (results and calendar sharing).

import { integrationStatus, newlyAvailable, problems, setupChoices, type IntegrationStatus, type OrchestratorFacts } from '../core/orchestrator.js';
import { applyDeviceCalendar, applyPhoneResults, describeOutbox, enablePhoneSync, markSentToPhone, phoneOutbox, type DeviceCalendarEvent, type PhoneResult } from '../core/phone.js';
import { randomId } from '../core/text.js';
import { grantEverydayPermissions, grantPermission, hasPermission } from '../core/state.js';
import type { PermissionLevel, Scope } from '../core/types.js';

/** What each chosen integration lets Brain Dump do, beyond the everyday set. */
const SCOPES_FOR: Record<string, [Scope, PermissionLevel][]> = {
  music: [['music', 'act']],
  meetings: [['meetings', 'draft']],
  mail: [['email', 'draft']],
  messages: [['messaging', 'draft']],
};
import type { DeviceCaps, PermissionState, UserState } from '../core/types.js';
import type { PushSubscriptionRecord } from './push.js';
import type { Store, DeviceRecord } from './store.js';

type Handler = (c: { device?: DeviceRecord; body?: any; url: URL; params: Record<string, string> }) => Promise<unknown>;

export interface SetupDeps {
  route: (method: string, path: string, auth: boolean, handler: Handler) => void;
  store: Store;
  clock: () => Date;
  HttpError: new (status: number, message: string) => Error;
  broadcast: (userId: string, event: string, data: unknown) => void;
  googleConfigured: boolean;
  pushConfigured: boolean;
  iosAppUrl?: string;
  /** Keys in use for this user (settings first, then server). */
  keys: (userId: string) => Promise<{ anthropic?: string; openai?: string }>;
  verifyClaude: (key: string) => Promise<{ ok: boolean; error?: string }>;
  verifyOpenAI: (key: string) => Promise<{ ok: boolean; error?: string }>;
  /** Live Google check (calendar list / gmail search) — refreshes the token as a side effect. */
  checkGoogle: (userId: string) => Promise<{ ok: boolean; error?: string } | undefined>;
  /** Send one notification to one device's subscriptions. */
  pushToDevice: (userId: string, deviceId: string, title: string, body: string) => Promise<'ok' | 'gone' | 'none' | 'error'>;
}

const PERMS = ['notifications', 'microphone', 'speech', 'calendar', 'reminders', 'contacts', 'alarms', 'location'] as const;
const PSTATES: PermissionState[] = ['granted', 'denied', 'prompt', 'unsupported', 'limited'];
const FEATURES = ['voice-input', 'push', 'app-intents', 'widgets', 'alarmkit', 'eventkit', 'contacts', 'share-sheet', 'speech-synthesis', 'control-widgets'];
const CHECK_TTL = 10 * 60_000;

function cleanCaps(deviceId: string, name: string, b: any, now: Date): DeviceCaps {
  const platforms = ['ios', 'ipados', 'macos', 'android', 'windows', 'linux', 'other'] as const;
  const permissions: DeviceCaps['permissions'] = {};
  for (const p of PERMS) if (PSTATES.includes(b?.permissions?.[p])) permissions[p] = b.permissions[p];
  return {
    deviceId,
    name,
    shell: b?.shell === 'ios' ? 'ios' : 'web',
    platform: platforms.includes(b?.platform) ? b.platform : 'other',
    osVersion: typeof b?.osVersion === 'string' ? b.osVersion.slice(0, 20) : undefined,
    appVersion: typeof b?.appVersion === 'string' ? b.appVersion.slice(0, 20) : undefined,
    standalone: !!b?.standalone,
    permissions,
    features: Array.isArray(b?.features) ? b.features.filter((f: unknown) => typeof f === 'string' && FEATURES.includes(f)) : [],
    reportedAt: now.toISOString(),
  };
}

export function setupRoutes(d: SetupDeps) {
  const { route, store, clock, HttpError } = d;
  const checks = new Map<string, { at: number; claude?: { ok: boolean; error?: string }; voice?: { ok: boolean; error?: string }; google?: { ok: boolean; error?: string }; push?: Record<string, 'ok' | 'gone' | 'error'> }>();

  async function facts(userId: string, device: DeviceRecord, state: UserState): Promise<OrchestratorFacts> {
    const secrets = await store.readSecrets(userId);
    const keys = await d.keys(userId);
    const c = checks.get(userId);
    const caps = state.deviceCaps ?? {};
    const g = state.integrations.google;
    return {
      device: caps[device.id],
      otherDevices: Object.values(caps).filter((x) => x.deviceId !== device.id),
      server: {
        googleConfigured: d.googleConfigured,
        iosAppUrl: d.iosAppUrl,
        pushConfigured: d.pushConfigured,
        claude: { configured: !!keys.anthropic, ok: c?.claude?.ok, error: c?.claude?.error },
        naturalVoice: { configured: !!keys.openai, ok: c?.voice?.ok, error: c?.voice?.error },
      },
      account: {
        google: g ? { scopes: g.scopes, ok: c?.google?.ok, error: c?.google?.error } : undefined,
        pushForDevice: (secrets.push ?? []).some((p: PushSubscriptionRecord) => p.deviceId === device.id),
        lastPushResult: c?.push?.[device.id] === 'error' ? 'error' : c?.push?.[device.id],
      },
      state,
      now: clock(),
    };
  }

  /** Live checks, with repair built in (a Google check refreshes its token; a gone push subscription is pruned). */
  async function runChecks(userId: string, device: DeviceRecord, opts: { force?: boolean; push?: boolean } = {}): Promise<string[]> {
    const prev = checks.get(userId);
    if (!opts.force && prev && clock().getTime() - prev.at < CHECK_TTL && !opts.push) return [];
    const repaired: string[] = [];
    const keys = await d.keys(userId);
    const next = { ...(prev ?? {}), at: clock().getTime() } as NonNullable<ReturnType<typeof checks.get>>;
    const [claude, voice, google] = await Promise.all([
      keys.anthropic ? d.verifyClaude(keys.anthropic).catch(() => ({ ok: false, error: 'Could not check.' })) : undefined,
      keys.openai ? d.verifyOpenAI(keys.openai).catch(() => ({ ok: false, error: 'Could not check.' })) : undefined,
      d.checkGoogle(userId).catch((e) => ({ ok: false, error: String(e?.message ?? e) })),
    ]);
    next.claude = claude;
    next.voice = voice;
    if (prev?.google?.ok === false && google?.ok) repaired.push('Google reconnected');
    next.google = google;
    if (opts.push) {
      const r = await d.pushToDevice(userId, device.id, 'Brain Dump', 'Notifications are working ✓');
      next.push = { ...(prev?.push ?? {}), ...(r === 'none' ? {} : { [device.id]: r }) };
      if (r === 'gone') repaired.push('Removed a notification link this phone no longer accepts');
    }
    checks.set(userId, next);
    return repaired;
  }

  async function report(userId: string, device: DeviceRecord) {
    const state = await store.withUser(userId, async (s) => s);
    const statuses = integrationStatus(await facts(userId, device, state));
    const selected = state.setup?.selected;
    return {
      statuses,
      problems: problems(statuses, selected),
      choices: setupChoices(statuses),
      setup: state.setup ?? null,
      newlyAvailable: newlyAvailable(statuses, state).map((s) => ({ id: s.id, label: s.label, via: s.via })),
      device: state.deviceCaps?.[device.id] ?? null,
      devices: Object.values(state.deviceCaps ?? {}),
    };
  }

  // ---- Device capabilities (each device reports its own permissions) ----
  route('POST', '/api/device/caps', true, async (c) => {
    const dev = c.device!;
    await store.withUser(dev.userId, async (s) => {
      const caps = cleanCaps(dev.id, dev.name, c.body, clock());
      const before = JSON.stringify({ ...(s.deviceCaps?.[dev.id] ?? {}), reportedAt: '' });
      s.deviceCaps = { ...(s.deviceCaps ?? {}), [dev.id]: caps };
      // The native app keeps the phone's apps in step from the moment it can.
      if (caps.shell === 'ios' && !s.phoneSync?.enabled) enablePhoneSync(s, clock(), true);
      if (before !== JSON.stringify({ ...caps, reportedAt: '' })) s.version++;
    });
    return report(dev.userId, dev);
  });

  // ---- Health (cached live checks; ?check=1 re-runs them now) ----
  route('GET', '/api/health/integrations', true, async (c) => {
    await runChecks(c.device!.userId, c.device!, { force: c.url.searchParams.get('check') === '1' });
    return report(c.device!.userId, c.device!);
  });

  /** Detect → diagnose → repair → retest. Returns what was fixed and what still needs the person. */
  route('POST', '/api/health/repair', true, async (c) => {
    const repaired = await runChecks(c.device!.userId, c.device!, { force: true, push: !!c.body?.push });
    // Phone operations that failed are already back in the queue; say so if any.
    const state = await store.withUser(c.device!.userId, async (s) => s);
    const pending = phoneOutbox(state, clock(), { native: state.deviceCaps?.[c.device!.id]?.shell === 'ios' }).length;
    if (pending) repaired.push(`${pending} change${pending > 1 ? 's' : ''} waiting for your phone will be retried`);
    return { repaired, ...(await report(c.device!.userId, c.device!)) };
  });

  // ---- Guided setup ----
  route('POST', '/api/setup/start', true, async (c) => {
    const selected = Array.isArray(c.body?.selected) ? c.body.selected.filter((x: unknown) => typeof x === 'string').slice(0, 30) : [];
    await store.withUser(c.device!.userId, async (s) => {
      s.setup = { ...(s.setup ?? {}), selected, startedAt: clock().toISOString(), completedAt: undefined };
      // Choosing an integration is the permission: Brain Dump then handles everyday changes there
      // without asking each time (permission ≠ confirmation). Messages and mail stay draft-only.
      const now = clock();
      grantEverydayPermissions(s, 'setup', now);
      for (const id of selected as string[]) for (const [scope, level] of SCOPES_FOR[id] ?? []) {
        if (!hasPermission(s, scope, level)) grantPermission(s, scope, level, 'setup', now);
      }
      s.version++;
    });
    return report(c.device!.userId, c.device!);
  });

  route('POST', '/api/setup/complete', true, async (c) => {
    const r0 = await report(c.device!.userId, c.device!);
    await store.withUser(c.device!.userId, async (s) => {
      const now = clock().toISOString();
      s.setup = {
        ...(s.setup ?? { selected: [], startedAt: now }),
        completedAt: now,
        ...(c.body?.tested ? { testedAt: now } : {}),
        // Everything shown during setup counts as offered: only genuinely new things are mentioned later.
        offered: [...new Set([...(s.setup?.offered ?? []), ...r0.choices.map((x) => x.id)])],
      };
      if (s.profile.onboarding !== 'done') s.profile.onboarding = 'done';
      s.version++;
    });
    return report(c.device!.userId, c.device!);
  });

  route('POST', '/api/setup/offered', true, async (c) => {
    const ids = Array.isArray(c.body?.ids) ? c.body.ids.filter((x: unknown) => typeof x === 'string') : [];
    await store.withUser(c.device!.userId, async (s) => {
      if (!s.setup) return;
      s.setup.offered = [...new Set([...(s.setup.offered ?? []), ...ids])];
      if (Array.isArray(c.body?.add)) s.setup.selected = [...new Set([...s.setup.selected, ...c.body.add.filter((x: unknown) => typeof x === 'string')])];
      s.version++;
    });
    return { ok: true };
  });

  // ---- Device agent (the Brain Dump iPhone app) ----
  /** What the phone should do now. Handing over marks them sent; results confirm or requeue. */
  route('GET', '/api/phone/outbox', true, async (c) => {
    const userId = c.device!.userId;
    const r = await store.withUser(userId, async (s) => {
      const items = phoneOutbox(s, clock(), { native: s.deviceCaps?.[c.device!.id]?.shell === 'ios' });
      if (items.length) {
        markSentToPhone(s, items.map((i) => i.key), clock());
        s.version++;
      }
      return { items, version: s.version };
    });
    if (r.items.length) d.broadcast(userId, 'sync', { version: r.version });
    return { items: r.items, summary: describeOutbox(r.items) };
  });

  route('POST', '/api/phone/results', true, async (c) => {
    const results: PhoneResult[] = Array.isArray(c.body?.results) ? c.body.results.slice(0, 200) : [];
    return store.withUser(c.device!.userId, async (s) => {
      const r = applyPhoneResults(s, results, clock());
      s.version++;
      return r;
    });
  });

  route('POST', '/api/device/calendar', true, async (c) => {
    const events: DeviceCalendarEvent[] = Array.isArray(c.body?.events) ? c.body.events.slice(0, 2000) : [];
    const from = String(c.body?.from ?? '');
    const to = String(c.body?.to ?? '');
    if (!Date.parse(from) || !Date.parse(to)) throw new HttpError(400, 'from and to are required.');
    const clean = events.filter((e) => e && typeof e.nativeId === 'string' && Date.parse(e.start) && Date.parse(e.end)).map((e) => ({
      nativeId: e.nativeId.slice(0, 200), title: String(e.title ?? '').slice(0, 200), start: new Date(e.start).toISOString(), end: new Date(e.end).toISOString(),
      allDay: !!e.allDay, location: e.location ? String(e.location).slice(0, 200) : undefined, calendar: e.calendar ? String(e.calendar).slice(0, 80) : undefined,
    }));
    const userId = c.device!.userId;
    const r = await store.withUser(userId, async (s) => {
      const out = applyDeviceCalendar(s, clean, { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, clock(), randomId);
      if (out.added || out.updated || out.removed) s.version++;
      return { ...out, version: s.version };
    });
    if (r.added || r.updated || r.removed) d.broadcast(userId, 'sync', { version: r.version });
    return r;
  });
}

export type { IntegrationStatus };
