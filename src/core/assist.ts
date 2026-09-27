// Claude as the understanding layer. When the fast rule-based interpreter isn't sure,
// Claude reads the whole brain dump and rewrites it into plain commands the app can
// act on. Claude never acts directly: every command still goes through context
// resolution, the risk matrix, permissions and verification (spec §30).

import type { UserState } from './types.js';

/** Given a prompt, return Claude's raw text reply. Implemented per surface (server SDK, phone page). */
export type AskClaude = (prompt: string) => Promise<string>;

export interface Rewrite {
  commands: string[];
  /** A direct answer when the user asked a question that isn't a task. */
  reply?: string;
}

export function buildRewritePrompt(utterance: string, state: UserState, now: Date, recent: { role: string; text: string }[] = []): string {
  const tz = state.profile.timeZone;
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(now);
  const upcoming = state.events
    .filter((e) => e.status === 'confirmed' && Date.parse(e.start) > now.getTime())
    .slice(0, 15)
    .map((e) => e.title);
  const shopping = state.shopping.filter((s) => s.status === 'needed').map((s) => s.name).slice(0, 20);
  const people = state.contacts.map((c) => c.name).slice(0, 30);
  const convo = recent.slice(-4).map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`).join('\n');
  return `You are the understanding layer of a personal assistant app called Brain Dump. People talk to it in a stream of consciousness. Turn what they said into plain commands the app understands. Commands it understands (use this wording style):

Calendar: "Yoga on Friday at 2pm" · "Add dentist to my calendar on Thursday at 10" · "Cancel yoga" · "I can't make yoga tomorrow" · "Move the dentist to Thursday at 3"
Reminders: "Remind me to call the bank tomorrow at 9" · "Remind me to pay rent on the 1st"
Notes: "Make a note: <text>"
Shopping: "Add milk and eggs" · "I got the milk"
Messages: "Send a WhatsApp to Mum saying <message>" · "Send a text to Rick saying <message>" · "Email Sarah saying <message>" · "Reply to Sarah"
Calls: "Call Mum" · "FaceTime Dad"
Meetings: "Organise a Zoom with Rick on Thursday at 2"
Clock: "Set a timer for 10 minutes" · "Set an alarm for 7am"
Music: "Play <artist, song, playlist or mood>" · "Play <x> on Spotify"
Email: "Check my emails" · "Did I get an email from Rick"
People: "Mum's number is <number>" · "Rick's email is <address>" · "Rick lives in New York"
Waiting: "Rick hasn't replied about the quote"
Status: "What still needs me?" · "What did you handle today?" · "What's on tomorrow?"

Rules:
- Cover everything they said, in order, one command per task. Keep their exact meaning and details (names, times, message wording). Never invent details.
- Write message text in the user's own voice, addressed to the recipient ("I'll be late", not "tell her you'll be late").
- If something is only a thought worth keeping, use "Make a note: …". Ignore filler ("um", "anyway").
- If they asked a general question that is not a task (a fact, advice, a definition), answer it briefly in "reply" (1-3 sentences) instead of a command.

Context: it is ${local} (${tz}). Upcoming events: ${upcoming.join(', ') || 'none'}. Shopping list: ${shopping.join(', ') || 'empty'}. People they know: ${people.join(', ') || 'none yet'}.${convo ? `\nRecent conversation:\n${convo}` : ''}

User said: """${utterance.slice(0, 2000)}"""

Reply with only JSON: {"commands": ["..."], "reply": "optional short answer"}`;
}

export function parseRewrite(text: string): Rewrite {
  const t = text.trim();
  const candidates = [t, t.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1), t.slice(t.indexOf('['), t.lastIndexOf(']') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const v = JSON.parse(c);
      const list = Array.isArray(v) ? v : Array.isArray(v?.commands) ? v.commands : undefined;
      if (!list) continue;
      const commands = list.filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => x.trim().slice(0, 400)).slice(0, 12);
      const reply = !Array.isArray(v) && typeof v?.reply === 'string' && v.reply.trim() ? v.reply.trim().slice(0, 600) : undefined;
      return { commands, reply };
    } catch {
      /* try next */
    }
  }
  return { commands: [] };
}
