import type { Permission, PermissionLevel, Scope, TrustRecord, UserState } from './types.js';

export const SCHEMA_VERSION = 1;

export const ALL_SCOPES: Scope[] = [
  'calendar', 'reminders', 'shopping', 'notes', 'memory', 'email', 'messaging', 'contacts', 'meetings', 'bookings', 'purchases', 'music', 'fitness',
];

export const SCOPE_LABELS: Record<Scope, string> = {
  calendar: 'your calendar',
  reminders: 'your reminders',
  shopping: 'your shopping list',
  notes: 'your notes',
  memory: 'things I remember about you',
  email: 'your email',
  messaging: 'your messages',
  contacts: 'your contacts',
  meetings: 'video meetings',
  bookings: 'bookings',
  purchases: 'purchases',
  music: 'music',
  fitness: 'fitness apps',
};

export function createUserState(userId: string, timeZone: string, now: Date): UserState {
  const iso = now.toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    version: 0,
    profile: {
      userId,
      nameAliases: [],
      timeZone,
      onboarding: 'name',
      createdAt: iso,
      preferences: {
        clearMeans: 'archive',
        voiceReplies: true,
        weeklyBriefing: { enabled: true, weekday: 0, hour: 18 },
        proactivity: 'normal',
        defaultEventLeadMin: 30,
        purchaseConfirmThreshold: 0,
      },
    },
    events: [],
    reminders: [],
    shopping: [],
    notes: [],
    drafts: [],
    waiting: [],
    contacts: [],
    memories: [],
    routines: [],
    observations: [],
    suggestions: [],
    permissions: ALL_SCOPES.map((scope) => ({ scope, level: 'none' as PermissionLevel })),
    trust: [],
    ledger: [],
    sessions: [],
    notifications: [],
    mailbox: [],
    processed: [],
    integrations: {},
  };
}

/** Bring older persisted documents up to the current shape. */
export function migrateState(s: UserState): UserState {
  const base = createUserState(s.profile?.userId ?? 'unknown', s.profile?.timeZone ?? 'UTC', new Date(s.profile?.createdAt ?? Date.now()));
  const merged = { ...base, ...s, profile: { ...base.profile, ...s.profile, preferences: { ...base.profile.preferences, ...(s.profile?.preferences ?? {}) } } };
  for (const scope of ALL_SCOPES) {
    if (!merged.permissions.find((p) => p.scope === scope)) merged.permissions.push({ scope, level: 'none' });
  }
  merged.schemaVersion = SCHEMA_VERSION;
  return merged;
}

const LEVEL_ORDER: PermissionLevel[] = ['none', 'read', 'draft', 'act'];

export function permissionLevel(state: UserState, scope: Scope): PermissionLevel {
  return state.permissions.find((p) => p.scope === scope)?.level ?? 'none';
}

export function hasPermission(state: UserState, scope: Scope, needed: PermissionLevel): boolean {
  return LEVEL_ORDER.indexOf(permissionLevel(state, scope)) >= LEVEL_ORDER.indexOf(needed);
}

export function grantPermission(state: UserState, scope: Scope, level: PermissionLevel, via: string, now: Date): Permission {
  let p = state.permissions.find((x) => x.scope === scope);
  if (!p) {
    p = { scope, level: 'none' };
    state.permissions.push(p);
  }
  p.level = level;
  p.grantedAt = level === 'none' ? undefined : now.toISOString();
  p.grantedVia = via;
  return p;
}

/** The permissions granted when the user says "yes" to "Want me to look after your calendar, reminders and shopping?" */
export function grantEverydayPermissions(state: UserState, via: string, now: Date): void {
  for (const scope of ['calendar', 'reminders', 'shopping', 'notes', 'memory', 'contacts'] as Scope[]) {
    if (!hasPermission(state, scope, 'act')) grantPermission(state, scope, 'act', via, now);
  }
  // Communication starts as draft-only: nothing leaves the device without the user's say-so until they choose otherwise.
  for (const scope of ['messaging', 'email', 'meetings'] as Scope[]) {
    if (!hasPermission(state, scope, 'draft')) grantPermission(state, scope, 'draft', via, now);
  }
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

/** Confirmations of the same medium-risk action type after which the assistant stops asking. */
export const EARNED_TRUST_THRESHOLD = 3;

export function trustRecord(state: UserState, actionType: string): TrustRecord | undefined {
  return state.trust.find((t) => t.actionType === actionType);
}

export function isTrusted(state: UserState, actionType: string): boolean {
  return !!trustRecord(state, actionType)?.trusted;
}

export function recordConfirmation(state: UserState, actionType: string, approved: boolean, now: Date): TrustRecord {
  let t = trustRecord(state, actionType);
  if (!t) {
    t = { actionType, confirmed: 0, rejected: 0, trusted: false, updatedAt: now.toISOString() };
    state.trust.push(t);
  }
  if (approved) t.confirmed += 1;
  else t.rejected += 1;
  // A rejection resets earned trust; the user is signalling they want to stay in the loop.
  if (!approved && t.trustedVia === 'earned') t.trusted = false;
  if (approved && !t.trusted && t.confirmed - t.rejected * 2 >= EARNED_TRUST_THRESHOLD) {
    t.trusted = true;
    t.trustedVia = 'earned';
  }
  t.updatedAt = now.toISOString();
  return t;
}

export function setTrust(state: UserState, actionType: string, trusted: boolean, now: Date): void {
  let t = trustRecord(state, actionType);
  if (!t) {
    t = { actionType, confirmed: 0, rejected: 0, trusted, updatedAt: now.toISOString() };
    state.trust.push(t);
  }
  t.trusted = trusted;
  t.trustedVia = trusted ? 'explicit' : undefined;
  t.updatedAt = now.toISOString();
}
