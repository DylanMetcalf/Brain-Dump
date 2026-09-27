import { describe, it, expect } from 'vitest';
import { setup, at } from './helpers.js';
import { interpret } from '../src/core/interpret.js';
import { NOW, TZ } from './helpers.js';

describe('regressions found by the simulation', () => {
  it('an ambiguous person never loses the follow-up', async () => {
    const h = setup();
    h.contact('Sarah Jones');
    h.contact('Sarah Lee');
    const r = await h.say('I should reply to Sarah');
    expect(r.question?.text).toMatch(/Which Sarah/);
    expect(h.state.reminders.some((x) => /reply to sarah/i.test(x.text))).toBe(true);
    await h.say('Lee');
    expect(h.state.reminders.filter((x) => /reply to sarah/i.test(x.text))).toHaveLength(1);
    expect(h.state.reminders[0].text).toBe('Reply to Sarah Lee');
  });
  it('two timed things joined by "and" become two events', async () => {
    const h = setup();
    await h.say('Pilates Saturday at 7pm and pilates Sunday at 7am');
    expect(h.state.events.filter((e) => /pilates/i.test(e.title))).toHaveLength(2);
  });
  it('"the morning one" picks by part of day', async () => {
    const h = setup();
    h.event('Pilates', at(10, 3, 19));
    const am = h.event('Pilates', at(10, 4, 7));
    await h.say('Cancel pilates');
    await h.say('the morning one');
    expect(h.state.events.find((e) => e.id === am.id)!.status).toBe('cancelled');
  });
  it('a weekday that already passed today means next week', async () => {
    const h = setup(); // Sunday 10:00
    await h.say('Brunch Sunday at 9');
    expect(h.state.events[0].start).toBe(at(10, 4, 9).toISOString());
  });
  it('fillers never become shopping items', async () => {
    const h = setup();
    await h.say('um so I need milk, eggs and bread, oh and bin bags');
    expect(h.state.shopping.map((s) => s.name).sort()).toEqual(['bin bags', 'bread', 'eggs', 'milk']);
  });
  it('two-word names in waiting states', async () => {
    const h = setup();
    const lee = h.contact('Sarah Lee');
    h.contact('Sarah Jones');
    await h.say('Sarah Lee is waiting for my answer about the flat');
    expect(h.state.waiting[0]).toMatchObject({ personId: lee, direction: 'me' });
    await h.say('I replied to Sarah Lee');
    expect(h.state.waiting[0].status).toBe('resolved');
  });
});

describe('hardening', () => {
  const nasty = [
    '', ' ', '...', '???', 'a'.repeat(5000), '<script>alert(1)</script>', "'; DROP TABLE users; --", '🙂🙂🙂', 'and and and and',
    'cancel', 'move it', 'make that', 'undo undo undo', 'at at at 99:99', 'remind me to', 'tell', 'book', 'buy', '31st of February at 25',
    'I can\'t make it and it and it', 'yes no yes no', 'That\'s all that\'s all', '\u0000\u0007', 'in -5 hours', 'on the 0th',
  ];
  it('never crashes on hostile or garbage input', async () => {
    const h = setup();
    h.event('Yoga', at(9, 29, 14));
    for (const t of nasty) {
      const r = await h.say(t);
      expect(typeof r.text).toBe('string');
      expect(r.text.length).toBeGreaterThan(0);
    }
    // Garbage never cancelled anything by accident.
    expect(h.state.events[0].status).toBe('confirmed');
  });
  it('fuzz: random word salad never throws and never takes consequential action', async () => {
    const words = 'I need can\'t make yoga cancel move it to Friday at 3 buy milk tell Sarah remind me later the that and oh undo yes no book zoom with Rick'.split(' ');
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 300; i++) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 10) }, () => words[Math.floor(rand() * words.length)]).join(' ');
      expect(() => interpret(text, { now: NOW, timeZone: TZ })).not.toThrow();
    }
    const h = setup();
    for (let i = 0; i < 80; i++) {
      const text = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => words[Math.floor(rand() * words.length)]).join(' ');
      await h.say(text);
    }
    expect(h.state.drafts.filter((d) => d.status === 'sent')).toHaveLength(0);
    expect(h.state.ledger.filter((l) => l.risk === 'high')).toHaveLength(0);
  });
  it('user text is never interpreted as markup by the server state', async () => {
    const h = setup();
    await h.say('Add <img src=x onerror=alert(1)>');
    // Stored verbatim as data; the client renders text nodes only.
    expect(JSON.stringify(h.state.shopping)).toContain('<img');
  });
});
