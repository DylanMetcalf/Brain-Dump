import type { BookingProvider, BookingSlot, MessagingProvider, PurchaseProvider, EmailProvider } from '../src/core/providers.js';
import { HandoffMessaging } from '../src/core/providers.js';
import type { Contact, Draft } from '../src/core/types.js';
import { at } from './helpers.js';

export class MockPurchases implements PurchaseProvider {
  readonly id = 'mockshop';
  readonly label = 'Mock Shop';
  readonly capabilities = { write: true };
  orders: string[] = [];
  async find(q: string) {
    if (/laptop/.test(q)) return { id: 'p_laptop', name: 'ThinkBook 14 laptop', price: { amount: 1299, currency: 'GBP' } };
    return undefined;
  }
  async purchase(id: string) {
    this.orders.push(id);
    return { orderId: `ord_${this.orders.length}` };
  }
}

export class MockBookings implements BookingProvider {
  readonly id = 'mockbook';
  readonly label = 'Calm Spa';
  readonly capabilities = { write: true };
  booked: string[] = [];
  async findServices(q: string) {
    return /massage/.test(q) ? [{ id: 'svc_massage', name: 'Calm Spa', provider: 'mockbook' }] : [];
  }
  async availability(_id: string, from: Date, to: Date): Promise<BookingSlot[]> {
    const slots: BookingSlot[] = [
      { id: 's1', start: at(9, 30, 14), end: at(9, 30, 15) },
      { id: 's2', start: at(9, 30, 16), end: at(9, 30, 17) },
      { id: 's3', start: at(9, 30, 10), end: at(9, 30, 11) },
    ];
    return slots.filter((s) => s.start >= from && s.start < to);
  }
  async book(_svc: string, slotId: string) {
    this.booked.push(slotId);
    const s = (await this.availability('', new Date(0), new Date(8e15))).find((x) => x.id === slotId)!;
    return { confirmation: `CONF-${slotId}`, start: s.start, end: s.end };
  }
}

/** A messaging provider that can really send (e.g. an official business API) — for trust tests. */
export class SendingMessaging implements MessagingProvider {
  readonly id = 'sender';
  readonly label = 'Messages';
  readonly capabilities = { write: true, send: true };
  sent: { to: string; body: string }[] = [];
  handoffUrl(d: Draft, c: Contact) {
    return new HandoffMessaging().handoffUrl(d, c);
  }
  async send(d: Draft, c: Contact) {
    this.sent.push({ to: c.name, body: d.body });
    return { id: `m${this.sent.length}` };
  }
}

export type { EmailProvider };
