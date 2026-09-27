// Entry point: `npm start`.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { loadVapid, webPushSender } from './push.js';

const root = resolve(fileURLToPath(import.meta.url), '../../..');
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

const dataDir = process.env.DATA_DIR ?? resolve(root, 'data');
const publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || undefined;
const vapid = await loadVapid(dataDir, { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY });
const pushSubject = process.env.PUSH_CONTACT_EMAIL ? `mailto:${process.env.PUSH_CONTACT_EMAIL}` : publicUrl?.startsWith('https://') ? publicUrl : 'mailto:brain-dump@example.com';

const app = await createApp({
  dataDir,
  key: process.env.BRAIN_DUMP_KEY,
  webDir: process.env.WEB_DIR ?? resolve(root, 'web'),
  publicUrl,
  signupCode: process.env.INVITE_CODE || undefined,
  push: { publicKey: vapid.publicKey, send: webPushSender(vapid, pushSubject) },
  tickIntervalMs: 60_000,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  corsOrigins: process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean),
  integrations: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? { google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET } }
    : {},
});

app.server.listen(port, host, () => {
  console.log(`Brain Dump is listening on http://${host}:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
