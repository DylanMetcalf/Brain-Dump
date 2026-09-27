// Optional Claude assist. When the rule-based interpreter can't place a thought, Claude
// rewrites it into plain commands the interpreter already understands. Claude never acts
// directly: every rewritten command still goes through context resolution, the risk
// matrix, permissions and verification (spec §30).

import type { UserState } from './types.js';

/** Given a prompt, return Claude's raw text reply. Implemented per surface (server SDK, phone page). */
export type AskClaude = (prompt: string) => Promise<string>;

export function buildRewritePrompt(clause: string, state: UserState, now: Date): string {
  const tz = state.profile.timeZone;
  const upcoming = state.events
    .filter((e) => e.status === 'confirmed' && Date.parse(e.start) > now.getTime())
    .slice(0, 15)
    .map((e) => e.title);
  const shopping = state.shopping.filter((s) => s.status === 'needed').map((s) => s.name).slice(0, 20);
  const people = state.contacts.map((c) => c.name).slice(0, 30);
  return `You help a personal assistant app understand what its user said. The app only understands short, plain commands like these:
- "Add milk and eggs" (shopping list)
- "Remind me to call the dentist tomorrow at 9"
- "Yoga on Friday at 2pm" (a calendar event)
- "Cancel yoga" / "I can't make yoga tomorrow"
- "Move the dentist to Thursday at 3"
- "I got the milk"
- "Tell Sarah I'll be late" / "I need to reply to Rick"
- "Organise a Zoom with Rick on Thursday at 2"
- "Rick hasn't replied about the quote"
- "Note: <anything worth keeping>"

Rewrite the user's words into one or more of these plain commands, keeping their meaning exactly. Do not invent details they didn't say. If it is only a thought to keep, use "Note: ...". If it is a question for you rather than something to remember or do, return an empty list.

Context (may help resolve references): today is ${now.toISOString().slice(0, 10)} in ${tz}. Upcoming events: ${upcoming.join(', ') || 'none'}. Shopping list: ${shopping.join(', ') || 'empty'}. People: ${people.join(', ') || 'none'}.

User said: """${clause.slice(0, 500)}"""

Reply with only a JSON array of strings, for example ["Add oat milk", "Remind me to book the car service next week"].`;
}

export function parseRewrite(text: string): string[] {
  const t = text.trim();
  const candidates = [t, t.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], t.slice(t.indexOf('['), t.lastIndexOf(']') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const v = JSON.parse(c);
      if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 300)).slice(0, 6);
    } catch {
      /* try next */
    }
  }
  return [];
}
