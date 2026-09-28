// Spec §71 golden test suite, run as one continuous day.
import { describe, it, expect, beforeAll } from 'vitest';
import { setup, at, Harness } from './helpers.js';

describe('GOLDEN SUITE', () => {
  let h: Harness;
  let yogaId: string;
  beforeAll(() => {
    h = setup();
    yogaId = h.event('Yoga', at(9, 29, 14)).id; // Tuesday 2 PM
    h.state.shopping.push({ id: 'milk', name: 'milk', status: 'needed', addedAt: h.clock.now.toISOString(), updatedAt: h.clock.now.toISOString() });
  });

  it('Capture — "I need to buy eye patches."', async () => {
    const r = await h.say('I need to buy eye patches.');
    expect(r.text).toBe('Added eye patches to your shopping list.');
    expect(h.state.shopping.find((s) => s.name === 'eye patches')?.status).toBe('needed');
  });

  it('Existing state — "I got the milk."', async () => {
    const r = await h.say('I got the milk.');
    expect(r.text).toBe('Ticked off milk.');
    expect(h.state.shopping.find((s) => s.name === 'milk')?.status).toBe('got');
    expect(h.state.shopping.filter((s) => s.name === 'milk')).toHaveLength(1);
  });

  it('Contextual cancellation — "I can\'t make yoga."', async () => {
    const r = await h.say("I can't make yoga.");
    expect(r.text).toMatch(/cancelled yoga/);
    expect(h.state.events.find((e) => e.id === yogaId)!.status).toBe('cancelled');
  });

  it('Contextual modification — "Actually make that three."', async () => {
    const r = await h.say('Actually make that three.');
    const e = h.state.events.find((x) => x.id === yogaId)!;
    expect(e.status).toBe('confirmed');
    expect(new Date(e.start).toISOString()).toBe(at(9, 29, 15).toISOString());
    expect(r.text).toMatch(/3 PM/);
    expect(h.state.events).toHaveLength(1); // modified, not duplicated
  });

  it('Follow-up — "Move it to Friday."', async () => {
    const r = await h.say('Move it to Friday.');
    const e = h.state.events.find((x) => x.id === yogaId)!;
    expect(new Date(e.start).toISOString()).toBe(at(10, 2, 15).toISOString());
    expect(r.text).toMatch(/Friday at 3 PM/);
  });

  it('Multiple thoughts — groceries, yoga, Sarah, dentist', async () => {
    const r = await h.say('I need groceries, I forgot yoga, I should message Sarah and I need to call the dentist.');
    expect(h.state.shopping.some((s) => s.name === 'groceries')).toBe(true);
    expect(r.text).toMatch(/Yoga is Friday at 3 PM/);
    expect(h.state.events.filter((e) => /yoga/i.test(e.title))).toHaveLength(1); // no duplicate
    expect(h.state.reminders.some((x) => /message sarah/i.test(x.text))).toBe(true);
    expect(h.state.reminders.some((x) => /call the dentist/i.test(x.text))).toBe(true);
    expect((r.text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
  });

  it('Meeting — "Organise a Zoom with Rick." → "Thursday." → "Two."', async () => {
    const r1 = await h.say('Organise a Zoom with Rick.');
    expect(r1.question?.text).toBe('What day?');
    const r2 = await h.say('Thursday.');
    expect(r2.question?.text).toBe('What time?');
    const r3 = await h.say('Two.');
    const zoom = h.state.events.find((e) => /zoom with rick/i.test(e.title))!;
    expect(zoom).toBeTruthy();
    expect(new Date(zoom.start).toISOString()).toBe(at(10, 1, 14).toISOString());
    expect(zoom.attendees).toHaveLength(1);
    expect(r3.text).toMatch(/Zoom with Rick is in your calendar Thursday at 2 PM/);
    expect(h.state.drafts.some((d) => d.relatedEventId === zoom.id)).toBe(true);
    expect(h.state.waiting.some((w) => w.who === 'Rick' && w.status === 'waiting')).toBe(true);
  });

  it('Natural ending — "That\'s all."', async () => {
    const r = await h.say("That's all.");
    expect(r.sessionEnded).toBe(true);
    expect(r.text).toMatch(/I've sorted everything I could/);
  });

  it('Status — "What still needs me?"', async () => {
    const r = await h.say('What still needs me?');
    expect(r.text).toMatch(/Rick hasn't confirmed the meeting/);
    expect(r.text).toMatch(/message to Rick is ready to send/);
    expect(r.text).not.toMatch(/eye patches/); // not a giant task list
  });

  it('History — "What did you handle today?"', async () => {
    const r = await h.say('What did you handle today?');
    expect(r.text).toMatch(/^Today I /);
    expect(r.text).toMatch(/moved yoga to Friday at 3 PM/);
    expect(r.text).toMatch(/set up the Zoom with Rick/);
    expect(r.text).toMatch(/eye patches/);
    expect(r.text).toMatch(/Rick hasn't confirmed yet/);
  });

  it('Friction — "Can you make this easier?"', async () => {
    const r = await h.say('Can you make this easier?');
    expect(r.text.length).toBeGreaterThan(10);
  });

  it('never asked an unnecessary confirmation during the whole run', () => {
    const confirms = h.state.sessions.flatMap((s) => s.turns).filter((t) => t.role === 'assistant' && /are you sure|shall i go ahead/i.test(t.text));
    expect(confirms).toHaveLength(0);
    expect(h.state.ledger.filter((l) => !l.auto && l.actionType.startsWith('calendar.'))).toHaveLength(0);
  });
});
