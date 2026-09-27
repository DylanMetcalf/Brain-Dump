// Timezone-aware date/time utilities and natural-language time parsing.
// All instants are stored in UTC; wall-clock maths is done in the relevant IANA zone
// via Intl so DST transitions are handled correctly without external libraries.

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

export interface ZonedParts extends WallTime {
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBR: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

export const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  a: 1, an: 1, couple: 2, few: 3, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fortyfive: 45, 'twenty-five': 25, twentyfive: 25,
};

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(date: Date, tz: string): ZonedParts {
  const parts = partsFormatter(tz).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const wd = get('weekday').toLowerCase().slice(0, 3);
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAY_ABBR[wd] ?? 0,
  };
}

/** Offset (ms) of tz from UTC at the given instant. */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, date.getUTCSeconds(), date.getUTCMilliseconds());
  return asUtc - date.getTime();
}

/** Convert a wall-clock time in tz to a UTC Date (DST-aware). */
export function zonedToUtc(w: WallTime, tz: string): Date {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  let offset = tzOffsetMs(new Date(guess), tz);
  let result = new Date(guess - offset);
  const offset2 = tzOffsetMs(result, tz);
  if (offset2 !== offset) {
    result = new Date(guess - offset2);
  }
  return result;
}

/** Add whole calendar days to a wall date (no tz involvement). */
export function addDays(w: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function weekdayOf(w: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
}

export function dateKey(w: { year: number; month: number; day: number }): string {
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

export function localDateKey(date: Date, tz: string): string {
  return dateKey(zonedParts(date, tz));
}

export function startOfLocalDay(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  return zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, tz);
}

export function sameLocalDay(a: Date, b: Date, tz: string): boolean {
  return localDateKey(a, tz) === localDateKey(b, tz);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatClock(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  if (p.hour === 12 && p.minute === 0) return 'noon';
  if (p.hour === 0 && p.minute === 0) return 'midnight';
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? 'AM' : 'PM';
  return p.minute === 0 ? `${h12} ${ampm}` : `${h12}:${String(p.minute).padStart(2, '0')} ${ampm}`;
}

/** Short clock for option labels: "2", "9:30" — used in "Tuesday at 2 or Thursday at 9?" */
export function formatClockShort(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return p.minute === 0 ? `${h12}` : `${h12}:${String(p.minute).padStart(2, '0')}`;
}

export function weekdayName(n: number): string {
  const s = WEEKDAYS[((n % 7) + 7) % 7];
  return s[0].toUpperCase() + s.slice(1);
}

export function monthName(n: number): string {
  const s = MONTHS[n - 1];
  return s[0].toUpperCase() + s.slice(1);
}

/** "today", "tomorrow", "Tuesday", "Tuesday 14 October". */
export function formatDay(date: Date, tz: string, now: Date): string {
  const d = zonedParts(date, tz);
  const n = zonedParts(now, tz);
  const diff = Math.round(
    (Date.UTC(d.year, d.month - 1, d.day) - Date.UTC(n.year, n.month - 1, n.day)) / 86400000,
  );
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 1 && diff < 7) return weekdayName(d.weekday);
  return `${weekdayName(d.weekday)} ${d.day} ${monthName(d.month)}`;
}

/** "tomorrow at 2 PM", "Tuesday at 9:30 AM" */
export function formatWhen(date: Date, tz: string, now: Date, allDay = false): string {
  const day = formatDay(date, tz, now);
  if (allDay) return day;
  const clock = formatClock(date, tz);
  return `${day} at ${clock}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'tonight' | 'later' | 'lunchtime';

export interface ParsedWhen {
  /** Specific local date resolved. */
  date?: { year: number; month: number; day: number };
  /** Weekday that was spoken (useful for matching). */
  weekday?: number;
  time?: { hour: number; minute: number; ambiguous: boolean; hour12?: number };
  part?: DayPart;
  /** Relative offset from now, e.g. "in 2 hours". */
  relativeMs?: number;
  /** Span phrases like "next week". */
  span?: { from: { year: number; month: number; day: number }; to: { year: number; month: number; day: number }; label: string };
  /** Relative shifts for modifications: "an hour later", "earlier". */
  shiftMs?: number;
  /** The text with time expressions removed. */
  rest: string;
  /** Whether anything was found. */
  found: boolean;
  /** Matched fragments (lowercase). */
  matched: string[];
  /** Explicit timezone reference: "your time", "Rick's time", "London time". */
  zoneHint?: { kind: 'mine' | 'theirs' | 'named'; who?: string; tz?: string };
}

const WORD_NUM = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';

function wordToNum(s: string): number | undefined {
  if (/^\d+$/.test(s)) return Number(s);
  return NUMBER_WORDS[s];
}

/** Turn 1–12 into a 24h hour using common-sense defaults. */
export function defaultHour(h: number, part?: DayPart): { hour: number; ambiguous: boolean } {
  if (h >= 13) return { hour: h % 24, ambiguous: false };
  if (part === 'morning') return { hour: h === 12 ? 0 : h, ambiguous: false };
  if (part === 'afternoon' || part === 'evening' || part === 'tonight') {
    return { hour: h === 12 ? 12 : h + 12, ambiguous: false };
  }
  if (h === 12) return { hour: 12, ambiguous: true };
  // People rarely mean 1–6 AM; 7–11 usually morning.
  if (h >= 1 && h <= 6) return { hour: h + 12, ambiguous: true };
  return { hour: h, ambiguous: true };
}

export const CITY_TIMEZONES: Record<string, string> = {
  london: 'Europe/London', manchester: 'Europe/London', edinburgh: 'Europe/London', dublin: 'Europe/Dublin',
  paris: 'Europe/Paris', berlin: 'Europe/Berlin', madrid: 'Europe/Madrid', rome: 'Europe/Rome', amsterdam: 'Europe/Amsterdam',
  lisbon: 'Europe/Lisbon', stockholm: 'Europe/Stockholm', zurich: 'Europe/Zurich', athens: 'Europe/Athens', warsaw: 'Europe/Warsaw',
  'new york': 'America/New_York', nyc: 'America/New_York', boston: 'America/New_York', miami: 'America/New_York', toronto: 'America/Toronto',
  chicago: 'America/Chicago', austin: 'America/Chicago', dallas: 'America/Chicago', denver: 'America/Denver',
  'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', seattle: 'America/Los_Angeles',
  vancouver: 'America/Vancouver', 'mexico city': 'America/Mexico_City', 'sao paulo': 'America/Sao_Paulo',
  tokyo: 'Asia/Tokyo', singapore: 'Asia/Singapore', 'hong kong': 'Asia/Hong_Kong', dubai: 'Asia/Dubai', mumbai: 'Asia/Kolkata',
  delhi: 'Asia/Kolkata', bangalore: 'Asia/Kolkata', shanghai: 'Asia/Shanghai', beijing: 'Asia/Shanghai', seoul: 'Asia/Seoul',
  sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', brisbane: 'Australia/Brisbane', perth: 'Australia/Perth',
  auckland: 'Pacific/Auckland', 'cape town': 'Africa/Johannesburg', johannesburg: 'Africa/Johannesburg', nairobi: 'Africa/Nairobi',
  lagos: 'Africa/Lagos', cairo: 'Africa/Cairo',
};

export function cityToTimeZone(city: string): string | undefined {
  const c = city.toLowerCase().replace(/[.!?]/g, '').trim();
  if (CITY_TIMEZONES[c]) return CITY_TIMEZONES[c];
  for (const [k, v] of Object.entries(CITY_TIMEZONES)) {
    if (c.includes(k) && k.length > 2) return v;
  }
  return undefined;
}

interface Rule {
  re: RegExp;
  apply: (m: RegExpMatchArray, ctx: ParseCtx) => void;
}

interface ParseCtx {
  now: Date;
  tz: string;
  today: ZonedParts;
  out: ParsedWhen;
  answerMode: boolean;
}

function setTime(ctx: ParseCtx, h: number, minute: number, explicitMeridiem?: string) {
  let hour = h;
  let ambiguous = false;
  if (explicitMeridiem) {
    const pm = /p/.test(explicitMeridiem);
    hour = h % 12 + (pm ? 12 : 0);
  } else {
    const d = defaultHour(h, ctx.out.part);
    hour = d.hour;
    ambiguous = d.ambiguous;
  }
  ctx.out.time = { hour, minute, ambiguous, hour12: h <= 12 ? h : undefined };
}

function upcomingWeekday(today: ZonedParts, wd: number, includeToday: boolean) {
  let delta = (wd - today.weekday + 7) % 7;
  if (delta === 0 && !includeToday) delta = 7;
  return addDays(today, delta);
}

/** "next Wednesday" = the Wednesday in next calendar week (weeks start Monday). */
function nextWeekWeekday(today: ZonedParts, wd: number) {
  const mondayOffset = (today.weekday + 6) % 7; // days since Monday
  const nextMonday = addDays(today, 7 - mondayOffset);
  const idx = (wd + 6) % 7; // Monday-based index
  return addDays(nextMonday, idx);
}

const RULES: Rule[] = [
  // Explicit zone hints
  {
    re: /\b(my|your) time\b/,
    apply: (m, c) => {
      c.out.zoneHint = { kind: m[1] === 'my' ? 'mine' : 'mine' };
    },
  },
  {
    re: /\b([a-z]+)'s time\b/,
    apply: (m, c) => {
      c.out.zoneHint = { kind: 'theirs', who: m[1] };
    },
  },
  {
    re: /\b(his|her|their) time\b/,
    apply: (_m, c) => {
      c.out.zoneHint = { kind: 'theirs' };
    },
  },
  {
    re: /\b([a-z]+(?: [a-z]+)?) time\b/,
    apply: (m, c) => {
      const tz = cityToTimeZone(m[1]);
      if (tz) c.out.zoneHint = { kind: 'named', tz };
    },
  },
  // Relative offsets
  {
    re: /\bin (an?|one|two|three|four|five|six|ten|fifteen|twenty|thirty|forty-five|\d+|a couple of|a few) (minutes?|mins?|hours?|hrs?|days?|weeks?)\b/,
    apply: (m, c) => {
      const q = m[1].replace('a couple of', 'couple').replace('a few', 'few');
      const n = wordToNum(q) ?? 1;
      const unit = m[2];
      const ms = /^m/.test(unit) ? 60000 : /^h/.test(unit) ? 3600000 : /^d/.test(unit) ? 86400000 : 7 * 86400000;
      c.out.relativeMs = n * ms;
    },
  },
  {
    re: /\bin half an hour\b/,
    apply: (_m, c) => {
      c.out.relativeMs = 30 * 60000;
    },
  },
  // Shifts (for modification)
  {
    re: /\b(?:by )?(an?|one|two|three|\d+|half an?|a couple of) (hours?|minutes?|mins?|days?|weeks?) (later|earlier|back|forward|sooner)\b/,
    apply: (m, c) => {
      const q = m[1];
      let n = q.startsWith('half') ? 0.5 : q === 'a couple of' ? 2 : wordToNum(q) ?? 1;
      const unit = m[2];
      const ms = /^m/.test(unit) ? 60000 : /^h/.test(unit) ? 3600000 : /^d/.test(unit) ? 86400000 : 7 * 86400000;
      const dir = /later|back/.test(m[3]) ? 1 : -1;
      c.out.shiftMs = dir * n * ms;
    },
  },
  {
    re: /\b(?:push|move|put|bump) (?:it |that |this )?(back|forward)(?: (?:by )?(an?|one|two|three|\d+|half an?) (hours?|minutes?|mins?|days?))?/,
    apply: (m, c) => {
      if (c.out.shiftMs !== undefined) return;
      const dir = m[1] === 'back' ? 1 : -1;
      let ms = 3600000;
      if (m[2]) {
        const n = m[2].startsWith('half') ? 0.5 : wordToNum(m[2]) ?? 1;
        const unit = m[3];
        ms = n * (/^m/.test(unit) ? 60000 : /^h/.test(unit) ? 3600000 : 86400000);
      }
      c.out.shiftMs = dir * ms;
    },
  },
  {
    re: /\b(?:a (?:bit|little) )?(earlier|later)\b(?! today)/,
    apply: (m, c) => {
      if (c.out.shiftMs !== undefined) return;
      const small = /bit|little/.test(m[0]);
      if (m[1] === 'later' && !/\b(make|move|push|bump|shift|change)\b/.test(c.out.rest)) {
        // "later" on its own is a day-part, e.g. "remind me later"
        c.out.part = c.out.part ?? 'later';
        return;
      }
      c.out.shiftMs = (m[1] === 'earlier' ? -1 : 1) * (small ? 30 : 60) * 60000;
    },
  },
  // Spans
  {
    re: /\bnext week\b/,
    apply: (_m, c) => {
      const mondayOffset = (c.today.weekday + 6) % 7;
      const from = addDays(c.today, 7 - mondayOffset);
      c.out.span = { from, to: addDays(from, 6), label: 'next week' };
    },
  },
  {
    re: /\bthis week\b/,
    apply: (_m, c) => {
      const mondayOffset = (c.today.weekday + 6) % 7;
      const weekEnd = addDays(addDays(c.today, -mondayOffset), 6);
      // On a Sunday, "this week" means the week ahead.
      const to = mondayOffset >= 5 ? addDays(c.today, 7) : weekEnd;
      c.out.span = { from: c.today, to, label: 'this week' };
    },
  },
  {
    re: /\b(?:this |the )?weekend\b/,
    apply: (_m, c) => {
      const sat = upcomingWeekday(c.today, 6, true);
      c.out.span = { from: sat, to: addDays(sat, 1), label: 'the weekend' };
    },
  },
  // Dates
  {
    re: /\b(?:the )?day after tomorrow\b/,
    apply: (_m, c) => {
      c.out.date = addDays(c.today, 2);
    },
  },
  {
    re: /\btonight\b/,
    apply: (_m, c) => {
      c.out.date = { year: c.today.year, month: c.today.month, day: c.today.day };
      c.out.part = 'tonight';
    },
  },
  {
    re: /\b(tomorrow|tmrw|tmr)\b/,
    apply: (_m, c) => {
      c.out.date = addDays(c.today, 1);
    },
  },
  {
    re: /\btoday\b/,
    apply: (_m, c) => {
      c.out.date = { year: c.today.year, month: c.today.month, day: c.today.day };
    },
  },
  {
    re: /\byesterday\b/,
    apply: (_m, c) => {
      c.out.date = addDays(c.today, -1);
    },
  },
  {
    re: /\b(?:on )?(next|this|coming|this coming)? ?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|weds|thurs|thur|thu|fri|sat)s?\b(?!\w)/,
    apply: (m, c) => {
      const key = m[2];
      const wd = WEEKDAYS.indexOf(key) >= 0 ? WEEKDAYS.indexOf(key) : WEEKDAY_ABBR[key];
      if (wd === undefined) return;
      c.out.weekday = wd;
      if (m[1] === 'next') c.out.date = nextWeekWeekday(c.today, wd);
      else c.out.date = upcomingWeekday(c.today, wd, true);
    },
  },
  {
    re: new RegExp(`\\b(?:on )?(?:the )?(\\d{1,2})(?:st|nd|rd|th)?(?: of)? (${MONTHS.join('|')}|${Object.keys(MONTH_ABBR).join('|')})\\b`),
    apply: (m, c) => {
      const month = MONTHS.indexOf(m[2]) + 1 || MONTH_ABBR[m[2]];
      setDateMD(c, month, Number(m[1]));
    },
  },
  {
    re: new RegExp(`\\b(${MONTHS.join('|')}|${Object.keys(MONTH_ABBR).join('|')}) (\\d{1,2})(?:st|nd|rd|th)?\\b`),
    apply: (m, c) => {
      if (c.out.date) return;
      const month = MONTHS.indexOf(m[1]) + 1 || MONTH_ABBR[m[1]];
      setDateMD(c, month, Number(m[2]));
    },
  },
  {
    re: /\b(?:on )?the (\d{1,2})(?:st|nd|rd|th)\b/,
    apply: (m, c) => {
      if (c.out.date) return;
      const day = Number(m[1]);
      let month = c.today.month;
      let year = c.today.year;
      if (day < c.today.day) {
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
      c.out.date = { year, month, day };
    },
  },
  // Day parts
  {
    re: /\b(?:in the |this |tomorrow )?(morning|afternoon|evening|lunchtime|lunch time|at lunch)\b/,
    apply: (m, c) => {
      const p = m[1].replace(' ', '').replace('atlunch', 'lunchtime') as DayPart;
      c.out.part = p === ('lunchtime' as DayPart) ? 'lunchtime' : p;
    },
  },
  {
    re: /\b(later on|later today|later)\b/,
    apply: (_m, c) => {
      if (c.out.shiftMs !== undefined) return;
      c.out.part = c.out.part ?? 'later';
    },
  },
  // Times
  { re: /\b(noon|midday)\b/, apply: (_m, c) => setTimeExact(c, 12, 0) },
  { re: /\bmidnight\b/, apply: (_m, c) => setTimeExact(c, 0, 0) },
  {
    re: new RegExp(`\\bhalf past (\\d{1,2}|${WORD_NUM})\\b`),
    apply: (m, c) => setTime(c, wordToNum(m[1])!, 30),
  },
  {
    re: new RegExp(`\\bquarter past (\\d{1,2}|${WORD_NUM})\\b`),
    apply: (m, c) => setTime(c, wordToNum(m[1])!, 15),
  },
  {
    re: new RegExp(`\\bquarter to (\\d{1,2}|${WORD_NUM})\\b`),
    apply: (m, c) => {
      const h = wordToNum(m[1])!;
      setTime(c, h === 1 ? 12 : h - 1, 45);
    },
  },
  {
    re: /\b(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?(?![\d])/,
    apply: (m, c) => {
      if (c.out.time) return;
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (h > 23 || min > 59) return;
      if (m[3]) setTime(c, h, min, m[3]);
      else if (h >= 13 || h === 0 || /^0/.test(m[1])) setTimeExact(c, h, min);
      else setTime(c, h, min);
    },
  },
  {
    re: new RegExp(`\\b(\\d{1,2}|${WORD_NUM})\\s*(a\\.?m\\.?|p\\.?m\\.?)(?=\\W|$)`),
    apply: (m, c) => {
      if (c.out.time) return;
      setTime(c, wordToNum(m[1])!, 0, m[2]);
    },
  },
  {
    re: new RegExp(`\\b(\\d{1,2}|${WORD_NUM}) ?o'?clock\\b`),
    apply: (m, c) => {
      if (c.out.time) return;
      setTime(c, wordToNum(m[1])!, 0);
    },
  },
  {
    re: new RegExp(`\\b(${WORD_NUM})[ -](thirty|fifteen|forty-five|forty five|oh five|o five)\\b`),
    apply: (m, c) => {
      if (c.out.time) return;
      const mins: Record<string, number> = { thirty: 30, fifteen: 15, 'forty-five': 45, 'forty five': 45, 'oh five': 5, 'o five': 5 };
      setTime(c, wordToNum(m[1])!, mins[m[2]] ?? 0);
    },
  },
  {
    re: new RegExp(`\\b(?:at|for|by|around|about|from|to|till|until|@) (\\d{1,2}|${WORD_NUM})\\b(?![:.]?\\d)(?! (?:people|of|minutes?|mins?|hours?|days?|weeks?|times|items|things))`),
    apply: (m, c) => {
      if (c.out.time) return;
      const h = wordToNum(m[1])!;
      if (h < 0 || h > 23) return;
      if (h >= 13) setTimeExact(c, h, 0);
      else setTime(c, h, 0);
    },
  },
];

function setTimeExact(c: ParseCtx, h: number, min: number) {
  c.out.time = { hour: h, minute: min, ambiguous: false };
}

function setDateMD(c: ParseCtx, month: number, day: number) {
  if (!month || day < 1 || day > 31) return;
  let year = c.today.year;
  if (month < c.today.month || (month === c.today.month && day < c.today.day)) year += 1;
  c.out.date = { year, month, day };
}

/**
 * Parse temporal expressions from free text.
 * answerMode: the text is an answer to "what time?" / "which day?", so bare numbers count ("Two.").
 */
export function parseWhen(text: string, now: Date, tz: string, opts: { answerMode?: boolean } = {}): ParsedWhen {
  const lower = ` ${text.toLowerCase().replace(/[’‘]/g, "'").replace(/[!?]/g, ' ').replace(/,/g, ', ').replace(/\s+/g, ' ').trim()} `;
  const out: ParsedWhen = { rest: lower, found: false, matched: [] };
  const ctx: ParseCtx = { now, tz, today: zonedParts(now, tz), out, answerMode: !!opts.answerMode };

  // Day-part first so "at 7 in the evening" resolves correctly.
  const ordered = [...RULES.filter((r) => /morning|afternoon|tonight|later on/.test(r.re.source)), ...RULES.filter((r) => !/morning|afternoon|tonight|later on/.test(r.re.source))];
  for (const rule of ordered) {
    const m = out.rest.match(rule.re);
    if (!m) continue;
    const before = JSON.stringify({ ...out, rest: '', matched: [] });
    rule.apply(m, ctx);
    const after = JSON.stringify({ ...out, rest: '', matched: [] });
    if (before !== after) {
      out.matched.push(m[0].trim());
      out.rest = out.rest.replace(m[0], ' ');
    }
  }

  if (ctx.answerMode && !out.time) {
    const bare = out.rest.trim().replace(/\.$/, '');
    const m = bare.match(new RegExp(`^(?:at |about |around |maybe )?(\\d{1,2}|${WORD_NUM})(?: ?ish)?(?: please)?$`));
    if (m) {
      const h = wordToNum(m[1])!;
      if (h >= 0 && h <= 23) {
        if (h >= 13) setTimeExact(ctx, h, 0);
        else setTime(ctx, h, 0);
        out.matched.push(m[0]);
        out.rest = ' ';
      }
    }
  }

  // Day-part refinement of an ambiguous hour: "2 in the afternoon".
  if (out.time && out.time.ambiguous && out.time.hour12 && out.part) {
    const d = defaultHour(out.time.hour12, out.part);
    out.time.hour = d.hour;
    out.time.ambiguous = d.ambiguous;
  }

  out.rest = out.rest
    .replace(/\b(on|at|for|by|in|this|next|around)\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  out.found = out.matched.length > 0;
  return out;
}

export const DAY_PART_HOURS: Record<DayPart, number> = {
  morning: 9,
  lunchtime: 12,
  afternoon: 14,
  evening: 18,
  tonight: 19,
  later: 18,
};

/**
 * Resolve a ParsedWhen to a concrete instant. Returns undefined when there is not enough
 * information (e.g. only a time with no date is fine = today/tomorrow; only nothing = undefined).
 */
export function resolveInstant(
  p: ParsedWhen,
  now: Date,
  tz: string,
  opts: { defaultHour?: number; preferFuture?: boolean } = {},
): Date | undefined {
  if (p.relativeMs !== undefined) return new Date(now.getTime() + p.relativeMs);
  const today = zonedParts(now, tz);
  let date = p.date;
  let hour: number | undefined = p.time?.hour;
  let minute = p.time?.minute ?? 0;

  if (hour === undefined && p.part) {
    hour = DAY_PART_HOURS[p.part];
    if (p.part === 'later' && !p.date) {
      // "later" = this evening, or a couple of hours from now if it's already evening.
      const h = today.hour;
      if (h >= 16) {
        const t = new Date(now.getTime() + 2 * 3600000);
        const tp = zonedParts(t, tz);
        return zonedToUtc({ year: tp.year, month: tp.month, day: tp.day, hour: tp.hour, minute: 0 }, tz);
      }
    }
  }
  if (!date && hour === undefined) {
    if (p.span) date = p.span.from;
    else return undefined;
  }
  if (!date) {
    date = { year: today.year, month: today.month, day: today.day };
    const candidate = zonedToUtc({ ...date, hour: hour!, minute }, tz);
    if (candidate.getTime() <= now.getTime() && opts.preferFuture !== false) {
      // If an ambiguous hour has already passed today but its PM/AM twin hasn't, use the twin.
      if (p.time?.ambiguous && hour! < 12) {
        const twin = zonedToUtc({ ...date, hour: hour! + 12, minute }, tz);
        if (twin.getTime() > now.getTime()) return twin;
      }
      date = addDays(date, 1);
    }
  }
  if (hour === undefined) hour = opts.defaultHour ?? 9;
  let out = zonedToUtc({ ...date, hour, minute }, tz);
  // "Thursday at 7am" said on Thursday at 8am means next Thursday.
  if (p.weekday !== undefined && out.getTime() < now.getTime() && opts.preferFuture !== false && p.date && dateKey(p.date) === dateKey(zonedParts(now, tz))) {
    out = zonedToUtc({ ...addDays(date, 7), hour, minute }, tz);
  }
  return out;
}

export function weekdayFromText(text: string): number | undefined {
  const m = text.toLowerCase().match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)\b/);
  if (!m) return undefined;
  const i = WEEKDAYS.indexOf(m[1]);
  return i >= 0 ? i : WEEKDAY_ABBR[m[1]];
}
