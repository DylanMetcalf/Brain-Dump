import { describe, it, expect } from 'vitest';
import { setup, at } from './helpers.js';
import { tick } from '../src/core/scheduler.js';

describe('phone actions a real person asks for', () => {
  it('"Send a WhatsApp to my mom saying…" prepares it in WhatsApp, then learns her number', async () => {
    const h = setup();
    const r = await h.say("Send a WhatsApp to my mom saying I'll be late tonight");
    expect(r.text).toMatch(/tap to send it in WhatsApp/);
    expect(r.links[0]).toMatchObject({ label: 'Send to Mom on WhatsApp' });
    expect(r.links[0].url).toBe("https://wa.me/?text=I'll%20be%20late%20tonight.");
    expect(r.text).toMatch(/Tell me Mom's number/);
    await h.say("Mum's number is 07700 900123");
    // Mum and Mom are the same person.
    expect(h.state.contacts).toHaveLength(1);
    const r2 = await h.say('Text mum saying love you');
    expect(r2.links[0].url).toBe('sms:07700900123&body=Love%20you.');
    expect(r2.text).not.toMatch(/Tell me/);
  });

  it('"Call mum" asks for the number once, then offers a one-tap call', async () => {
    const h = setup();
    const r = await h.say('Call mum');
    expect(r.question?.text).toBe("What's Mum's number? I'll remember it.");
    const r2 = await h.say('07700 900123');
    expect(r2.text).toMatch(/Saved Mum's number\. Tap to call Mum\./);
    expect(r2.links[0]).toEqual({ label: 'Call Mum', url: 'tel:07700900123' });
    h.newSession();
    const r3 = await h.say('Ring my mum');
    expect(r3.question).toBeUndefined();
    expect(r3.links[0].url).toBe('tel:07700900123');
  });

  it('timers notify when time is up', async () => {
    const h = setup();
    const r = await h.say('Set a timer for 10 minutes');
    expect(r.text).toMatch(/^Timer set for 10 minutes — I'll let you know at 10:10 AM\.$/);
    h.clock.now = at(9, 27, 10, 10);
    const t = await tick(h.a, h.clock.now);
    expect(t.notifications.map((n) => n.text)).toContain("Time's up (10 minutes timer)");
  });

  it('alarms are honest about being notifications', async () => {
    const h = setup();
    const r = await h.say('Wake me up at 6:30 tomorrow');
    expect(r.text).toMatch(/notify you tomorrow at 6:30 AM/);
    expect(r.text).toMatch(/Clock app/);
  });

  it('music opens the right app and remembers the preferred one', async () => {
    const h = setup();
    const r = await h.say('Play Taylor Swift on Spotify');
    expect(r.links).toEqual([{ label: 'Play in Spotify', url: 'https://open.spotify.com/search/Taylor%20Swift' }]);
    const r2 = await h.say('Play some jazz');
    expect(r2.links.map((l) => l.label)).toEqual(['Play in Spotify']);
  });

  it('checking email without Gmail connected says how to connect it', async () => {
    const h = setup();
    const r = await h.say('Check my emails');
    expect(r.text).toMatch(/Connect Gmail in Settings/);
  });

  it('checking email summarises unread messages', async () => {
    const h = setup();
    const iso = h.clock.now.toISOString();
    h.state.mailbox.push(
      { id: 'a', from: 'rick@x.com', fromName: 'Rick', to: [], subject: 'Contract', snippet: '', receivedAt: iso, labels: ['INBOX', 'UNREAD'], unread: true },
      { id: 'b', from: 'news@y.com', fromName: 'Weekly', to: [], subject: 'News', snippet: '', receivedAt: iso, labels: ['INBOX'], unread: false },
    );
    const r = await h.say('Any new emails?');
    expect(r.text).toBe('You\'ve got 1 unread email. Latest: “Contract” from Rick.');
  });

  it('explicit notes are saved even when they sound like questions', async () => {
    const h = setup();
    const r = await h.say('Make a note: what colour should the hallway be?');
    expect(r.text).toBe('Got it — that’s in your notes.');
    expect(h.state.notes[0].text).toMatch(/hallway/);
  });
});

describe('sounds like a person', () => {
  it('family names are names: "call mum" → "call Mum"', async () => {
    const { setup } = await import('./helpers.js');
    const h = setup();
    const r = await h.say('Remind me to call mum tomorrow at 9');
    expect(r.text).toMatch(/call Mum tomorrow at 9 AM/);
  });
});
