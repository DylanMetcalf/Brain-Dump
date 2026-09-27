// Spec §72–75: the four critical UX acceptance tests.
import { describe, it, expect } from 'vitest';
import { setup, at } from './helpers.js';

describe('CRITICAL 1 — "I can\'t make that yoga appointment."', () => {
  it('cancels without confirmation, offers reschedule, "No" ends it', async () => {
    const h = setup();
    const yoga = h.event('Yoga', at(9, 29, 14)); // Tuesday 2 PM
    const r1 = await h.say("I can't make that yoga appointment.");
    expect(r1.text).not.toMatch(/are you sure/i);
    expect(r1.text).toMatch(/Done/);
    expect(r1.text).toMatch(/Do you want to reschedule it\?$/);
    expect(h.state.events.find((e) => e.id === yoga.id)!.status).toBe('cancelled');
    // Verified ledger entry, performed without asking.
    const entry = h.state.ledger.find((l) => l.actionType === 'calendar.cancel')!;
    expect(entry.verified).toBe(true);
    expect(entry.auto).toBe(true);
    const r2 = await h.say('No.');
    expect(r2.text).toBe('OK.');
    expect(r2.question).toBeUndefined();
    expect(r2.settled).toBe(true);
    expect(h.state.events.find((e) => e.id === yoga.id)!.status).toBe('cancelled');
  });

  it('the Nicole phrasing with "Ah" and "anymore" works too', async () => {
    const h = setup();
    h.event('Yoga', at(9, 29, 14));
    const r = await h.say("Ah, I can't make that yoga appointment anymore.");
    expect(r.text).toMatch(/cancelled yoga/i);
    expect(r.question?.text).toBe('Do you want to reschedule it?');
  });
});

describe('CRITICAL 2 — "I can\'t make it."', () => {
  it('resolves "it" from the conversation', async () => {
    const h = setup();
    const dentist = h.event('Dentist', at(10, 2, 10));
    h.event('Yoga', at(9, 29, 14));
    await h.say('I need to remember the dentist on Friday');
    const r = await h.say("I can't make it.");
    expect(h.state.events.find((e) => e.id === dentist.id)!.status).toBe('cancelled');
    expect(r.text).toMatch(/dentist/i);
    expect(r.text).not.toMatch(/which one/i);
  });

  it('asks ONE concise question when several targets are plausible', async () => {
    const h = setup({ now: at(9, 28, 8) }); // Monday 8 AM
    h.event('Standup', at(9, 28, 10));
    h.event('Lunch with Tom', at(9, 28, 13));
    const r = await h.say("I can't make it.");
    expect(r.question?.text).toMatch(/^Which one — .+ or .+\?$/);
    expect(h.state.events.every((e) => e.status === 'confirmed')).toBe(true);
    const r2 = await h.say('The lunch');
    expect(r2.text).toMatch(/cancelled lunch with tom/i);
    expect(h.state.events.find((e) => e.title === 'Standup')!.status).toBe('confirmed');
  });

  it('acts when there is exactly one obvious target', async () => {
    const h = setup({ now: at(9, 28, 8) });
    h.event('Physio', at(9, 28, 11));
    const r = await h.say("I can't make it.");
    expect(r.text).toMatch(/cancelled physio/i);
  });
});

describe('CRITICAL 3 — stream of thought', () => {
  it('handles three thoughts in one breath with no categorising', async () => {
    const h = setup();
    const yoga = h.event('Yoga', at(9, 28, 18)); // tomorrow evening
    const r = await h.say("I need groceries, oh and I can't make yoga tomorrow, and remind me to message Sarah later.");
    expect(r.text).not.toMatch(/category|which list/i);
    expect(h.state.shopping.map((s) => s.name)).toContain('groceries');
    expect(h.state.events.find((e) => e.id === yoga.id)!.status).toBe('cancelled');
    const rem = h.state.reminders.find((x) => /message sarah/i.test(x.text))!;
    expect(rem).toBeTruthy();
    expect(rem.dueAt).toBeTruthy();
    // At most one question in the reply.
    expect((r.text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
  });
});

describe('CRITICAL 4 — continuous session across app switches', () => {
  it('keeps context and finishes gracefully', async () => {
    const h = setup();
    const yoga = h.event('Yoga', at(9, 28, 14));
    const start = await h.a.start({ now: h.clock.now });
    h.sessionId = start.sessionId;
    const r1 = await h.say('I need to buy shampoo.');
    expect(r1.text).toMatch(/Added shampoo/);
    h.advance(2); // user switches to WhatsApp
    const r2 = await h.say('Actually I need to reply to Sarah.');
    expect(r2.sessionId).toBe(start.sessionId);
    expect(r2.question?.text).toMatch(/What do you want to say/);
    h.advance(3); // another app
    const r3 = await h.say("And I can't make yoga tomorrow.");
    expect(r3.sessionId).toBe(start.sessionId);
    expect(h.state.events.find((e) => e.id === yoga.id)!.status).toBe('cancelled');
    const r4 = await h.say("That's all.");
    expect(r4.sessionEnded).toBe(true);
    expect(r4.text).toMatch(/^Got it\. I've sorted everything I could\./);
    expect(r4.text).toMatch(/I'll let you know if anything needs you\.$/);
    // The Sarah follow-up is not lost even though no message was dictated.
    expect(h.state.reminders.some((x) => /reply to sarah/i.test(x.text) && x.status === 'open')).toBe(true);
  });

  it('the full Nicole conversation (spec §19)', async () => {
    const h = setup();
    h.event('Yoga', at(9, 28, 14));
    expect((await h.say('I need to buy face masks.')).text).toMatch(/Added face masks/);
    expect((await h.say('Oh, and I need to reply to Sarah.')).question?.text).toMatch(/What do you want to say/);
    const r = await h.say("Just tell her I'll get back to her tonight.");
    expect(r.text).toMatch(/I've written it/);
    const d = h.state.drafts[0];
    expect(d.body).toBe("I'll get back to you tonight.");
    expect(r.links[0].url).toMatch(/^https:\/\/wa\.me\//);
    const r3 = await h.say("And I can't make yoga tomorrow.");
    expect(r3.text).toMatch(/cancelled yoga tomorrow at 2 PM/);
    expect((await h.say('No.')).text).toBe('OK.');
    const end = await h.say("That's all.");
    expect(end.text).toBe("Got it. I've sorted everything I could. I'll let you know if anything needs you.");
  });
});
