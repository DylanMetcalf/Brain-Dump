// Entry point: `npm start`.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const root = resolve(fileURLToPath(import.meta.url), '../../..');
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

const app = await createApp({
  dataDir: process.env.DATA_DIR ?? resolve(root, 'data'),
  key: process.env.BRAIN_DUMP_KEY,
  webDir: process.env.WEB_DIR ?? resolve(root, 'web'),
  publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${port}`,
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
