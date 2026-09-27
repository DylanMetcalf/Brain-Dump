// Text helpers: normalisation, fuzzy matching, phonetics, phrasing.

export function normalize(text: string): string {
  return text
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function lower(text: string): string {
  return normalize(text).toLowerCase();
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'our', 'your', 'that', 'this', 'these', 'those', 'it', 'to', 'for', 'of', 'on', 'at', 'in',
  'with', 'and', 'or', 'some', 'any', 'me', 'i', 'is', 'be', 'was', 'up', 'about', 'please', 'just', 'one', 'thing',
  'appointment', 'appointments', 'session', 'class', 'event', 'booking', 'anymore', 'any more', 'again', 'there', 'then',
  'usual', 'today', 'tomorrow', 'tonight', 'am', 'pm', 'time', 'o', 'clock', "o'clock", 'actually', 'also', 'oh', 'go', 'going',
]);

export function stem(word: string): string {
  let w = word.toLowerCase().replace(/[^a-z0-9']/g, '');
  w = w.replace(/'s$/, '');
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && /(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ied')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ed') && !w.endsWith('eed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1);
  return w;
}

const SYNONYMS: Record<string, string> = {
  dental: 'dentist', dentists: 'dentist', doc: 'doctor', gp: 'doctor', physio: 'physiotherapy', physiotherapist: 'physiotherapy',
  mtg: 'meeting', meet: 'meeting', 'catch-up': 'catchup', catchup: 'catchup', workout: 'gym', jog: 'run', running: 'run', ran: 'run',
  haircut: 'hair', hairdresser: 'hair', barber: 'hair', groceries: 'grocery', shop: 'grocery', vet: 'vet', veterinary: 'vet',
  zoom: 'call', call: 'call', massage: 'massage',
};

export function contentTokens(text: string): string[] {
  return lower(text)
    .replace(/[^a-z0-9' -]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => {
      const s = stem(t);
      return SYNONYMS[s] ?? SYNONYMS[t] ?? s;
    })
    .filter(Boolean);
}

/** 0..1 — how well `query` describes `title`. Query tokens all present = 1. */
export function matchScore(query: string, title: string): number {
  const q = contentTokens(query);
  const t = contentTokens(title);
  if (!q.length || !t.length) return 0;
  let hit = 0;
  for (const qt of q) {
    if (t.includes(qt)) hit += 1;
    else if (t.some((tt) => (tt.length > 3 && qt.length > 3 && (tt.startsWith(qt) || qt.startsWith(tt))) || levenshtein(tt, qt) <= (qt.length > 6 ? 2 : qt.length > 3 ? 1 : 0))) hit += 0.8;
  }
  return hit / q.length;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Classic Soundex, adequate for catching STT mishearings of a single chosen name. */
export function soundex(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  const codes: Record<string, string> = {
    b: '1', f: '1', p: '1', v: '1',
    c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
    d: '3', t: '3', l: '4', m: '5', n: '5', r: '6',
  };
  let out = w[0].toUpperCase();
  let last = codes[w[0]] ?? '';
  for (let i = 1; i < w.length && out.length < 4; i++) {
    const c = w[i];
    const code = codes[c] ?? '';
    if (code && code !== last) out += code;
    if (c !== 'h' && c !== 'w') last = code;
  }
  return out.padEnd(4, '0');
}

/**
 * Could `heard` be a mishearing of `name`? Deliberately conservative: used only in
 * wake-word position so ordinary words are not over-interpreted.
 */
export function soundsLike(heard: string, name: string, aliases: string[] = []): boolean {
  const h = heard.toLowerCase().replace(/[^a-z]/g, '');
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (!h || !n) return false;
  if (h === n) return true;
  if (aliases.map((a) => a.toLowerCase()).includes(h)) return true;
  if (soundex(h) === soundex(n) && Math.abs(h.length - n.length) <= 2 && h[0] === n[0]) return true;
  return n.length >= 4 && levenshtein(h, n) === 1;
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function listJoin(items: string[], conj = 'and'): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} ${conj} ${items[items.length - 1]}`;
}

export function plural(n: number, word: string, pluralWord?: string): string {
  return `${n === 1 ? 'one' : n} ${n === 1 ? word : pluralWord ?? word + 's'}`;
}

/** Strip leading articles/quantifiers from an item: "some milk" → "milk". */
export function cleanItem(s: string): { name: string; quantity?: number } {
  let t = lower(s).replace(/[.!?]+$/g, '').trim();
  let quantity: number | undefined;
  const q = t.match(/^(\d+|two|three|four|five|six|seven|eight|nine|ten|a dozen|dozen|a couple of|a pack of|a box of|a bottle of|a bag of|a loaf of|a pint of)\s+(.+)/);
  const nums: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, 'a dozen': 12, dozen: 12, 'a couple of': 2 };
  if (q) {
    if (/^\d+$/.test(q[1])) quantity = Number(q[1]);
    else if (nums[q[1]]) quantity = nums[q[1]];
    if (quantity !== undefined || /^a (pack|box|bottle|bag|loaf|pint) of/.test(q[1])) t = quantity !== undefined ? q[2] : t;
  }
  t = t.replace(/^(some|more|a few|a|an|the|new|fresh|extra)\s+/, '').replace(/\s+(too|as well|please)$/, '').trim();
  return { name: t, quantity };
}

export function sameItem(a: string, b: string): boolean {
  const x = contentTokens(a).join(' ');
  const y = contentTokens(b).join(' ');
  return !!x && x === y;
}

let counter = 0;
export type IdGen = (prefix: string) => string;
export const randomId: IdGen = (prefix) => {
  const g = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const r = g?.randomUUID ? g.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${r}`;
};
export function sequentialIds(): IdGen {
  const counts: Record<string, number> = {};
  return (prefix) => {
    counts[prefix] = (counts[prefix] ?? 0) + 1;
    counter++;
    return `${prefix}_${counts[prefix]}`;
  };
}
