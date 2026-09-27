import { describe, it, expect } from 'vitest';
import { interpret, segment, stripWakeName } from '../src/core/interpret.js';
import { zonedToUtc } from '../src/core/time.js';

const TZ = 'Europe/London';
const NOW = zonedToUtc({ year: 2026, month: 9, day: 27, hour: 10, minute: 0 }, TZ);
const kinds = (s: string) => interpret(s, { now: NOW, timeZone: TZ, assistantName: 'Milo' }).thoughts.map((t) => t.kind);
const first = (s: string) => interpret(s, { now: NOW, timeZone: TZ, assistantName: 'Milo' }).thoughts[0] as any;

describe('segmentation', () => {
  it('splits streams of thought', () => {
    expect(segment('I need groceries, I forgot about yoga tomorrow, I should reply to Sarah, and I need to call the dentist.')).toHaveLength(4);
    expect(segment('I need groceries, oh and I can\'t make yoga tomorrow, and remind me to message Sarah later.')).toHaveLength(3);
    expect(segment('I need to buy milk, eggs, bread and cheese')).toHaveLength(1);
    expect(segment('Reply to Sarah and tell her I\'ll send it tonight')).toHaveLength(1);
    expect(segment('Buy milk and call mum')).toHaveLength(2);
  });
});

describe('classification', () => {
  const cases: [string, string][] = [
    ['I need to buy eye patches.', 'shopping_add'],
    ['I got the milk', 'shopping_got'],
    ["I can't make yoga.", 'cancel'],
    ["Ah, I can't make that yoga appointment anymore.", 'cancel'],
    ["I can't make it.", 'cancel'],
    ["I'm not going to yoga tomorrow", 'cancel'],
    ['Cancel that.', 'cancel'],
    ['Take that appointment off my calendar', 'cancel'],
    ['Actually make that three.', 'modify'],
    ['Move it to Friday.', 'modify'],
    ['Change that to next week', 'modify'],
    ['Make it earlier', 'modify'],
    ['Put it back', 'undo'],
    ['I already did that', 'done'],
    ['Organise a Zoom with Rick.', 'meeting'],
    ["That's all.", 'end'],
    ['Okay, that should be good for now.', 'end'],
    ['Thanks, that\'s all', 'end'],
    ['What still needs me?', 'query'],
    ['What did you handle today?', 'query'],
    ['Can you make this easier?', 'friction'],
    ['I need milk', 'shopping_add'],
    ['Add eggs', 'shopping_add'],
    ["Don't worry about bread", 'shopping_remove'],
    ['Rick hasn\'t replied', 'waiting'],
    ['Has Rick replied?', 'query'],
    ['Remind me to message Sarah later', 'reminder'],
    ['Book me a massage next Wednesday afternoon', 'booking'],
    ["I'm going for a run later", 'activity'],
    ['I need to reply to Sarah', 'communicate'],
    ["Reply to Sarah and tell her I'll send it tonight", 'communicate'],
    ['Buy that laptop', 'purchase'],
    ['Clear those promotional emails', 'email_clear'],
    ['I need to remember yoga tomorrow', 'recall'],
    ['Dentist on Friday at 10', 'event_add'],
    ['I need to call the dentist', 'reminder'],
    ['Call yourself Milo', 'rename'],
    ['Rick lives in New York', 'contact_fact'],
    ['yes', 'yes'],
    ['No.', 'no'],
    ['I need to buy shampoo', 'shopping_add'],
  ];
  for (const [text, kind] of cases) {
    it(`${text} → ${kind}`, () => expect(first(text).kind).toBe(kind));
  }
  it('extracts details', () => {
    expect(first("Ah, I can't make that yoga appointment anymore.").phrase).toMatch(/yoga/);
    expect(first('Reply to Sarah and tell her I\'ll send it tonight').body).toBe("I'll send it tonight.");
    expect(first('Just tell her I\'ll get back to her tonight') ).toMatchObject({ kind: 'communicate', body: "I'll get back to you tonight." });
    expect(first('Organise a Zoom with Rick.').people).toEqual(['rick']);
    expect(first('Actually make that three.').quantity).toBe(3);
    expect(first('I need to buy milk, eggs and bread').items.map((i: any) => i.name)).toEqual(['milk', 'eggs', 'bread']);
  });
  it('multiple thoughts', () => {
    expect(kinds('I need groceries, I forgot about yoga tomorrow, I should reply to Sarah, and I need to call the dentist.')).toEqual(['shopping_add', 'recall', 'communicate', 'reminder']);
    expect(kinds("I need groceries, oh and I can't make yoga tomorrow, and remind me to message Sarah later.")).toEqual(['shopping_add', 'cancel', 'reminder']);
  });
  it('wake name', () => {
    expect(stripWakeName('Hey Milo, remind me to buy milk', 'Milo')).toEqual({ text: 'remind me to buy milk', addressed: true });
    expect(stripWakeName('Hey Mylo remind me', 'Milo').addressed).toBe(true);
    expect(stripWakeName('Milk is needed', 'Milo').addressed).toBe(false);
    expect(stripWakeName('Mile high club', 'Milo').addressed).toBe(false);
  });
});
