// Web Push: reminders reach the phone even when Brain Dump is closed.
// On iPhone this works for Brain Dump added to the Home Screen (iOS 16.4+).

import webpush from 'web-push';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  deviceId?: string;
  createdAt: string;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
}

/** 'gone' means the subscription is dead and should be forgotten. */
export type PushSender = (sub: PushSubscriptionRecord, payload: PushPayload) => Promise<'ok' | 'gone' | 'error'>;

export interface Vapid {
  publicKey: string;
  privateKey: string;
}

export async function loadVapid(dataDir: string, env: { publicKey?: string; privateKey?: string }): Promise<Vapid> {
  if (env.publicKey && env.privateKey) return { publicKey: env.publicKey, privateKey: env.privateKey };
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, 'vapid.json');
  if (existsSync(path)) return JSON.parse(await readFile(path, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  await writeFile(path, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}

export function webPushSender(vapid: Vapid, subject: string): PushSender {
  return async (sub, payload) => {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), {
        vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: 60 * 60,
        urgency: 'high',
      });
      return 'ok';
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      return status === 404 || status === 410 ? 'gone' : 'error';
    }
  };
}

export function isValidSubscription(x: any): x is { endpoint: string; keys: { p256dh: string; auth: string } } {
  return (
    !!x && typeof x.endpoint === 'string' && /^https:\/\//.test(x.endpoint) && x.endpoint.length < 1000 &&
    typeof x.keys?.p256dh === 'string' && typeof x.keys?.auth === 'string'
  );
}
