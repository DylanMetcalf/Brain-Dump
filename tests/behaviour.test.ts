import { describe, it, expect } from 'vitest';
import { setup, at } from './helpers.js';
import { tick } from '../src/core/scheduler.js';

async function fourWeeksOfCalisthenics() {
  const h = setup({ now: at(9, 2, 19) }); // Wednesday 2 Sep, evening
  for (const day of [2, 9, 16, 23]) {
    h.clock.now = at(9, day, 19);
    h.newSession();
    await h.say('Calisthenics tomorrow at 8');
  }
  h.clock.now = at(9, 27, 10);
  h.newSession();
  return h;
}

describe('behavioural intelligence', () => {
  it('observes a routine but never automates without permission', async () => {
    const h = await fourWeeksOfCalisthenics();
    expect(h.state.events.filter((e) => /calisthenics/i.test(e.title))).toHaveLength(4);
    await tick(h.a, h.clock.now);
    expect(h.state.routines).toHaveLength(0);
    // The only thing the assistant may do is suggest.
    const sug = h.state.suggestions.find((s) => s.kind === 'routine')!;
    expect(sug.text).toBe("I've noticed you usually do calisthenics on Thursday mornings. Want me to remember that as your usual routine?");
    expect(h.state.events.filter((e) => /calisthenics/i.test(e.title))).toHaveLength(4);
  });

  it('OBSERVED → SUGGESTED → CONFIRMED → PREPARED → AUTOMATED', async () => {
    const h = await fourWeeksOfCalisthenics();
    const r = await h.say('Can you make this easier?');
    expect(r.question?.text).toMatch(/usually do calisthenics on Thursday mornings/);
    const r2 = await h.say('Yes');
    expect(r2.text).toMatch(/I'll remember that/);
    expect(r2.question?.text).toMatch(/add it to your calendar automatically each week/);
    const routine = h.state.routines[0];
    expect(routine).toMatchObject({ title: 'Calisthenics', weekday: 4, hour: 8, status: 'confirmed' });
    expect(h.state.memories.find((m) => m.kind === 'routine')).toMatchObject({ provenance: 'confirmed', confirmed: true, automationAllowed: false });
    const r3 = await h.say('No');
    expect(r3.text).toMatch(/remind you the day before/);

    // PREPARED: Wednesday evening, offered — not added.
    h.clock.now = at(9, 30, 18);
    const t1 = await tick(h.a, h.clock.now);
    const prep = t1.notifications.find((n) => n.kind === 'suggestion' && /usual calisthenics is tomorrow at 8 AM/.test(n.text))!;
    expect(prep).toBeTruthy();
    expect(h.state.events.filter((e) => /calisthenics/i.test(e.title) && e.status === 'confirmed' && e.start > at(9, 30, 0).toISOString())).toHaveLength(0);
    // idempotent
    expect((await tick(h.a, h.clock.now)).notifications.filter((n) => n.key === prep.key)).toHaveLength(0);
    const act = await h.a.actOnNotification(prep.id, 'add', h.clock.now);
    expect(act.text).toMatch(/Added calisthenics tomorrow at 8 AM/);

    // AUTOMATED: user now allows it explicitly.
    routine.status = 'automated';
    h.clock.now = at(10, 4, 12);
    await tick(h.a, h.clock.now);
    await tick(h.a, h.clock.now);
    const next = h.state.events.filter((e) => e.routineId === routine.id && e.start === at(10, 8, 8).toISOString());
    expect(next).toHaveLength(1);
  });

  it('declined suggestions are not repeated', async () => {
    const h = await fourWeeksOfCalisthenics();
    await h.say('Can you make this easier?');
    const r = await h.say('No');
    expect(r.text).toMatch(/won't bring it up again/);
    const again = await h.say('Can you make this easier?');
    expect(again.question?.text ?? '').not.toMatch(/calisthenics/);
  });

  it('shopping staples → one question → weekly automatic top-up without duplicates', async () => {
    const h = setup({ now: at(9, 5, 10) }); // Saturday
    for (const day of [5, 12, 19]) {
      h.clock.now = at(9, day, 10);
      h.newSession();
      await h.say('Add milk and bread');
      await h.say('I got the milk and bread');
    }
    h.clock.now = at(9, 26, 10);
    h.newSession();
    const r = await h.say('Can you make this easier?');
    expect(r.question?.text).toMatch(/You add milk and bread most weeks/);
    const r2 = await h.say('Yes');
    expect(r2.text).toMatch(/every Saturday/);
    h.clock.now = at(10, 3, 10);
    await h.say('Add bread');
    await tick(h.a, h.clock.now);
    await tick(h.a, h.clock.now);
    const needed = h.state.shopping.filter((s) => s.status === 'needed').map((s) => s.name).sort();
    expect(needed).toEqual(['bread', 'milk']);
  });

  it('repeated "has Rick replied?" → offers to watch, and the scheduler tells you', async () => {
    const h = setup();
    h.contact('Rick', { email: 'rick@example.com' });
    await h.say("I'm waiting on Rick about the contract");
    await h.say('Has Rick replied?');
    const r = await h.say('Has Rick replied?');
    expect(r.text).toMatch(/Want me to tell you when Rick does\?/);
    await h.say('yes');
    h.advance(60);
    h.state.mailbox.push({ id: 'm1', from: 'rick@example.com', to: ['me'], subject: 'Contract signed', snippet: '', receivedAt: h.clock.now.toISOString(), labels: ['INBOX'], unread: true });
    const t = await tick(h.a, h.clock.now);
    expect(t.notifications.map((n) => n.text)).toContain('Rick replied: “Contract signed”.');
    expect(h.state.waiting[0].status).toBe('resolved');
  });
});

describe('scheduler', () => {
  it('fires due reminders exactly once', async () => {
    const h = setup();
    await h.say('Remind me to take the bins out at 7pm');
    h.clock.now = at(9, 27, 19, 1);
    const t1 = await tick(h.a, h.clock.now);
    expect(t1.notifications.filter((n) => n.kind === 'reminder').map((n) => n.text)).toEqual(['Take the bins out']);
    const t2 = await tick(h.a, h.clock.now);
    expect(t2.notifications.filter((n) => n.kind === 'reminder')).toHaveLength(0);
  });
  it('reminds before events using the lead time', async () => {
    const h = setup();
    h.event('Dentist', at(9, 27, 11), { location: 'High St' });
    h.clock.now = at(9, 27, 10, 35);
    const t = await tick(h.a, h.clock.now);
    expect(t.notifications.map((n) => n.text)).toContain('Dentist in 25 minutes — High St.');
  });
  it('snoozing a reminder from the notification', async () => {
    const h = setup();
    await h.say('Remind me to call mum at 11');
    h.clock.now = at(9, 27, 11);
    const t = await tick(h.a, h.clock.now);
    const n = t.notifications.find((x) => x.kind === 'reminder')!;
    const r = await h.a.actOnNotification(n.id, 'snooze', h.clock.now);
    expect(r.text).toMatch(/remind you again at noon/);
    h.clock.now = at(9, 27, 12, 1);
    expect((await tick(h.a, h.clock.now)).notifications.some((x) => x.text === 'Call mum')).toBe(true);
  });
  it('offers the weekly briefing on Sunday evening, once', async () => {
    const h = setup();
    h.clock.now = at(9, 27, 18, 5);
    const t = await tick(h.a, h.clock.now);
    expect(t.notifications.some((n) => n.kind === 'briefing')).toBe(true);
    expect((await tick(h.a, h.clock.now)).notifications.some((n) => n.kind === 'briefing')).toBe(false);
  });
  it('closes idle sessions but keeps blockers visible', async () => {
    const h = setup();
    h.event('Yoga', at(9, 29, 14));
    h.event('Yoga', at(10, 1, 9));
    await h.say('Cancel yoga');
    h.advance(30);
    await tick(h.a, h.clock.now);
    expect(h.state.sessions[0].endedAt).toBeTruthy();
    h.newSession();
    const r = await h.say('What still needs me?');
    expect(r.text).toMatch(/Choose which yoga to cancel/);
    const r2 = await h.say('Tuesday');
    expect(r2.text).toMatch(/cancelled yoga Tuesday/);
  });
});

describe('weekly intelligence', () => {
  it('runs the Sunday conversation', async () => {
    const h = setup();
    h.event('Dentist', at(9, 29, 10));
    await h.say('Add milk');
    await h.say("Rick hasn't replied about the quote");
    const r = await h.say('Weekly review');
    expect(r.text).toMatch(/^Here's what's happening this week\./);
    expect(r.text).toMatch(/Dentist at 10 AM/);
    expect(r.text).toMatch(/Rick hasn't replied/);
    expect(r.question?.text).toBe('Anything on your mind?');
    const r2 = await h.say('I need to get the car serviced');
    expect(r2.text).toMatch(/get the car serviced/);
    expect(r2.question?.text).toBe("Anything you've been meaning to do?");
    expect((await h.say('Nope')).question?.text).toBe('Anything I can make easier?');
    expect((await h.say('No')).question?.text).toBe('Anything else?');
    const end = await h.say("No that's it");
    expect(end.text).toMatch(/sorted|week/);
  });
});
