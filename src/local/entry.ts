// Entry point for the single-file phone test build (`npm run build:phone`).
import { LocalServer } from './router.js';

const server = new LocalServer();
(window as any).BRAIN_DUMP_LOCAL = server;
