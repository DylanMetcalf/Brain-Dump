import type { Channel } from './types.js';
// The Brain Dump interpreter: turns messy human language into structured thoughts.
// Deterministic and explainable; the user never has to pick a category.

import { parseWhen, ParsedWhen, NUMBER_WORDS } from './time.js';
import { cleanItem, lower, normalize, soundsLike } from './text.js';

export type Thought =
  | { kind: 'end'; raw: string }
  | { kind: 'yes'; raw: string }
  | { kind: 'no'; raw: string }
  | { kind: 'shopping_add'; raw: string; items: { name: string; quantity?: number }[]; generic?: boolean }
  | { kind: 'shopping_got'; raw: string; items: string[] }
  | { kind: 'shopping_remove'; raw: string; items: string[] }
  | { kind: 'cancel'; raw: string; phrase: string; when: ParsedWhen }
  | { kind: 'modify'; raw: string; phrase: string; when: ParsedWhen; quantity?: number; rename?: string }
  | { kind: 'undo'; raw: string }
  | { kind: 'send'; raw: string }
  | { kind: 'done'; raw: string; phrase: string; verb?: string }
  | { kind: 'event_add'; raw: string; title: string; when: ParsedWhen; explicitCalendar: boolean }
  | { kind: 'reminder'; raw: string; text: string; when: ParsedWhen; reminderKind: 'task' | 'call' | 'message' | 'follow_up'; personName?: string }
  | { kind: 'recall'; raw: string; phrase: string; when: ParsedWhen; forgot: boolean }
  | { kind: 'communicate'; raw: string; personName?: string; channel?: Channel; body?: string; later: boolean; when: ParsedWhen; verb: string }
  | { kind: 'meeting'; raw: string; people: string[]; provider?: string; when: ParsedWhen }
  | { kind: 'booking'; raw: string; service: string; when: ParsedWhen }
  | { kind: 'purchase'; raw: string; item: string }
  | { kind: 'waiting'; raw: string; personName: string; about: string; direction: 'them' | 'me' }
  | { kind: 'replied'; raw: string; personName: string }
  | { kind: 'query'; raw: string; topic: QueryTopic; when?: ParsedWhen; personName?: string }
  | { kind: 'friction'; raw: string }
  | { kind: 'weekly'; raw: string }
  | { kind: 'activity'; raw: string; activity: string; when: ParsedWhen }
  | { kind: 'rename'; raw: string; name: string }
  | { kind: 'contact_fact'; raw: string; personName: string; field: 'email' | 'phone' | 'city'; value: string }
  | { kind: 'user_fact'; raw: string; field: 'city' | 'name'; value: string }
  | { kind: 'remember_fact'; raw: string; subject: string; value: string; memoryKind: 'preference' | 'service' | 'fact' | 'place' | 'person' }
  | { kind: 'forget'; raw: string; phrase: string }
  | { kind: 'trust'; raw: string; grant: boolean }
  | { kind: 'email_clear'; raw: string; query: string; permanent: boolean }
  | { kind: 'meeting_link'; raw: string; provider: 'zoom' | 'meet' | 'teams' | 'other'; url: string }
  | { kind: 'note'; raw: string; text: string; idea: boolean; explicit?: boolean }
  | { kind: 'call'; raw: string; personName: string; video: boolean }
  | { kind: 'timer'; raw: string; ms: number; label: string }
  | { kind: 'alarm'; raw: string; when: ParsedWhen }
  | { kind: 'music'; raw: string; query: string; service?: string }
  | { kind: 'check_email'; raw: string; from?: string }
  /** A direct answer (from Claude) to a question that isn't a task. */
  | { kind: 'say'; raw: string; text: string }
  | { kind: 'filler'; raw: string };

export type QueryTopic =
  | 'needs_me'
  | 'handled'
  | 'schedule'
  | 'shopping'
  | 'reminders'
  | 'waiting'
  | 'replied'
  | 'memory'
  | 'help'
  | 'name'
  | 'time';

export interface InterpretOptions {
  now: Date;
  timeZone: string;
  assistantName?: string;
  nameAliases?: string[];
}

export interface Interpretation {
  thoughts: Thought[];
  addressedByName: boolean;
  /** The text after wake-word removal. */
  text: string;
}

// ---------------------------------------------------------------------------
// Pre-processing
// ---------------------------------------------------------------------------

/** Strip "Hey Milo," / "Milo, …" — only in wake position, never mid-sentence. */
export function stripWakeName(text: string, name?: string, aliases: string[] = []): { text: string; addressed: boolean } {
  if (!name) return { text, addressed: false };
  const t = normalize(text);
  const m = t.match(/^(?:(hey|hi|hello|ok|okay|yo|oi)[\s,]+)?([A-Za-z']+)(?:[\s,]+([A-Za-z']+))?([\s,.!?]+|$)(.*)$/is);
  if (!m) return { text: t, addressed: false };
  const [, greet, w1, w2, sep, rest] = m;
  // Two-word mishearing ("my low" for Milo)
  if (w2 && soundsLike(w1 + w2, name, aliases) && (greet || /,/.test(sep) || /^[,]/.test(sep))) {
    return { text: rest.trim(), addressed: true };
  }
  if (soundsLike(w1, name, aliases)) {
    const afterName = t.slice(t.toLowerCase().indexOf(w1.toLowerCase()) + w1.length).replace(/^[\s,.!?]+/, '');
    // Bare name followed by comma/greeting, or a greeting before it: treat as wake word.
    const nextChunk = t.slice(t.toLowerCase().indexOf(w1.toLowerCase()) + w1.length);
    if (greet || /^[\s]*[,.!?]/.test(nextChunk) || !afterName || /^(can|could|would|will|please|remind|add|cancel|i|what|move|book|tell|message|set|organi[sz]e|put|take|make)\b/i.test(afterName)) {
      return { text: afterName, addressed: true };
    }
  }
  return { text: t, addressed: false };
}

const LEADING_FILLER = /^(?:(?:oh|and|also|plus|um+|uh+|erm+|er|so|well|ok(?:ay)?|right|then|but|anyway|hmm+|ah+|damn|ugh|oops|oh yeah|yeah and|oh and|and also|oh also|actually(?= i\b| i'| we\b| can\b| could\b| remind| add| i need))\b[\s,]*)+/i;
const TRAILING_FILLER = /[\s,]*(?:please|thanks|thank you|cheers|too|as well)[.!]*$/;

function stripFillers(s: string): string {
  let t = s.trim().replace(/^[,;.\s]+/, '');
  // "yes" must not be eaten as filler
  let prev = '';
  while (prev !== t) {
    prev = t;
    t = t.replace(LEADING_FILLER, '').trim();
  }
  return t;
}

const STRONG_STARTER =
  /^(?:remind|cancel|reschedule|book|add|buy|order|delete|organi[sz]e|arrange|schedule|what|what's|whats|has|did|i can't|i cant|i cannot|i can not|i need|i have to|i've got to|i should|i must|i forgot|i got|i've got|i bought|i'm not|im not|i am not|don't forget|dont forget|move|and remind|call|ring)\b/;

const CLAUSE_STARTER = new RegExp(
  [
    "i\\b", "i'm\\b", "im\\b", "i've\\b", "i'll\\b", "i'd\\b", 'we\\b', "we're\\b", "we've\\b",
    'remind', 'cancel', 'move', 'reschedule', 'book', 'add', 'put ', 'take ', 'remove', 'delete', 'tell ', 'message', 'text ',
    'email', 'reply', 'respond', 'call ', 'ring ', 'phone ', 'organi[sz]e', 'arrange', 'set up', 'setup', 'schedule', 'make (?:it|that|this)',
    'change', 'push', 'bring', 'what', 'has ', 'have ', 'did ', 'is ', 'are ', 'can you', 'could you', 'would you', 'will you', 'please ',
    "don't", 'dont', 'do not', 'no need', 'forget', 'my ', 'actually', 'need to', 'buy ', 'pick up', 'grab ', 'order ', 'note', 'idea',
    'remember', 'let ', 'also ', "that's all", 'thats all', 'that is all', "that's it", 'undo', 'cross ', 'scratch ', 'skip ', 'clear ',
    'archive ', 'get back', 'find ', 'check ',
  ]
    .map((s) => `^${s}`)
    .join('|'),
);
const PERSON_CLAUSE = /^[a-z]+ (?:hasn't|has not|still hasn't|didn't|did not|replied|got back|is waiting|wants|needs|said|confirmed|lives|is based|is in|works)/;

function startsClause(s: string): boolean {
  const t = stripFillers(s.toLowerCase());
  return CLAUSE_STARTER.test(t) || PERSON_CLAUSE.test(t) || isEnding(t) || /^(yes|no|yeah|nope)\b/.test(t);
}

const COMMS_START = /^(?:just )?(?:tell|say|let \w+ know|ask|reply|respond|message|text|email|whatsapp|write)\b/;

/** Split a stream of consciousness into separate thoughts. */
export function segment(text: string): string[] {
  const sentences = normalize(text)
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const sentence of sentences) {
    // Candidate split points: ", " / " and " / " oh " / " also " / " plus " / " but " / " then "
    const re = /\s*,\s*|\s+(?:and then|and also|oh and|and|oh|also|plus|but|then)\s+/gi;
    let last = 0;
    let current = '';
    let m: RegExpExecArray | null;
    const pieces: { sep: string; text: string }[] = [];
    while ((m = re.exec(sentence))) {
      pieces.push({ sep: '', text: sentence.slice(last, m.index) });
      pieces.push({ sep: m[0], text: '' });
      last = m.index + m[0].length;
    }
    pieces.push({ sep: '', text: sentence.slice(last) });

    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      if (!p.sep) {
        current += p.text;
        continue;
      }
      const next = pieces[i + 1]?.text ?? '';
      const lowerCurrent = stripFillers(current.toLowerCase());
      const inComms = COMMS_START.test(lowerCurrent) || /\b(?:and )?(?:tell|say to|let) (?:her|him|them|\w+)\b/.test(lowerCurrent);
      const split = stripFillers(current).trim() && next.trim() && (inComms ? STRONG_STARTER.test(stripFillers(next.toLowerCase())) : startsClause(next));
      // Never split "reply to Sarah and tell her …"
      const joinComms = /^\s*(?:and\s+)?(?:tell|say|ask|let)\b/i.test(p.sep + next) && /\b(reply|respond|message|text|email|write|get back)\b/i.test(lowerCurrent) && /and/i.test(p.sep);
      if (split && !joinComms) {
        out.push(current.trim());
        current = '';
      } else {
        current += p.sep;
      }
    }
    if (current.trim()) out.push(current.trim());
  }
  // "Pilates Tuesday at 7pm and pilates Thursday at 7am": two timed things joined by "and".
  const expanded: string[] = [];
  for (const c of out) {
    const parts = c.split(/\s+and\s+/i);
    const timed = (x: string) => {
      const p = parseWhen(x, new Date(0), 'UTC');
      return !!p.time && (p.date !== undefined || p.weekday !== undefined) && p.rest.length > 1;
    };
    if (parts.length === 2 && timed(parts[0]) && timed(parts[1])) expanded.push(...parts);
    else expanded.push(c);
  }
  return expanded.map((s) => s.replace(/^[,;\s]+|[,;\s]+$/g, '')).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const ENDINGS = [
  /^(?:ok(?:ay)?[, ]*)?(?:thanks?(?: you)?[, ]*)?(?:that'?s|that is|thats) (?:all|it|everything|good|all for now|it for now|everything for now|good for now|all i need|all i've got|all i got)\b/,
  /^(?:i'?m|i am) (?:done|finished|all done|good)\b/,
  /^nothing (?:else|more)\b/,
  /^(?:ok(?:ay)?,? )?that should (?:be|do) (?:everything|it|good|all)(?: for now)?\b/,
  /^(?:we'?re|we are) (?:good|done|all good)\b/,
  /^all (?:done|good)\b/,
  /^(?:bye|goodbye|see you|later|cheers)\b\.?$/,
  /^that'?ll (?:be|do) (?:all|it)\b/,
  /^(?:no,? )?that'?s (?:all|it)\b/,
  /^(?:ok(?:ay)?,? )?(?:that's|thats) (?:good|great|perfect) for now\b/,
  /^(?:thanks|thank you|cheers)(?:,? (?:that'?s all|that is all|bye))?[.!]*$/,
  /^(?:ok(?:ay)?,? )?(?:i think )?that'?s (?:everything|all)\b/,
  /^no,? (?:i'?m good|that'?s fine|nothing else)\b/,
];

export function isEnding(t: string): boolean {
  const s = lower(t).replace(/[.!]+$/, '');
  return ENDINGS.some((re) => re.test(s));
}

const YES = /^(?:yes|yeah|yep|yup|ya|yah|sure|ok|okay|please|do it|go ahead|sounds good|correct|right|that's right|thats right|absolutely|definitely|yes please|please do|go for it|perfect|great|fine|that works|why not|of course|send it|book it|do that|affirmative)(?:[\s,.!]|$)/;
const NO = /^(?:no|nope|nah|no thanks|no thank you|not now|not really|leave it|keep it|never ?mind|don't bother|dont bother|no need|not yet|skip it|i'?m good|all good|it's fine|its fine|that's fine|negative)(?:[\s,.!]|$)/;

export function isYes(t: string): boolean {
  return YES.test(lower(t));
}
export function isNo(t: string): boolean {
  return NO.test(lower(t));
}

const GROCERY_WORDS = /\b(milk|eggs?|bread|butter|cheese|yog(?:h)?urt|apples?|bananas?|oranges?|lemons?|limes?|avocados?|tomatoes?|potatoes?|onions?|garlic|carrots?|lettuce|spinach|rice|pasta|flour|sugar|salt|pepper|oil|coffee|tea|juice|water|wine|beer|chicken|beef|fish|salmon|tuna|ham|bacon|sausages?|cereal|oats|honey|jam|biscuits?|cookies?|crisps|chocolate|shampoo|conditioner|soap|toothpaste|toothbrush|deodorant|razors?|tissues|toilet (?:paper|roll)|kitchen roll|paper towels|batteries|bin bags|detergent|washing (?:up )?liquid|bleach|sponges?|face masks?|masks?|eye patches|plasters|paracetamol|ibuprofen|vitamins|cat food|dog food|nappies|diapers|wipes|groceries|grocery|food|snacks?|fruit|veg(?:etables)?|herbs?|spices?|nuts|milk)\b/;

const TASKY_OBJECT = /(?:\b\w+(?:ed|en)\b\s*$|\b(?:done|fixed|cut|sorted|checked|looked at|signed|haircut|hair cut|flu jab|jab|vaccine|vaccinated|appointment|licen[cs]e|passport|visa|mot|insurance|quote|refund|back to|ready|going|started|in touch|a lift|help|some sleep|some rest|a new job)\b)/;

const ACTIVITIES = /(run|jog|walk|swim|ride|bike ride|cycle|gym|workout|work out|yoga|calisthenics|pilates|climb|hike|training|class|spin class|session)/;

const PERSON_WORD = "([a-z][a-z'\\-]*(?: [a-z][a-z'\\-]*)?)";

/** Remove trailing time words from a person name capture: "sarah tomorrow" → "sarah". */
function cleanPerson(name: string): string {
  const stripped = name
    .replace(/^(?:my|our)\s+/, '')
    .replace(/\b(today|tomorrow|tonight|later|now|soon|back|about|re|regarding|on|at|that|and|to|asap|first thing|this|next|please|again|the|a|an|for|by|saying|telling|asking|says)\b.*$/, '')
    .replace(/'s$/, '')
    .trim();
  return normalizePersonName(stripped);
}

const FAMILY: Record<string, string> = {
  mom: 'Mom', mum: 'Mum', mommy: 'Mom', mummy: 'Mum', mother: 'Mum', ma: 'Mum', mam: 'Mam',
  dad: 'Dad', daddy: 'Dad', father: 'Dad', pa: 'Dad', papa: 'Papa',
  nan: 'Nan', nana: 'Nana', gran: 'Gran', granny: 'Granny', grandma: 'Grandma', grandpa: 'Grandpa', grandad: 'Grandad', granddad: 'Grandad',
  sister: 'Sister', sis: 'Sister', brother: 'Brother', bro: 'Brother', wife: 'Wife', husband: 'Husband', partner: 'Partner',
  boyfriend: 'Boyfriend', girlfriend: 'Girlfriend', auntie: 'Auntie', aunt: 'Auntie', uncle: 'Uncle', son: 'Son', daughter: 'Daughter',
};

/** "my mom" → "Mom", "mother" → "Mum"; other names are returned unchanged. */
export function normalizePersonName(name: string): string {
  const n = name.trim().replace(/^(?:my|our)\s+/i, '');
  return FAMILY[n.toLowerCase()] ?? n;
}

export function isFamilyWord(name: string): boolean {
  return !!FAMILY[name.trim().replace(/^(?:my|our)\s+/i, '').toLowerCase()];
}

function channelFor(word: string): Channel {
  if (/mail/.test(word)) return 'email';
  if (/whats ?app/.test(word)) return 'whatsapp';
  if (/text|sms|imessage/.test(word)) return 'sms';
  return 'message';
}

/** "10 minutes", "an hour and a half", "1h30", "90 seconds" → milliseconds. */
export function parseDuration(text: string): number | undefined {
  const t = text.toLowerCase().replace(/-/g, ' ');
  let ms = 0;
  let found = false;
  const re = /(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty five|sixty|ninety|half an?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, sixty: 60, ninety: 90, 'half a': 0.5, 'half an': 0.5 };
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : words[m[1]] ?? 1;
    const unit = m[2][0];
    ms += n * (unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000);
    found = true;
  }
  if (/\band a half\b/.test(t) && found) ms += /hour/.test(t) ? 1800000 : 30000;
  if (/^half an hour$/.test(t.trim())) return 1800000;
  return found && ms > 0 ? ms : undefined;
}

function durationLabel(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  const parts = [h ? `${h} hour${h > 1 ? 's' : ''}` : '', m ? `${m} minute${m > 1 ? 's' : ''}` : ''].filter(Boolean);
  return parts.join(' ') || `${Math.round(ms / 1000)} seconds`;
}

function pronounOrName(s: string): string {
  return s.trim();
}

/** Convert "tell her I'll get back to her tonight" style bodies into second person. */
export function toSecondPerson(body: string): string {
  let b = normalize(body)
    .replace(/^(?:just |and )?(?:tell|say to|let) (?:her|him|them|[A-Za-z]+)(?: know)?(?: that)?[\s,:]*/i, '')
    .replace(/^(?:just )?(?:say|saying|that)[\s,:]+/i, '')
    .replace(/^(?:just )?(?:tell|say)[\s,:]+/i, '')
    .trim();
  b = b
    .replace(/\b(she|he) is\b/gi, 'you are')
    .replace(/\b(she|he|they)'s\b/gi, "you're")
    .replace(/\b(she|he|they) (was)\b/gi, 'you were')
    .replace(/\b(she|he|they)\b/gi, 'you')
    .replace(/\b(her|him|them)\b/gi, 'you')
    .replace(/\byou (has|does)\b/gi, (_m, v) => `you ${v === 'has' ? 'have' : 'do'}`);
  b = b.replace(/\s+/g, ' ').trim();
  if (!b) return b;
  b = b[0].toUpperCase() + b.slice(1);
  if (!/[.!?]$/.test(b)) b += '.';
  return b;
}

function parseItems(s: string): { name: string; quantity?: number }[] {
  return s
    .replace(/\b(from|at) (the )?(shop|store|supermarket|tesco|sainsbury'?s|asda|waitrose|lidl|aldi|target|walmart|costco|pharmacy|chemist)\b.*$/, '')
    .replace(/\b(to|on|onto) (my |the )?(shopping |grocery )?list\b/, '')
    .split(/\s*,\s*|\s+and\s+|\s*&\s*|\s+plus\s+/)
    .map((x) => cleanItem(x))
    .filter((x) => x.name && x.name.length < 60 && !/^(it|that|this|them|stuff|things)$/.test(x.name));
}

type Matcher = (t: string, o: string, ctx: InterpretOptions) => Thought | undefined;

const w = (t: string, ctx: InterpretOptions, opts?: { answerMode?: boolean }) => parseWhen(t, ctx.now, ctx.timeZone, opts);

const MATCHERS: Matcher[] = [
  // Endings
  (t, o) => (isEnding(t) ? { kind: 'end', raw: o } : undefined),

  // Undo
  (t, o) =>
    /^(?:undo(?: that| it| the last(?: thing| one)?)?|put (?:it|that) back|bring (?:it|that) back|restore (?:it|that)|revert(?: that| it)?|take that back|oops,? undo(?: that)?|wait,? (?:undo|put it back)|no,? put it back)$/.test(t)
      ? { kind: 'undo', raw: o }
      : undefined,

  // Send a prepared message
  (t, o) => (/^(?:(?:ok(?:ay)?|yes|yeah)[, ]+)?(?:(?:please |go ahead and |just )?send (?:it|that|them|the (?:message|email|invite|invites|reply|text))(?: now| off)?|send it off)$/.test(t) ? { kind: 'send', raw: o } : undefined),

  // Naming
  (t, o) => {
    const m = o.match(/^(?:(?:i'?(?:ll|d like to|want to|wanna) )?call (?:you|yourself)|your name is|your new name is|change your name to|rename yourself(?: to)?|i'?ll name you|let'?s call you|you can be called|you'?re called)\s+(.+?)[.!]*$/i);
    if (m) return { kind: 'rename', raw: o, name: m[1].replace(/^["']|["']$/g, '').trim() };
    return undefined;
  },

  // Trust grants: "you don't need to ask me about that", "just do it next time"
  (t, o) => {
    if (/^(?:you )?(?:don'?t|do not|no need to) (?:need to )?(?:ask|check with|confirm with) me(?: (?:about|for) (?:that|this|things like that|these))?(?: again| anymore| next time)?$/.test(t) || /^(?:just do it|just handle it|just go ahead)(?: next time| from now on| in future)?$/.test(t) || /^(?:always|from now on) just do (?:that|it)$/.test(t)) {
      return { kind: 'trust', raw: o, grant: true };
    }
    if (/^(?:always )?(?:ask|check with) me (?:first|before)(?: .*)?$/.test(t)) return { kind: 'trust', raw: o, grant: false };
    return undefined;
  },

  // Queries
  (t, o) => {
    if (/(?:what|anything|stuff) (?:still )?needs? (?:me|my attention)|what am i forgetting|what (?:have i|did i) forget|what(?:'s| is) (?:left|outstanding|pending|on my plate)|what do i (?:still )?need to do|anything i need to (?:do|know)|what'?s waiting on me|what needs doing/.test(t))
      return { kind: 'query', raw: o, topic: 'needs_me' };
    if (/what (?:did|have) you (?:handle|handled|do|done|sort|sorted|take care of|taken care of)|what have you done|what did you get done|what'?s been (?:done|handled)/.test(t))
      return { kind: 'query', raw: o, topic: 'handled', when: w(t, { now: new Date(), timeZone: 'UTC' }) };
    if (/what(?:'s| is| do i have| have i got)(?: on)?(?: my)? (?:calendar|schedule|diary|agenda)|what(?:'s| is| do i have| have i got)(?: on| happening)? (?:today|tomorrow|this week|next week|this weekend|(?:on )?\w+day)|what'?s (?:coming up|next)|am i free|do i have anything/.test(t))
      return { kind: 'query', raw: o, topic: 'schedule' };
    if (/what(?:'s| is) on (?:my|the) (?:shopping|grocery|groceries) list|what do (?:i|we) need (?:to buy|from the shop|to get)|^(?:read me |show me )?(?:my |the )?(?:shopping|grocery) list\??$/.test(t))
      return { kind: 'query', raw: o, topic: 'shopping' };
    if (/what(?:'s| are) (?:my )?reminders|what am i supposed to remember/.test(t)) return { kind: 'query', raw: o, topic: 'reminders' };
    const replied = t.match(/^(?:has|did|have) ([a-z]+) (?:replied|responded|got back|gotten back|answered|confirmed|written back|emailed|messaged)(?: (?:to )?me)?(?: yet)?\??$/);
    if (replied) return { kind: 'query', raw: o, topic: 'replied', personName: replied[1] };
    if (/what am i waiting (?:on|for)|who am i waiting (?:on|for)|who (?:owes|hasn'?t replied)/.test(t)) return { kind: 'query', raw: o, topic: 'waiting' };
    if (/what do you (?:know|remember) about me|what have you (?:learned|learnt|remembered)/.test(t)) return { kind: 'query', raw: o, topic: 'memory' };
    if (/^(?:help|what can you do|how does this work|what do you do)\??$/.test(t)) return { kind: 'query', raw: o, topic: 'help' };
    if (/^what(?:'s| is) your name\??$|^who are you\??$/.test(t)) return { kind: 'query', raw: o, topic: 'name' };
    if (/^what time is it\??$/.test(t)) return { kind: 'query', raw: o, topic: 'time' };
    return undefined;
  },
  (t, o) => (/(?:make|making) (?:this|things|it|life|my life|everything) (?:easier|simpler)|can you simplify|anything you can (?:simplify|automate|make easier)|how can you help more/.test(t) ? { kind: 'friction', raw: o } : undefined),
  (t, o) => (/weekly (?:review|briefing|brief|check-?in|catch-?up)|what'?s (?:happening|on) this week|sunday (?:review|briefing)|(?:run|do|start) (?:my|the) (?:week|weekly)/.test(t) ? { kind: 'weekly', raw: o } : undefined),

  // Meeting link memory: "my zoom link is https://…"
  (t, o) => {
    const m = o.match(/my (?:personal )?(zoom|google meet|meet|teams)(?: meeting)?(?: room)? (?:link|url|room) is (\S+)/i);
    if (m) {
      const p = m[1].toLowerCase();
      return { kind: 'meeting_link', raw: o, provider: p === 'zoom' ? 'zoom' : p.includes('meet') ? 'meet' : 'teams', url: m[2].replace(/[.,]$/, '') };
    }
    return undefined;
  },

  // Contact facts
  (t, o) => {
    const m = o.match(/^([A-Za-z]+(?: [A-Za-z]+)?)'?s (email|e-mail|email address|number|phone(?: number)?|mobile(?: number)?) is (.+?)[.]?$/i);
    if (m && !/^(my|your|his|her|their)$/i.test(m[1])) {
      return { kind: 'contact_fact', raw: o, personName: m[1], field: /mail/i.test(m[2]) ? 'email' : 'phone', value: m[3].trim() };
    }
    const c = o.match(/^([A-Za-z]+) (?:lives|is based|is living|lives now|works|is) in ([A-Za-z .]+?)[.]?$/i);
    if (c && !/^(i|it|that|this|he|she|they|we|there|what|everything)$/i.test(c[1])) {
      return { kind: 'contact_fact', raw: o, personName: c[1], field: 'city', value: c[2].trim() };
    }
    return undefined;
  },
  (t, o) => {
    const m = t.match(/^i (?:live|am based|'m based|moved) in ([a-z .]+)$|^i'?m (?:now )?(?:living|based) in ([a-z .]+)$/);
    if (m) return { kind: 'user_fact', raw: o, field: 'city', value: (m[1] ?? m[2]).trim() };
    const n = o.match(/^(?:my name is|call me|i'?m called) ([A-Za-z][A-Za-z' -]{0,30})[.!]?$/i);
    if (n) return { kind: 'user_fact', raw: o, field: 'name', value: n[1].trim() };
    return undefined;
  },

  // Forget a memory
  (t, o) => {
    const m = t.match(/^(?:forget|stop remembering|delete the memory|don'?t remember) (?:that|what i (?:said|told you) about|about|that i) ?(.*)$/);
    if (m && !/\b(milk|bread|eggs|buy|get)\b/.test(m[1] ?? '')) return { kind: 'forget', raw: o, phrase: (m[1] ?? '').trim() };
    if (/^forget (?:it|that)$/.test(t)) return { kind: 'forget', raw: o, phrase: '' };
    return undefined;
  },

  // Email clearing
  (t, o) => {
    const m = t.match(/^(?:clear|archive|delete|get rid of|bin|trash|remove)(?: all)? (?:those |these |the |my |all (?:the |my )?)?(.*?)(?:emails?|mails?|newsletters|messages in my inbox)(?: permanently| for good| forever)?$/);
    if (m && /(?:emails?|mails?|newsletters)/.test(t)) {
      return { kind: 'email_clear', raw: o, query: m[1].trim(), permanent: /permanently|for good|forever/.test(t) || /^delete|^trash|^bin/.test(t) && /permanently|for good|forever/.test(t) };
    }
    return undefined;
  },

  // Replied: "Rick replied", "Rick got back to me"
  (t, o) => {
    const m = t.match(/^([a-z]+) (?:has |just )?(?:replied|responded|got back to me|got back|answered|confirmed|emailed me back|wrote back|messaged me back)(?: (?:to )?me)?(?: finally)?$/);
    if (m && !/^(i|it|that|this|someone|nobody|they|he|she)$/.test(m[1])) return { kind: 'replied', raw: o, personName: m[1] };
    return undefined;
  },

  // Waiting states
  (t, o) => {
    let m = t.match(/^([a-z]+(?: [a-z]+)?) (?:still )?(?:hasn'?t|has not|didn'?t|did not|never|hasnt) (?:replied|responded|got back|gotten back|answered|confirmed|sent|come back|written back|called back|rung back|paid)(?: (?:to )?me)?(?: yet)?(?: (?:about|on|re|regarding|with|for) (.+))?$/);
    if (m) return { kind: 'waiting', raw: o, personName: m[1], about: m[2] ?? '', direction: 'them' };
    m = t.match(/^(?:i'?m |i am |still )?waiting (?:on|for) ([a-z]+)(?: to (?:reply|respond|get back|confirm|send)(?: to me)?)?(?: (?:about|on|re|for|with|to) (.+))?$/);
    if (m && !/^(the|a|an|my|it|that)$/.test(m[1])) return { kind: 'waiting', raw: o, personName: m[1], about: m[2] ?? '', direction: 'them' };
    m = t.match(/^([a-z]+(?: [a-z]+)?) is waiting (?:for|on) (?:me|my|an answer from me)(?: (?:to|about|for|on) (.+))?(.*)$/);
    if (m && !/^(it|that|this|everyone)$/.test(m[1])) return { kind: 'waiting', raw: o, personName: m[1], about: (m[2] ?? m[3] ?? '').replace(/^\s*(answer|reply|response)\b/, 'an answer').trim(), direction: 'me' };
    m = t.match(/^i owe ([a-z]+) (?:an? )?(.+)$/);
    if (m) return { kind: 'waiting', raw: o, personName: m[1], about: m[2], direction: 'me' };
    return undefined;
  },

  // "Send a WhatsApp to my mum saying I'll be late" / "Send mum a text saying…"
  (t, o) => {
    const s = t.replace(/^(?:can you |could you |please |i need to |i want to |i'd like to |just )+/, '');
    let m = s.match(/^(?:send|write|drop|shoot|fire off)(?: a| an)? (whats ?app|text|imessage|message|sms|email|e-mail|mail|note)(?: message)? to (.+?)(?:(?: and)?(?: saying| that says| to say| telling (?:her|him|them)| asking (?:her|him|them)| that|:|,) ?(.+))?$/);
    let person: string | undefined;
    let word = '';
    let body: string | undefined;
    if (m) {
      word = m[1];
      person = m[2];
      body = m[3];
    } else {
      m = s.match(/^(?:send|text|whatsapp|message|email) (.+?) (?:a |an )(whats ?app|text|message|email|note)(?: message)?(?:(?: saying| that says| to say| telling (?:her|him|them)| that|:|,) ?(.+))?$/);
      if (m) {
        person = m[1];
        word = m[2];
        body = m[3];
      }
    }
    if (!person) return undefined;
    const name = cleanPerson(person);
    if (!name || /^(me|myself|it|that)$/.test(name.toLowerCase())) return undefined;
    return { kind: 'communicate', raw: o, personName: name, channel: channelFor(word), body: body ? toSecondPerson(body) : undefined, later: false, when: w('', { now: new Date(0), timeZone: 'UTC' }), verb: word.includes('mail') ? 'email' : 'message' };
  },

  // Calls (right now): "call mum", "facetime dad", "give Rick a ring"
  (t, o) => {
    const m = t.match(/^(?:can you |could you |please )?(?:(call|ring|phone|facetime|video call)(?: up)? (.+?)|give (.+?) a (?:call|ring|bell|facetime))(?: now| back)?$/);
    if (!m) return undefined;
    const target = (m[2] ?? m[3] ?? '').trim();
    if (!target || parseWhen(target, new Date(0), 'UTC').found) return undefined; // "call mum tomorrow" is a reminder
    if (/^(?:it|that|this|off|him|her|them)$/.test(target)) return undefined;
    return { kind: 'call', raw: o, personName: cleanPerson(target) || target, video: /facetime|video/.test(m[1] ?? t) };
  },

  // Timers: "set a timer for 10 minutes", "20 minute timer"
  (t, o) => {
    const m =
      t.match(/^(?:can you |please )?(?:set|start|put on|make)(?: me)?(?: a| an)? timer(?: for| of| on)? (.+)$/) ??
      t.match(/^(?:can you |please )?(?:set|start|put on|make)(?: me)?(?: a| an)? (.+?) timer$/) ??
      t.match(/^timer(?: for)? (.+)$/) ??
      t.match(/^(.+?) timer(?: please)?$/);
    if (!m) return undefined;
    const ms = parseDuration(m[1]);
    if (!ms) return undefined;
    return { kind: 'timer', raw: o, ms, label: durationLabel(ms) };
  },

  // Alarms: "set an alarm for 7am", "wake me up at 6:30"
  (t, o) => {
    const m = t.match(/^(?:can you |please )?(?:set|put|make)(?: me)?(?: an| my| the)? alarm(?: for| at| on)? (.+)$/) ?? t.match(/^(?:please )?wake me(?: up)?(?: at| by| for)? (.+)$/);
    if (!m) return undefined;
    const when = w(m[1], { now: new Date(0), timeZone: 'UTC' }, { answerMode: true });
    if (!when.time) return undefined;
    return { kind: 'alarm', raw: o, when };
  },

  // Music: "play some jazz", "put on Taylor Swift on Spotify", "I want to listen to Adele"
  (t, o) => {
    const m = t.match(/^(?:can you |could you |please )?(?:play|put on|start playing|shuffle|i want to listen to|i wanna listen to|let'?s listen to|listen to)(?: me)?(?: some| a bit of| my)? (.+?)(?: on (spotify|apple music|youtube music|youtube))?(?: please)?$/);
    if (!m) return undefined;
    if (parseWhen(m[1], new Date(0), 'UTC').found) return undefined; // "play tennis on Saturday at 10" is an event
    if (/\b(list|calendar|diary|reminder)\b/.test(m[1])) return undefined;
    return { kind: 'music', raw: o, query: keepCase(m[1].replace(/^(?:some|the)\s+/, ''), o), service: m[2] };
  },

  // Email check: "check my emails", "any new emails?", "did I get an email from Rick?"
  (t, o) => {
    if (/^(?:can you |please )?(?:check|read|go through|open|look at|scan|what'?s in)(?: my)? (?:e-?mails?|inbox|mail)(?: for me)?$/.test(t) || /^(?:do i have |have i got |are there |any )(?:any )?(?:new |unread )?(?:e-?mails?|mail)/.test(t) || /^what(?:'s| is) in my inbox/.test(t)) {
      return { kind: 'check_email', raw: o };
    }
    const m = t.match(/^(?:did i get|have i got|is there|any)(?: an| any)? (?:e-?mails?|mail) from (.+?)$/);
    if (m) return { kind: 'check_email', raw: o, from: cleanPerson(m[1]) };
    return undefined;
  },

  // Notes: "make a note that…", "take a note: …", "new note …"
  (t, o) => {
    const m = o.match(/^(?:can you |please )?(?:make|take|add|save|create|write)(?: a| me a)? (?:new |quick )?note(?: that| of| to say| saying| about)?[:,-]?\s+(.+)$/i) ?? o.match(/^(?:new note|note that|note down)[:,-]?\s+(.+)$/i);
    if (m) return { kind: 'note', raw: o, text: capitalizeFirst(m[1].trim()), idea: false, explicit: true } as Thought;
    return undefined;
  },

  // Shopping: got / bought (existing state)
  (t, o) => {
    const m = t.match(/^(?:i(?:'ve| have)?|we(?:'ve| have)?)? ?(?:just |already )?(?:got|bought|picked up|grabbed|found|have got)(?: the| some| a| an)? (.+?)(?: already| now| earlier| today| yesterday)?$/);
    if (m && !/^(to|a meeting|an appointment|time|it|that|home|back|a call|called|told|an email|a reply|sick|ill|covid|the flu)\b/.test(m[1]) && !/\b(tomorrow|at \d|on (?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/.test(m[1])) {
      const items = parseItems(m[1]).map((i) => i.name);
      if (items.length) return { kind: 'shopping_got', raw: o, items };
    }
    return undefined;
  },

  // Shopping: remove
  (t, o) => {
    let m = t.match(/^(?:don'?t|do not|no need to) (?:worry about|bother (?:with|about)|get|buy|need)(?: the| any)? (.+)$/);
    if (m && !/^(it|that|this|them)$/.test(m[1])) return { kind: 'shopping_remove', raw: o, items: parseItems(m[1]).map((i) => i.name) };
    m = t.match(/^(?:take|remove|cross|scratch|delete) (?:the )?(.+?) (?:off|from) (?:my |the )?(?:shopping |grocery )?list$/);
    if (m) return { kind: 'shopping_remove', raw: o, items: parseItems(m[1]).map((i) => i.name) };
    m = t.match(/^(?:we|i) (?:don'?t|do not) need (?:the |any )?(.+?)(?: anymore| any more| after all)?$/);
    if (m && !/^(to|it|that|this)\b/.test(m[1])) return { kind: 'shopping_remove', raw: o, items: parseItems(m[1]).map((i) => i.name) };
    m = t.match(/^(?:no more|forget (?:about )?the) (.+?)$/);
    if (m && GROCERY_WORDS.test(m[1])) return { kind: 'shopping_remove', raw: o, items: parseItems(m[1]).map((i) => i.name) };
    return undefined;
  },

  // Completion: "I already did that", "I called the dentist"
  (t, o) => {
    if (/^(?:i )?(?:already )?(?:did|done|finished|sorted|handled|completed) (?:that|it|this)(?: already)?$|^(?:i )?already did (?:that|it)$|^that'?s (?:done|sorted|handled)$|^done(?: that)?$|^(?:it'?s|its) done$|^i'?ve done (?:that|it)$|^i did it$/.test(t)) {
      return { kind: 'done', raw: o, phrase: '' };
    }
    const m = t.match(/^i(?:'ve| have)? (?:already |just )?(called|rang|phoned|messaged|texted|emailed|replied to|paid|booked|sent|posted|returned|renewed|cancelled|canceled|fixed|finished|sorted|done|picked up|dropped off|submitted|answered) (.+)$/);
    if (m) return { kind: 'done', raw: o, phrase: m[2], verb: m[1] };
    return undefined;
  },

  // Cancellation
  (t, o) => {
    const patterns: RegExp[] = [
      /^(?:(?:ah|oh|damn|ugh|so)[, ]+)?(?:i |we )?(?:can'?t|cannot|can not|won'?t be able to|will not be able to|am not able to|'m not able to|won'?t|will not|couldn'?t|am unable to|'m unable to|unable to|am not going to be able to|'m not going to be able to|not going to be able to|don'?t think i can) (?:make|go(?: to)?|do|attend|come(?: to)?|get to|join|manage|go ahead with|keep) ?(.*)$/,
      /^(?:i'?m|i am|we'?re|we are) (?:not|no longer) (?:going|coming|doing|attending|making|joining)(?: to)?(?: (?:go|make|do|attend) (?:to )?)?(.*)$/,
      /^(?:please )?(?:cancel|call off|drop|scrap|ditch)(?: my| the)? ?(.*)$/,
      /^(?:take|remove|delete|clear) (.+?) (?:off|from) (?:my |the )?(?:calendar|diary|schedule|agenda)$/,
      /^(?:take|remove|delete|scratch|bin|kill) (it|that|this|them)(?: off)?(?: my (?:calendar|list|diary))?$/,
      /^(?:skip|miss|bail on|bin off) (.+)$/,
      /^(?:i'?m )?(?:not doing|no longer doing|done with|giving up) (that|it|this)(?: anymore| any more)?$/,
      /^(?:i'?ll|i will|i'?m going to|i'?m gonna|gonna) (?:have to )?(?:skip|miss|cancel|pass on|give) (.+?)(?: a miss)?$/,
      /^(?:it'?s|that'?s|(.+?) is|(.+?)'s) (?:been )?(?:cancelled|canceled|called off|off)(?: now)?$/,
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m) {
        const phrase = (m.slice(1).find((x) => x !== undefined) ?? '').trim();
        if (/^(?:it|that|this) (?:work|happen|up|out|sense)\b/.test(phrase)) return undefined; // "I can't make it work"
        if (/^(?:believe|remember|decide|find|think|wait|sleep|stop|help|see|hear)\b/.test(phrase)) return undefined;
        const when = w(phrase, { now: new Date(0), timeZone: 'UTC' });
        return { kind: 'cancel', raw: o, phrase, when };
      }
    }
    return undefined;
  },

  // Modification
  (t, o) => {
    const s = t.replace(/^(?:actually|wait|sorry|no|hmm|oh)[, ]+/, '').replace(/^(?:actually|wait|sorry|no)[, ]+/, '');
    let m = s.match(/^(?:can you |could you |please )?(?:move|reschedule|shift|change|push|bring|switch|put|make|bump|update|set) (it|that|this|them|the (?:.+?)|my (?:.+?)|(?:[a-z]+(?: [a-z]+)?)) ?(?:to|till|until|for|into|back|forward|earlier|later|by|an? |half)?(.*)$/);
    if (m) {
      const obj = m[1];
      let rest = s.slice(s.indexOf(obj) + obj.length).trim();
      const whenText = rest;
      // Quantity change: "make that three", "make it 2 pints"
      const qty = rest.match(/^(?:to |into )?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|a dozen|dozen)( .+)?$/);
      const when = w(rest, { now: new Date(0), timeZone: 'UTC' }, { answerMode: true });
      let quantity: number | undefined;
      if (qty) quantity = /^\d+$/.test(qty[1]) ? Number(qty[1]) : NUMBER_WORDS[qty[1]] ?? (qty[1].includes('dozen') ? 12 : undefined);
      const hasShift = /\b(back|forward|earlier|later)\b/.test(s);
      if (when.found || quantity !== undefined || hasShift) {
        // Verbs like "put" and "set" need a destination to count as a modification.
        if (/^(?:put|set|make)/.test(s) && !/^(?:it|that|this|them)$/.test(obj) && !/^(?:the|my) /.test(obj) && !hasShift) {
          // "make dinner at 7" is not a modification.
          if (!/^(?:make|set)/.test(s)) return undefined;
          return undefined;
        }
        // Renaming: "change it to dentist" handled below.
        return { kind: 'modify', raw: o, phrase: obj, when: parseWhen(whenText, new Date(0), 'UTC', { answerMode: true }), quantity: when.time && quantity !== undefined && !/(pm|am|o'?clock|:)/.test(rest) ? quantity : when.time ? undefined : quantity };
      }
      const rename = rest.match(/^(?:to |into )?(?:a |an )?([a-z].{1,40})$/);
      if (rename && /^(?:change|rename|call)/.test(s) && /^(?:it|that|this)$/.test(obj)) {
        return { kind: 'modify', raw: o, phrase: obj, when, rename: rename[1] };
      }
    }
    m = s.match(/^(?:make it|let'?s (?:do|make it)|do|how about|can we do|change it to|move it to|actually) (\d{1,2}(?::\d{2})?(?:\s?(?:am|pm))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|(?:next )?\w+day(?: at .+)?|tomorrow(?: at .+)?|next week)(?: instead)?$/);
    if (m) return { kind: 'modify', raw: o, phrase: 'it', when: parseWhen(m[1], new Date(0), 'UTC', { answerMode: true }) };
    return undefined;
  },

  // Meetings
  (t, o) => {
    const m = t.match(/^(?:can you |could you |please |i need to |i want to |let'?s |i'?d like to )?(?:organi[sz]e|set up|setup|schedule|arrange|book|create|make|sort out|sort|put in|get|plan) (?:a |an |another |some )?(?:quick )?(zoom|google meet|meet|teams|video|facetime)?((?: ?(?:call|meeting|chat|catch[- ]?up|sync|session|1:1|one to one|one-on-one))*) (?:with|for) (.+)$/);
    const m2 = t.match(/^(?:(zoom|teams|facetime)|(?:video )?call) (?:with )?([a-z]+)(?: .*)?$/);
    const mm = m && (m[1] || m[2].trim()) ? m : undefined;
    if (mm || (m2 && m2[1])) {
      const provider = (mm ? mm[1] : m2![1]) || undefined;
      const peopleText = mm ? mm[3] : m2![2];
      const when = w(peopleText, { now: new Date(0), timeZone: 'UTC' });
      const names = when.rest
        .replace(/\b(about|to discuss|re|regarding|for)\b.*$/, '')
        .split(/\s*,\s*|\s+and\s+|\s*&\s*/)
        .map((x) => cleanPerson(x))
        .filter(Boolean);
      return { kind: 'meeting', raw: o, people: names, provider: provider === 'google meet' ? 'meet' : provider === 'video' ? undefined : provider, when };
    }
    return undefined;
  },

  // Purchase (explicit order / buy that specific thing)
  (t, o) => {
    const m = t.match(/^(?:please )?(?:order|purchase|buy) (?:that|this|the) (.+?)(?: for me)?(?: now| online)?$/) ?? t.match(/^(?:please )?(?:order|purchase) (?:me )?(?:a |an |some )?(.+?)(?: online| for me)?$/);
    if (m && !GROCERY_WORDS.test(m[1])) return { kind: 'purchase', raw: o, item: m[1] };
    return undefined;
  },

  // Bookings
  (t, o) => {
    const m = t.match(/^(?:can you |could you |please )?(?:i need to |i have to |i should |i want to |i'?d like to )?book (?:me )?(?:in )?(?:a |an |my |the )?(.+)$/);
    if (m && !/^(?:it|that|this)$/.test(m[1]) && !/\b(zoom|call|meeting)\b/.test(m[1])) {
      const when = w(m[1], { now: new Date(0), timeZone: 'UTC' });
      const service = when.rest.replace(/\b(for me|appointment|in)\b/g, '').replace(/\s+/g, ' ').trim();
      return { kind: 'booking', raw: o, service: service || m[1], when };
    }
    return undefined;
  },

  // Activities: "I'm going for a run later"
  (t, o) => {
    const m = t.match(new RegExp(`^(?:i'?m|i am|i'?ll be|we'?re|i'?m gonna|i'?m going to) (?:going|heading|off|gonna go|go)? ?(?:for|to|out for|out to)? ?(?:a |an |the |my )?(?:usual )?${ACTIVITIES.source}\\b(.*)$`));
    if (m) {
      const when = w(m[2] ?? '', { now: new Date(0), timeZone: 'UTC' });
      return { kind: 'activity', raw: o, activity: m[1] === 'work out' ? 'workout' : m[1], when };
    }
    return undefined;
  },

  // Communication
  (t, o) => {
    const later = /^(?:i |we )?(?:need to|have to|must|should|gotta|got to|want to|ought to|'ve got to|have got to|need to remember to)\b|\blater\b|\btonight\b|\btomorrow\b/.test(t);
    const s = t.replace(/^(?:remind me to |i |we )?(?:(?:still )?(?:need to|have to|must|should|gotta|got to|want to|ought to|'ve got to|have got to|need to remember to|can you|could you|please|just) )+/, '');
    let m = s.match(new RegExp(`^(?:reply|respond|write back|get back|answer) (?:to )?${PERSON_WORD}(?:'s (?:email|message|text))?(?:(?: and| to)? (?:tell|say|let) (?:her|him|them|${PERSON_WORD})(?: know)?(?: that)? (.+))?$`));
    if (m) {
      const person = cleanPerson(m[1]);
      return { kind: 'communicate', raw: o, personName: person, body: m[3] ? toSecondPerson(m[3]) : undefined, later: later && !m[3], when: w(t, { now: new Date(0), timeZone: 'UTC' }), verb: 'reply' };
    }
    m = s.match(new RegExp(`^(email|e-mail|message|text|whatsapp|whats app|imessage|msg|ping|dm|write to|drop) (?:a (?:line|note|message) to )?(?:my )?${PERSON_WORD}(?:(?: and)?(?: (?:tell|say|ask|let) (?:her|him|them)(?: know)?)?(?: that| to say| saying|:|,)? (.+))?$`));
    if (m && !/^(me|it|that|this|back)$/.test(m[2])) {
      const person = cleanPerson(m[2]);
      const channel = channelFor(m[1]);
      const whenP = w(t, { now: new Date(0), timeZone: 'UTC' });
      let body: string | undefined = m[3];
      if (body && whenP.found && /^(?:later|tonight|tomorrow|today)$/.test(body.trim())) body = undefined;
      return { kind: 'communicate', raw: o, personName: person, channel, body: body ? toSecondPerson(body) : undefined, later: later && !body, when: whenP, verb: m[1] };
    }
    m = s.match(new RegExp(`^(?:tell|let|ask) ([a-z][a-z'\\-]*)(?: know)?(?: that| to|,)? (.+)$`));
    if (m && !/^(me|you|it|that|this|them|him|her)$/.test(m[1]) && !/^(ask)/.test(t) || (m && /^(him|her|them)$/.test(m[1]))) {
      return { kind: 'communicate', raw: o, personName: m![1], body: toSecondPerson(m![2]), later: false, when: w(t, { now: new Date(0), timeZone: 'UTC' }), verb: 'tell' };
    }
    return undefined;
  },

  // Calls
  (t, o) => {
    const s = t.replace(/^(?:remind me to |i |we )?(?:(?:still )?(?:need to|have to|must|should|gotta|got to|want to|ought to|'ve got to|need to remember to|don'?t forget to|remember to) )+/, '');
    const m = s.match(/^(?:call|ring|phone|give (.+?) a (?:call|ring)|call back|ring back) ?(.*)$/);
    if (m && s !== t || (m && /^(call|ring|phone)\b/.test(t))) {
      const target = (m![1] ?? m![2] ?? '').trim();
      const when = w(target, { now: new Date(0), timeZone: 'UTC' });
      const who = when.rest.replace(/\b(back|about .+|re .+|to .+)$/, '').trim();
      const text = `Call ${who.replace(/^(?:my )/, 'your ')}`.trim();
      return { kind: 'reminder', raw: o, text: `${text}${/\babout\b/.test(target) ? ' ' + target.slice(target.indexOf('about')) : ''}`, when, reminderKind: 'call', personName: who };
    }
    return undefined;
  },

  // Explicit reminders / remember
  (t, o) => {
    const m =
      t.match(/^(?:can you |could you |please )?remind me (?:to |about |that |of )?(.+)$/) ??
      t.match(/^(?:i |we )?(?:need|have|got|must|should|gotta|want) (?:to )?remember (?:to |that |about )?(.+)$/) ??
      t.match(/^(?:don'?t|do not) (?:let me )?forget (?:to |about )?(.+)$/) ??
      t.match(/^(?:note to self|reminder)[:,]? (.+)$/) ??
      t.match(/^remember (?:to )(.+)$/);
    if (!m) return undefined;
    const content = m[1];
    // Shopping inside a reminder: "remember to buy eye patches"
    const buy = content.match(/^(?:buy|get|pick up|grab) (?:some |more )?(.+)$/);
    if (buy) {
      const when = w(buy[1], { now: new Date(0), timeZone: 'UTC' });
      if (!when.found || GROCERY_WORDS.test(buy[1])) {
        const items = parseItems(when.rest || buy[1]);
        if (items.length && items.every((i) => i.name.split(' ').length <= 4)) return { kind: 'shopping_add', raw: o, items };
      }
    }
    const when = w(content, { now: new Date(0), timeZone: 'UTC' });
    // "I need to remember yoga tomorrow" — refers to something that may already exist.
    const bareNoun = !/^(?:to |that )?(?:call|ring|phone|email|text|message|reply|send|pay|book|buy|get|pick|take|bring|do|make|check|renew|write|finish|clean|cancel|order|fix|put|go|water|feed|pack|print|sign|return|drop|collect|tell|ask|update|submit|look|find|charge|walk)\b/.test(content);
    if (bareNoun && when.found && when.rest.split(' ').length <= 4) {
      return { kind: 'recall', raw: o, phrase: content, when, forgot: false };
    }
    const comms = content.match(new RegExp(`^(?:reply|respond|get back|write back|message|text|email|whatsapp) (?:to )?${PERSON_WORD}`));
    return {
      kind: 'reminder',
      raw: o,
      text: capitalizeFirst(when.rest || content),
      when,
      reminderKind: comms ? 'message' : 'task',
      personName: comms ? cleanPerson(comms[1]) : undefined,
    };
  },

  // "I forgot about yoga tomorrow"
  (t, o) => {
    const m = t.match(/^(?:oh,? )?(?:i )?(?:totally |completely )?(?:forgot|forget|nearly forgot|almost forgot)(?: about| that| i have| i had)? (.+)$/);
    if (m) return { kind: 'recall', raw: o, phrase: m[1], when: w(m[1], { now: new Date(0), timeZone: 'UTC' }), forgot: true };
    return undefined;
  },

  // Calendar additions
  (t, o) => {
    const explicit = t.match(/^(?:add|put|schedule|pencil in|book in|stick|pop|block out|block off|block) (.+?) (?:in|on|to|into) (?:my |the )?(?:calendar|diary|schedule|agenda)(.*)$/);
    if (explicit) {
      const text = `${explicit[1]} ${explicit[2]}`;
      const when = w(text, { now: new Date(0), timeZone: 'UTC' });
      return { kind: 'event_add', raw: o, title: keepCase(tidyTitle(when.rest), o), when, explicitCalendar: true };
    }
    const have = t.match(/^(?:i(?:'ve| have)?|we(?:'ve| have)?) (?:got |have )?(?:a |an |my |the |our )?(.+)$/);
    const body = have ? have[1] : t;
    const when = w(body, { now: new Date(0), timeZone: 'UTC' });
    const looksLikeEvent =
      (when.date || when.weekday !== undefined) && when.time && !/^(?:need|to|should|must|want|forgot|can)\b/.test(body) && when.rest.split(' ').length <= 6 && when.rest.length > 1;
    if (looksLikeEvent && !/^(?:buy|get|pick up|call|email|message|text|reply|tell)\b/.test(when.rest)) {
      const title = when.rest.replace(/^(?:add|put|schedule|pencil in|book in|plan|set up|create|make)\s+(?:an? )?(?:(?:event|appointment) (?:for |called )?)?/, '').replace(/^(?:got|have|a|an|my|the)\s+/, '');
      return { kind: 'event_add', raw: o, title: keepCase(tidyTitle(title), o), when, explicitCalendar: false };
    }
    return undefined;
  },

  // Shopping additions
  (t, o) => {
    let m = t.match(/^(?:please )?add (.+?)(?: to (?:my |the |our )?(?:shopping|grocery|groceries)? ?list)?$/);
    if (m) {
      const when = w(m[1], { now: new Date(0), timeZone: 'UTC' });
      if (!when.time) {
        const items = parseItems(m[1]);
        if (items.length) return { kind: 'shopping_add', raw: o, items };
      }
    }
    m = t.match(/^(?:i |we |i'm |we're |i've |we've )?(?:(?:still |also |really )?(?:need|want|gotta|have|got|must|should)(?: to)? (?:buy|get|pick up|grab|order|restock)(?: some| more)?|(?:still |also |really )?(?:need|want)(?: some| more)?|(?:are |am |have |'ve )?(?:run |running )?(?:out of|low on)|ran out of|run out of|running (?:out of|low on)) (.+)$/);
    if (m) {
      const obj = m[1];
      const when = w(obj, { now: new Date(0), timeZone: 'UTC' });
      const isNeedOnly = /^(?:i |we )?(?:need|want) /.test(t) && !/(?:buy|get|pick up|grab|order)/.test(t);
      // "I need to …" verbs are tasks, not shopping; "I need milk" is shopping.
      if (isNeedOnly && /^(?:to|a (?:haircut|break|holiday|rest|nap|lift|ride|hand)|help|you|someone|more time|sleep|a new job|to)\b/.test(obj)) return undefined;
      if (isNeedOnly && when.found && !GROCERY_WORDS.test(obj)) return undefined;
      const items = parseItems(when.rest || obj);
      if (!items.length) return undefined;
      if (items.some((i) => i.name.split(' ').length > 5)) return undefined;
      // "get the car serviced", "get a haircut", "get my passport renewed" are tasks, not shopping.
      const getVerb = /\b(?:need|have|got|must|should|gotta|want)(?: to)? get\b/.test(t) && !/\b(?:buy|pick up|grab|order)\b/.test(t);
      if (getVerb && !GROCERY_WORDS.test(obj) && (TASKY_OBJECT.test(obj) || items.some((i) => i.name.split(' ').length > 3))) return undefined;
      const generic = items.length === 1 && /^(groceries|grocery|food|shopping|food shopping|the shopping|some shopping|stuff for dinner)$/.test(items[0].name);
      return { kind: 'shopping_add', raw: o, items, generic };
    }
    m = t.match(/^(?:buy|pick up|grab|get) (?:some |more )?(.+)$/);
    if (m) {
      const items = parseItems(m[1]);
      if (items.length && items.every((i) => i.name.split(' ').length <= 4) && !/^(?:back|ready|done|to|in touch|going)\b/.test(m[1])) return { kind: 'shopping_add', raw: o, items };
    }
    if (/^(?:groceries|shopping|food shopping)$/.test(t)) return { kind: 'shopping_add', raw: o, items: [{ name: 'groceries' }], generic: true };
    return undefined;
  },

  // Generic "I need to X" / "I should X" → reminder
  (t, o) => {
    const m = t.match(/^(?:i |we )?(?:still |also |really )?(?:need to|have to|must|should|gotta|got to|want to|ought to|'ve got to|have got to|'ll have to|need to go|have to go) (.+)$/);
    if (m) {
      const when = w(m[1], { now: new Date(0), timeZone: 'UTC' });
      return { kind: 'reminder', raw: o, text: capitalizeFirst(when.rest || m[1]), when, reminderKind: 'task' };
    }
    return undefined;
  },

  // Notes & ideas
  (t, o) => {
    const m = o.match(/^(?:idea|note|thought|random thought|quick note|jot (?:this )?down|write (?:this )?down)[:,-]?\s+(.+)$/i) ?? o.match(/^(?:i (?:just )?had an idea|what if|maybe (?:we|i) (?:could|should))[:,]?\s*(.+)$/i);
    if (m) return { kind: 'note', raw: o, text: capitalizeFirst(m[1].trim()), idea: /idea|what if|maybe/i.test(o.slice(0, 20)) };
    const r = o.match(/^remember (?:that )(.+)$/i);
    if (r) return { kind: 'remember_fact', raw: o, subject: 'fact', value: r[1], memoryKind: 'fact' };
    return undefined;
  },

  // Preferences & services: "my dentist is Dr Patel", "I prefer mornings"
  (t, o) => {
    const m = o.match(/^my (?:usual )?([A-Za-z ]{2,30}?) (?:is|are) (.+?)[.]?$/i);
    if (m && !/\b(name|email|number)\b/i.test(m[1])) {
      const subject = m[1].toLowerCase();
      const service = /(dentist|doctor|gp|physio|hairdresser|barber|mechanic|vet|massage|therapist|accountant|gym|trainer|plumber|cleaner|nail)/.test(subject);
      return { kind: 'remember_fact', raw: o, subject, value: m[2], memoryKind: service ? 'service' : 'preference' };
    }
    const p = t.match(/^i (?:prefer|like|love|hate|usually|always|never|tend to) (.+)$/);
    if (p) return { kind: 'remember_fact', raw: o, subject: 'preference', value: o.replace(/^i /i, 'You ').replace(/[.]$/, ''), memoryKind: 'preference' };
    return undefined;
  },
];

function capitalizeFirst(s: string): string {
  const x = s.trim().replace(/[.]+$/, '');
  return x ? x[0].toUpperCase() + x.slice(1) : x;
}

/** Matching works on lower case; put back the capitals the person used ("Sarah", "Taylor Swift", "NHS"). */
export function keepCase(s: string, original: string): string {
  const words = original.split(/\s+/).slice(1); // the first word is only capitalised because it starts the sentence
  const cased = new Map<string, string>();
  for (const w of words) {
    const clean = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9']+$/g, '');
    if (/[A-Z]/.test(clean)) cased.set(clean.toLowerCase(), clean);
  }
  return s.replace(/[A-Za-z0-9']+/g, (w) => cased.get(w.toLowerCase()) ?? w);
}

function tidyTitle(s: string): string {
  const x = s
    .replace(/^(?:a|an|the|my|our)\s+/, '')
    .replace(/\s+(?:appointment|booking)$/, (m) => m)
    .replace(/\s+(?:on|at|for|in)$/, '')
    .trim();
  return capitalizeFirst(x);
}

export function classify(clause: string, ctx: InterpretOptions): Thought {
  const o = clause.trim().replace(/[.!]+$/, '').replace(/^[,\s]+/, '');
  const stripped = stripFillers(o);
  const t = lower(stripped).replace(/[?]+$/, (m) => m).replace(/[.!]+$/, '');
  const tq = t.replace(/\?+$/, '');
  if (!tq || /^(?:um+|uh+|er+m*|hmm+|ok(?:ay)?|right|so|and|oh|ah+|damn|ugh|oops|yeah so|well|like|hello|hi|hey|oh no|oh god|argh)$/.test(tq)) {
    if (/^(?:ok(?:ay)?|right)$/.test(tq)) return { kind: 'yes', raw: o };
    return { kind: 'filler', raw: o };
  }
  for (const m of MATCHERS) {
    const r = m(tq, stripped.replace(/[.!?]+$/, ''), ctx);
    if (r) return fixWhen(r, ctx);
  }
  if (isYes(tq) && tq.split(' ').length <= 4) return { kind: 'yes', raw: o };
  if (isNo(tq) && tq.split(' ').length <= 4) return { kind: 'no', raw: o };
  return { kind: 'note', raw: o, text: capitalizeFirst(stripped), idea: false };
}

/** Matchers parse with a dummy clock (to be pure); re-parse temporal info with the real clock. */
function fixWhen(th: Thought, ctx: InterpretOptions): Thought {
  if ('when' in th && th.when) {
    const source = th.when.matched.join(' ');
    const reparsed = parseWhen(source, ctx.now, ctx.timeZone, { answerMode: th.kind === 'modify' });
    return { ...th, when: { ...reparsed, rest: th.when.rest } } as Thought;
  }
  return th;
}

export function interpret(text: string, opts: InterpretOptions): Interpretation {
  const { text: body, addressed } = stripWakeName(text, opts.assistantName, opts.nameAliases);
  const clauses = segment(body);
  const thoughts: Thought[] = [];
  for (const c of clauses) {
    // A leading yes/no followed by more: "Yes, and add eggs" / "No, I need milk"
    const lead = c.match(/^(yes|yeah|yep|sure|no|nope|nah)[,.!]+\s+(.+)$/i);
    if (lead && !isEnding(lead[2])) {
      thoughts.push({ kind: /^(no|nope|nah)$/i.test(lead[1]) ? 'no' : 'yes', raw: lead[1] });
      for (const sub of segment(lead[2])) thoughts.push(classify(sub, opts));
      continue;
    }
    thoughts.push(classify(c, opts));
  }
  return { thoughts: thoughts.filter((t) => t.kind !== 'filler'), addressedByName: addressed, text: body };
}

export { pronounOrName };
