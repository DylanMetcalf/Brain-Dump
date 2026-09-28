import type { UserState } from './types.js';

/** What devices receive: everything the user may see, minus secrets and replay caches. */
export function clientState(s: UserState, now: Date) {
  const recent = now.getTime() - 30 * 86400000;
  return {
    version: s.version,
    profile: s.profile,
    events: s.events.filter((e) => Date.parse(e.end) > recent).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
    reminders: s.reminders.filter((r) => r.status === 'open' || Date.parse(r.updatedAt) > recent),
    shopping: s.shopping.filter((i) => i.status === 'needed' || Date.parse(i.updatedAt) > now.getTime() - 7 * 86400000),
    notes: s.notes.slice(-200),
    drafts: s.drafts.filter((d) => d.status === 'draft' || Date.parse(d.updatedAt) > recent),
    waiting: s.waiting.filter((w) => w.status === 'waiting' || Date.parse(w.resolvedAt ?? w.since) > recent),
    contacts: s.contacts,
    memories: s.memories,
    routines: s.routines,
    suggestions: s.suggestions.filter((x) => x.status === 'pending' || x.status === 'offered'),
    permissions: s.permissions,
    trust: s.trust,
    ledger: s.ledger.slice(-200),
    notifications: s.notifications.filter((n) => n.kind !== 'system').slice(-50),
    integrations: Object.fromEntries(Object.entries(s.integrations).map(([k, v]) => [k, { connectedAt: v.connectedAt, scopes: v.scopes, account: v.account }])),
    setup: s.setup ?? null,
  };
}
