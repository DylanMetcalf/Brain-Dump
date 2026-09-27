import { describe, it, expect } from 'vitest';
import { setup, at } from './helpers.js';
import { MockPurchases, MockBookings, SendingMessaging } from './mocks.js';
import { setTrust } from '../src/core/state.js';

describe('ambiguity', () => {
  it('two yoga classes → one short question, then acts on the answer', async () => {
    const h = setup();
    const tue = h.event('Yoga', at(9, 29, 14));
    const thu = h.event('Yoga', at(10, 1, 9));
    const r = await h.say('Cancel yoga.');
    expect(r.text).toBe('Which one — Tuesday at 2 or Thursday at 9?');
    expect(r.question?.options).toHaveLength(2);
    const r2 = await h.say('Thursday');
    expect(r2.text).toMatch(/cancelled yoga Thursday at 9 AM/);
    expect(h.state.events.find((e) => e.id === thu.id)!.status).toBe('cancelled');
    expect(h.state.events.find((e) => e.id === tue.id)!.status).toBe('confirmed');
  });
  it('weekly repeats → the next one is obvious', async () => {
    const h = setup();
    const a = h.event('Yoga', at(9, 29, 14));
    h.event('Yoga', at(10, 6, 14));
    await h.say("I can't make yoga");
    expect(h.state.events.find((e) => e.id === a.id)!.status).toBe('cancelled');
    expect(h.state.events.filter((e) => e.status === 'cancelled')).toHaveLength(1);
  });
  it('tapping an option button works too', async () => {
    const h = setup();
    h.event('Yoga', at(9, 29, 14));
    const thu = h.event('Yoga', at(10, 1, 9));
    const r = await h.say('Cancel yoga');
    const opt = r.question!.options!.find((o) => o.label.startsWith('Thursday'))!;
    await h.say(opt.value);
    expect(h.state.events.find((e) => e.id === thu.id)!.status).toBe('cancelled');
  });
  it('several Sarahs → asks which', async () => {
    const h = setup();
    h.contact('Sarah Jones');
    const lee = h.contact('Sarah Lee');
    const r = await h.say("Tell Sarah I'll be late");
    expect(r.text).toBe('Which Sarah — Sarah Jones or Sarah Lee?');
    await h.say('Lee');
    expect(h.state.drafts[0].to).toBe(lee);
    expect(h.state.drafts[0].body).toBe("I'll be late.");
  });
  it('one Sarah → just uses her', async () => {
    const h = setup();
    const id = h.contact('Sarah Jones');
    await h.say("Tell Sarah I'll be late");
    expect(h.state.drafts[0].to).toBe(id);
  });
});

describe('risk-based confirmation', () => {
  it('low-risk actions never ask', async () => {
    const h = setup();
    for (const t of ['Add eggs', 'Remind me to water the plants tomorrow', 'Idea: a podcast about lighthouses']) {
      const r = await h.say(t);
      expect(r.question).toBeUndefined();
    }
    expect(h.state.ledger.every((e) => e.auto)).toBe(true);
  });

  it('cancelling an event other people were invited to asks first', async () => {
    const h = setup();
    const rick = h.contact('Rick');
    h.event('Project sync', at(9, 29, 11), { attendees: [rick], meeting: { provider: 'zoom', url: 'https://zoom.us/j/1' } });
    const r = await h.say('Cancel the project sync');
    expect(r.question?.text).toMatch(/Cancel project sync Tuesday at 11 AM\? Rick will be told\./);
    expect(r.question?.options?.map((o) => o.label)).toEqual(['Cancel it', 'Keep']);
    expect(h.state.events[0].status).toBe('confirmed');
    await h.say('yes');
    expect(h.state.events[0].status).toBe('cancelled');
  });

  it('purchases always confirm with the price — trust never removes that', async () => {
    const shop = new MockPurchases();
    const h = setup({ providers: { purchases: shop } });
    h.state.permissions.find((p) => p.scope === 'purchases')!.level = 'act';
    setTrust(h.state, 'purchase.create', true, h.clock.now);
    const r = await h.say('Buy that laptop');
    expect(r.question?.text).toBe('Buy ThinkBook 14 laptop for £1,299.00?');
    expect(shop.orders).toHaveLength(0);
    const r2 = await h.say('yes');
    expect(shop.orders).toEqual(['p_laptop']);
    expect(r2.text).toMatch(/Ordered/);
  });

  it('purchases without permission ask for authorisation, then confirm', async () => {
    const shop = new MockPurchases();
    const h = setup({ providers: { purchases: shop } });
    const r = await h.say('Buy that laptop');
    expect(r.question?.text).toMatch(/buy things for you/);
    const r2 = await h.say('yes');
    expect(r2.question?.text).toMatch(/£1,299/);
    expect(shop.orders).toHaveLength(0);
  });

  it('without a purchase integration it goes on the shopping list', async () => {
    const h = setup();
    const r = await h.say('Order a new kettle');
    expect(h.state.shopping.some((s) => /kettle/.test(s.name))).toBe(true);
    expect(r.text).toMatch(/can't buy things/);
  });

  it('sending messages: confirm until trusted, then just send (earned trust)', async () => {
    const msg = new SendingMessaging();
    const h = setup({ providers: { messaging: msg } });
    h.contact('Rick', { phone: '+447700900123' });
    h.state.permissions.find((p) => p.scope === 'messaging')!.level = 'act';
    for (let i = 0; i < 3; i++) {
      const r = await h.say(`Tell Rick I'm running ${i + 5} minutes late`);
      expect(r.question?.text).toMatch(/^Send to Rick/);
      await h.say('yes');
    }
    expect(msg.sent).toHaveLength(3);
    const r = await h.say("Tell Rick I'm here");
    expect(r.question).toBeUndefined();
    expect(msg.sent).toHaveLength(4);
    expect(r.text).toMatch(/Sent to Rick/);
  });

  it('sensitive messages always confirm even when trusted', async () => {
    const msg = new SendingMessaging();
    const h = setup({ providers: { messaging: msg } });
    h.contact('Boss', { phone: '+447700900123' });
    h.state.permissions.find((p) => p.scope === 'messaging')!.level = 'act';
    setTrust(h.state, 'message.send', true, h.clock.now);
    const r = await h.say('Tell Boss I resign');
    expect(r.question?.text).toMatch(/^Send to Boss/);
    expect(msg.sent).toHaveLength(0);
  });

  it('without a sending integration, a message is prepared with a hand-off link — never claimed as sent', async () => {
    const h = setup();
    h.contact('Rick', { phone: '+44 7700 900123' });
    const r = await h.say('Message Rick saying see you at 6');
    expect(r.text).toMatch(/drafted/);
    expect(r.text).not.toMatch(/sent/i);
    expect(r.links[0].url).toBe('https://wa.me/447700900123?text=See%20you%20at%206.');
    const r2 = await h.say('Send it');
    expect(r2.text).toMatch(/can't send messages directly/);
  });

  it('asks for calendar permission once, then acts', async () => {
    const h = setup({ permissions: false });
    h.event('Yoga', at(9, 29, 14));
    const r = await h.say("I can't make yoga");
    expect(r.question?.text).toMatch(/manage your calendar/);
    const r2 = await h.say('Yes');
    expect(r2.text).toMatch(/cancelled yoga/);
    h.event('Pilates', at(9, 30, 14));
    const r3 = await h.say("I can't make pilates");
    expect(r3.text).toMatch(/cancelled pilates/);
    expect(r3.text).not.toMatch(/manage your calendar/);
  });
});

describe('email', () => {
  function mailbox(h: ReturnType<typeof setup>) {
    const iso = h.clock.now.toISOString();
    h.state.mailbox.push(
      { id: 'e1', from: 'deals@shop.com', to: ['me'], subject: '50% off', snippet: '', receivedAt: iso, labels: ['INBOX', 'CATEGORY_PROMOTIONS'], unread: true },
      { id: 'e2', from: 'news@brand.com', to: ['me'], subject: 'New arrivals', snippet: '', receivedAt: iso, labels: ['INBOX', 'CATEGORY_PROMOTIONS'], unread: true },
      { id: 'e3', from: 'rick@example.com', fromName: 'Rick', to: ['me'], subject: 'Re: Thursday', snippet: 'Works for me', receivedAt: iso, labels: ['INBOX'], unread: true },
    );
  }
  it('"clear those promotional emails" archives (reversible) once email is authorised; undo restores', async () => {
    const h = setup();
    mailbox(h);
    const r = await h.say('Clear those promotional emails');
    expect(r.question?.text).toMatch(/send emails for you|manage your email/);
    h.state.permissions.find((p) => p.scope === 'email')!.level = 'act';
    h.newSession();
    const r2 = await h.say('Clear those promotional emails');
    expect(r2.text).toBe('Archived 2 promotional emails. Say “undo” if you want them back.');
    expect(h.state.mailbox.filter((m) => m.labels.includes('INBOX'))).toHaveLength(1);
    await h.say('undo');
    expect(h.state.mailbox.filter((m) => m.labels.includes('INBOX'))).toHaveLength(3);
  });
  it('permanent deletion needs confirmation', async () => {
    const h = setup();
    mailbox(h);
    h.state.permissions.find((p) => p.scope === 'email')!.level = 'act';
    const r = await h.say('Delete those promotional emails permanently');
    expect(r.question?.text).toMatch(/can't be undone/);
    await h.say('no');
    expect(h.state.mailbox.filter((m) => m.labels.includes('TRASH'))).toHaveLength(0);
  });
  it('"Has Rick replied?" checks the mailbox', async () => {
    const h = setup();
    h.contact('Rick', { email: 'rick@example.com' });
    h.advance(-60);
    await h.say("Rick hasn't replied about Thursday");
    h.advance(60);
    mailbox(h);
    const r = await h.say('Has Rick replied?');
    expect(r.text).toMatch(/Yes — Rick replied today: “Re: Thursday”/);
    expect(h.state.waiting[0].status).toBe('resolved');
  });
});

describe('timezones', () => {
  it('asks "your time or theirs" when the contact is elsewhere', async () => {
    const h = setup();
    await h.say('Rick lives in New York');
    const r = await h.say('Organise a Zoom with Rick on Thursday at 2');
    expect(r.question?.text).toBe("2 PM your time or Rick's?");
    const r2 = await h.say("Rick's");
    const e = h.state.events.find((x) => /rick/i.test(x.title))!;
    expect(e.start).toBe('2026-10-01T18:00:00.000Z'); // 2 PM New York (EDT)
    expect(e.timeZone).toBe('America/New_York');
    expect(r2.text).toMatch(/Thursday at 7 PM \(2 PM for Rick\)/);
  });
  it('explicit zone in the request needs no question', async () => {
    const h = setup();
    await h.say('Rick lives in New York');
    const r = await h.say('Set up a call with Rick on Thursday at 2 my time');
    expect(r.question).toBeUndefined();
    expect(h.state.events[0].start).toBe(at(10, 1, 14).toISOString());
  });
  it('user moving city updates their timezone', async () => {
    const h = setup();
    const r = await h.say('I live in Tokyo');
    expect(h.state.profile.timeZone).toBe('Asia/Tokyo');
    expect(r.text).toMatch(/Tokyo time/);
  });
});

describe('existing state before new state', () => {
  it('does not duplicate a shopping item', async () => {
    const h = setup();
    await h.say('Add milk');
    const r = await h.say('I need milk');
    expect(r.text).toBe('Milk is already on your list.');
    expect(h.state.shopping.filter((s) => s.status === 'needed')).toHaveLength(1);
  });
  it('"I need to remember yoga tomorrow" finds the existing event', async () => {
    const h = setup();
    h.event('Yoga', at(9, 28, 14));
    const r = await h.say('I need to remember yoga tomorrow');
    expect(r.text).toMatch(/Yoga is tomorrow at 2 PM — it's on your calendar/);
    expect(h.state.events).toHaveLength(1);
    expect(h.state.reminders).toHaveLength(0);
  });
  it('adding an event that already exists at another time offers to move it', async () => {
    const h = setup();
    h.event('Dentist', at(10, 2, 10));
    const r = await h.say('Dentist on Friday at 11');
    expect(r.question?.text).toMatch(/already got dentist Friday at 10 AM — move it to 11 AM\?/);
    await h.say('yes');
    expect(h.state.events[0].start).toBe(at(10, 2, 11).toISOString());
    expect(h.state.events).toHaveLength(1);
  });
  it('"Remove it" after cancelling says it is already done', async () => {
    const h = setup();
    h.event('Yoga', at(9, 29, 14));
    await h.say("I can't make yoga");
    const r = await h.say('Remove it');
    expect(r.text).toMatch(/already cancelled/);
  });
});

describe('undo & ledger', () => {
  it('"Put it back" restores a cancelled event', async () => {
    const h = setup();
    h.event('Yoga', at(9, 29, 14));
    await h.say("I can't make yoga");
    const r = await h.say('Put it back');
    expect(r.text).toBe('Put it back — yoga is Tuesday at 2 PM again.');
    expect(h.state.events[0].status).toBe('confirmed');
  });
  it('undo reverses a whole multi-item capture', async () => {
    const h = setup();
    await h.say('Add eggs, bread and butter');
    const r = await h.say('undo');
    expect(r.text).toBe('Undone — took eggs, bread and butter off your list.');
    expect(h.state.shopping.filter((s) => s.status === 'needed')).toHaveLength(0);
  });
  it('only verified actions are reported as handled', async () => {
    const h = setup();
    h.state.ledger.push({ id: 'x', at: h.clock.now.toISOString(), actionType: 'calendar.cancel', summary: 'fake', entity: 'event', entityId: 'nope', verified: false, auto: true, risk: 'medium', before: { title: 'Ghost meeting' }, after: null, undoable: false });
    const r = await h.say('What did you handle today?');
    expect(r.text).not.toMatch(/ghost/i);
  });
});

describe('bookings', () => {
  it('asks only for the missing choice, then books and adds to the calendar', async () => {
    const b = new MockBookings();
    const h = setup({ providers: { bookings: b } });
    h.state.permissions.find((p) => p.scope === 'bookings')!.level = 'act';
    const r = await h.say('Book me a massage next Wednesday afternoon');
    expect(r.question?.text).toBe('Calm Spa can do 2 PM or 4 PM Wednesday — which works?');
    const r2 = await h.say('4');
    expect(r2.question?.text).toMatch(/^Book massage Wednesday at 4 PM\?/);
    const r3 = await h.say('yes');
    expect(b.booked).toEqual(['s2']);
    expect(r3.text).toMatch(/Booked — massage Wednesday at 4 PM/);
    expect(h.state.events.some((e) => /massage/i.test(e.title))).toBe(true);
  });
  it('without a booking integration, it says so honestly and keeps it on the list', async () => {
    const h = setup();
    const r = await h.say('Book me a massage next Wednesday afternoon');
    expect(r.text).toMatch(/can't book massage directly yet/);
    const needs = await h.say('What still needs me?');
    expect(needs.text).toMatch(/book massage/i);
  });
});

describe('offline capture & idempotency', () => {
  it('replaying the same capture never duplicates', async () => {
    const h = setup();
    const r1 = await h.say('Remember to buy batteries', { clientId: 'c-1' });
    const r2 = await h.say('Remember to buy batteries', { clientId: 'c-1' });
    expect(r2).toEqual(r1);
    expect(h.state.shopping).toHaveLength(1);
  });
  it('relative dates resolve from capture time, not sync time', async () => {
    const h = setup();
    const captured = at(9, 26, 20).toISOString(); // Saturday evening, offline
    await h.say('Remind me to call mum tomorrow at 10', { capturedAt: captured, clientId: 'c-2' });
    expect(h.state.reminders[0].dueAt).toBe(at(9, 27, 10).toISOString());
  });
});

describe('voice & naming', () => {
  it('onboarding asks for a name and permissions', async () => {
    const h = setup({ onboarded: false });
    const r0 = await h.a.start({ now: h.clock.now });
    h.sessionId = r0.sessionId;
    expect(r0.text).toMatch(/What would you like to call me\?$/);
    const r1 = await h.say('Milo.');
    expect(r1.text).toMatch(/^Milo it is\./);
    expect(r1.question?.text).toMatch(/manage your calendar, reminders and shopping list/);
    const r2 = await h.say('Yes');
    expect(r2.text).toMatch(/What's on your mind/);
    expect(h.state.profile.assistantName).toBe('Milo');
    expect(h.state.permissions.find((p) => p.scope === 'calendar')!.level).toBe('act');
    expect(h.state.permissions.find((p) => p.scope === 'messaging')!.level).toBe('draft');
  });
  it('wake name is optional and mishearings are tolerated', async () => {
    const h = setup();
    await h.say('Hey Mylo, add milk');
    await h.say('Milo, remind me to call the bank');
    expect(h.state.shopping[0].name).toBe('milk');
    expect(h.state.reminders[0].text).toMatch(/call the bank/i);
  });
  it('the user can rename the assistant', async () => {
    const h = setup();
    const r = await h.say('Call yourself Nova');
    expect(r.text).toBe('Nova it is.');
    expect(h.state.profile.assistantName).toBe('Nova');
  });
});

describe('waiting states', () => {
  it('distinguishes waiting for others from people waiting on me', async () => {
    const h = setup();
    await h.say("Rick hasn't replied");
    await h.say('Sarah is waiting for my answer');
    const r = await h.say('What still needs me?');
    expect(r.text).toMatch(/Sarah is waiting for your answer/);
    expect(r.text).toMatch(/Rick hasn't replied/);
    expect(h.state.reminders).toHaveLength(0); // not turned into overdue tasks
  });
  it('"Rick replied" resolves it', async () => {
    const h = setup();
    await h.say("I'm waiting on Rick");
    await h.say('Rick got back to me');
    expect(h.state.waiting[0].status).toBe('resolved');
  });
});

describe('knows when NOT to act', () => {
  it('casual mentions do not cancel or create things', async () => {
    const h = setup();
    h.event('Yoga', at(9, 29, 14));
    await h.say('Yoga was great last week');
    await h.say('Maybe we could go to Lisbon sometime');
    expect(h.state.events[0].status).toBe('confirmed');
    expect(h.state.events).toHaveLength(1);
    expect(h.state.drafts).toHaveLength(0);
  });
  it('a drafted thought is not sent', async () => {
    const msg = new SendingMessaging();
    const h = setup({ providers: { messaging: msg } });
    h.contact('Sarah', { phone: '+447700900000' });
    await h.say('I should reply to Sarah');
    expect(msg.sent).toHaveLength(0);
  });
});
