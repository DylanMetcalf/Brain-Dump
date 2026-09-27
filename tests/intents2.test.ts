import { describe, it, expect } from 'vitest';
import { interpret, parseDuration } from '../src/core/interpret.js';
import { NOW, TZ } from './helpers.js';
const first = (s: string) => interpret(s, { now: NOW, timeZone: TZ, assistantName: 'Milo' }).thoughts[0] as any;

describe('everyday phone actions', () => {
  const cases: [string, string, Record<string, unknown>?][] = [
    ["Send a WhatsApp to my mom saying I'll be late", 'communicate', { personName: 'Mom', channel: 'whatsapp', body: "I'll be late." }],
    ['send mum a text saying love you', 'communicate', { personName: 'Mum', channel: 'sms' }],
    ['Text dad that dinner is at 7', 'communicate', { personName: 'Dad', channel: 'sms', body: 'Dinner is at 7.' }],
    ['WhatsApp Sarah saying see you soon', 'communicate', { personName: 'sarah', channel: 'whatsapp' }],
    ['Email Rick about the invoice', 'communicate', { channel: 'email' }],
    ['Call mum', 'call', { personName: 'Mum', video: false }],
    ['FaceTime my dad', 'call', { personName: 'Dad', video: true }],
    ['Give Rick a ring', 'call', { personName: 'rick' }],
    ['I need to call the dentist', 'reminder'],
    ['Call mum tomorrow at 5', 'reminder'],
    ['Set a timer for 10 minutes', 'timer', { ms: 600000, label: '10 minutes' }],
    ['20 minute timer', 'timer', { ms: 1200000 }],
    ['Set an alarm for 7am', 'alarm'],
    ['Wake me up at 6:30', 'alarm'],
    ['Play some jazz', 'music', { query: 'jazz' }],
    ['Put on Taylor Swift on Spotify', 'music', { query: 'taylor swift', service: 'spotify' }],
    ['Play tennis on Saturday at 10', 'event_add'],
    ['Check my emails', 'check_email'],
    ['Any new emails?', 'check_email'],
    ['Did I get an email from Rick?', 'check_email', { from: 'rick' }],
    ['Make a note that the plumber comes at 3', 'note', { text: 'The plumber comes at 3' }],
    ['Take a note: gate code is 4471', 'note'],
    ["Mum's number is 07700 900123", 'contact_fact'],
  ];
  for (const [text, kind, props] of cases) {
    it(`${text} → ${kind}`, () => {
      const t = first(text);
      expect(t.kind).toBe(kind);
      if (props) expect(t).toMatchObject(props);
    });
  }
  it('parses durations', () => {
    expect(parseDuration('an hour and a half')).toBe(5400000);
    expect(parseDuration('90 seconds')).toBe(90000);
    expect(parseDuration('half an hour')).toBe(1800000);
  });
});
