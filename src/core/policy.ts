// Central action decision matrix (spec §32). Authorisation and confirmation are separate:
// a permission says the assistant MAY act in a scope; confirmation is only asked when
// risk, reversibility or consequence justify interrupting the user.

import { hasPermission, isTrusted, permissionLevel } from './state.js';
import type { PermissionLevel, RiskLevel, Scope, UserState } from './types.js';

export interface ActionMeta {
  actionType: string;
  scope: Scope;
  /** Permission level required to perform the action. */
  needs: PermissionLevel;
  reversible: boolean;
  /** Affects someone other than the user (sends, invites, cancels shared events). */
  external: boolean;
  financial?: { amount: number; currency: string };
  /** Permanent destruction of data. */
  destructive?: boolean;
  /** Sensitive communication (resignation, money, health, legal …). */
  sensitive?: boolean;
}

export type Decision =
  | { kind: 'execute'; risk: RiskLevel; auto: boolean; reason: string }
  | { kind: 'confirm'; risk: RiskLevel; reason: string }
  | { kind: 'grant'; risk: RiskLevel; scope: Scope; level: PermissionLevel; reason: string }
  | { kind: 'refuse'; risk: RiskLevel; reason: string };

const BASE_RISK: Record<string, RiskLevel> = {
  'shopping.add': 'low',
  'shopping.complete': 'low',
  'shopping.remove': 'low',
  'shopping.update': 'low',
  'reminder.create': 'low',
  'reminder.complete': 'low',
  'reminder.archive': 'low',
  'reminder.update': 'low',
  'note.create': 'low',
  'memory.store': 'low',
  'memory.delete': 'low',
  'contact.update': 'low',
  'waiting.create': 'low',
  'waiting.resolve': 'low',
  'routine.create': 'low',
  'routine.automate': 'low',
  'draft.create': 'low',
  'calendar.create': 'low',
  'calendar.update': 'medium',
  'calendar.cancel': 'medium',
  'email.archive': 'medium',
  'email.delete': 'high',
  'message.send': 'medium',
  'email.send': 'medium',
  'invite.send': 'medium',
  'meeting.create': 'medium',
  'booking.create': 'medium',
  'purchase.create': 'high',
};

const SENSITIVE = /\b(resign|resignation|quit(?:ting)?|fired|divorce|break ?up|lawyer|legal|lawsuit|sue|complain|complaint|diagnos|pregnan|salary|pay ?rise|raise|password|bank|account number|pin|love you|hate|sorry for|apolog|condolence|funeral|died|passed away|debt|loan|invoice|refund)\b/i;

export function isSensitiveText(text: string): boolean {
  return SENSITIVE.test(text);
}

export function assessRisk(m: ActionMeta): RiskLevel {
  let risk = BASE_RISK[m.actionType] ?? 'medium';
  if (m.financial && m.financial.amount > 0) risk = 'high';
  if (m.destructive) risk = 'high';
  if (m.sensitive && m.external) risk = 'high';
  // Changes to events other people attend are more consequential than personal ones.
  if (m.external && risk === 'low') risk = 'medium';
  return risk;
}

/**
 * STEP 3–7 of the decision matrix. Steps 1–2 (intent/target clarity) are resolved by the
 * caller before an action is planned — ambiguous intent never reaches this function.
 */
export function decide(state: UserState, m: ActionMeta): Decision {
  const risk = assessRisk(m);

  // STEP 3: authorisation.
  if (!hasPermission(state, m.scope, m.needs)) {
    const current = permissionLevel(state, m.scope);
    return {
      kind: 'grant',
      risk,
      scope: m.scope,
      level: m.needs,
      reason: current === 'none' ? 'not-authorised' : 'needs-higher-level',
    };
  }

  // STEP 7 first: irreversible, financial, sensitive or destructive always confirms —
  // trust earned elsewhere never removes this safeguard.
  if (risk === 'high') return { kind: 'confirm', risk, reason: m.financial ? 'financial' : m.destructive ? 'destructive' : 'sensitive' };

  // STEP 4: low-risk (or reversible, personal, medium) actions within an authorised scope just happen.
  if (risk === 'low') return { kind: 'execute', risk, auto: true, reason: 'low-risk' };
  if (m.reversible && !m.external) return { kind: 'execute', risk, auto: true, reason: 'reversible-personal' };

  // STEP 6: the user has trusted this kind of action (explicitly or through repeated approval).
  if (isTrusted(state, m.actionType)) return { kind: 'execute', risk, auto: true, reason: 'trusted' };

  // STEP 5: meaningful consequence for other people → confirm.
  return { kind: 'confirm', risk, reason: m.external ? 'affects-others' : 'consequential' };
}
