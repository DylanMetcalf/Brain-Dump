import { describe, it, expect } from 'vitest';
import { Assistant } from '../src/core/assistant.js';
import { parseRewrite } from '../src/core/assist.js';
import { setup, NOW } from './helpers.js';
import { MockPurchases } from './mocks.js';

function withClaude(reply: string | Error, extra: any = {}) {
  const h = setup(extra);
  const prompts: string[] = [];
  const a = new Assistant(h.state, {
    clock: () => h.clock.now,
    providers: extra.providers,
    askClaude: async (p) => {
      prompts.push(p);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  return { h, a, prompts };
}

describe('Claude assist', () => {
  it('turns an unclear thought into something the app can act on', async () => {
    const { h, a, prompts } = withClaude('["Remind me to get someone to look at the boiler this week"]');
    const r = await a.handle({ text: 'the boiler is making that clunking noise again ugh', now: NOW });
    expect(prompts).toHaveLength(1);
    expect(r.text).toMatch(/remind you/i);
    expect(h.state.reminders[0].text).toMatch(/boiler/);
  });
  it('is not consulted for things the app already understands', async () => {
    const { a, prompts } = withClaude('[]');
    await a.handle({ text: 'Add milk', now: NOW });
    expect(prompts).toHaveLength(0);
  });
  it('never bypasses safety: a purchase Claude suggests still needs confirmation', async () => {
    const shop = new MockPurchases();
    const { h, a } = withClaude('["Buy that laptop"]', { providers: { purchases: shop } });
    h.state.permissions.find((p) => p.scope === 'purchases')!.level = 'act';
    const r = await a.handle({ text: 'ok just get me the thinkbook thing', now: NOW });
    expect(r.question?.text).toMatch(/£1,299/);
    expect(shop.orders).toHaveLength(0);
  });
  it('keeps the thought if Claude is unavailable', async () => {
    const { h, a } = withClaude(new Error('offline'));
    const r = await a.handle({ text: 'that thing mum mentioned about the garden', now: NOW });
    expect(r.text).toMatch(/noted/i);
    expect(h.state.notes).toHaveLength(1);
  });
  it('parses tolerant JSON replies', () => {
    expect(parseRewrite('Sure:\n```json\n["Add eggs"]\n```')).toEqual({ commands: ['Add eggs'] });
    expect(parseRewrite('{"commands": [], "reply": "Paris."}')).toEqual({ commands: [], reply: 'Paris.' });
    expect(parseRewrite('not json')).toEqual({ commands: [] });
  });

  it('reads a whole messy brain dump and acts on every part of it', async () => {
    const reply = JSON.stringify({ commands: [
      'Add oat milk',
      "Send a WhatsApp to Mum saying I'll ring you on Sunday",
      'Remind me to book the car service on Friday at 9',
    ] });
    const { h, a, prompts } = withClaude(reply);
    const r = await a.handle({ text: "ugh ok so we're out of oat milk again, and mum was asking about sunday so let her know I'll ring her then, oh and the car needs its service booked, friday morning maybe", now: NOW });
    expect(prompts[0]).toMatch(/ugh ok so we're out of oat milk/);
    expect(h.state.shopping.map((i) => i.name)).toContain('oat milk');
    expect(r.links.some((l) => l.url.startsWith('https://wa.me/'))).toBe(true);
    expect(h.state.reminders.some((x) => /car service/.test(x.text) && x.dueAt)).toBe(true);
  });

  it('answers a plain question', async () => {
    const { a } = withClaude(JSON.stringify({ commands: [], reply: 'About 20 minutes at 200°C.' }));
    const r = await a.handle({ text: 'how long do I roast broccoli for', now: NOW });
    expect(r.text).toBe('About 20 minutes at 200°C.');
  });
});
