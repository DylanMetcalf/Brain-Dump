// Encrypted, per-user document store with serialised access and atomic writes.
// One encrypted file per user (state), one for their integration secrets, and an
// encrypted account index mapping hashed device tokens to users.

import { mkdir, readFile, rename, rm, writeFile, readdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { decrypt, encrypt } from './crypto.js';
import { createUserState, migrateState } from '../core/state.js';
import type { UserState } from '../core/types.js';

export interface DeviceRecord {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
}

interface AccountIndex {
  devices: DeviceRecord[];
  /** Read-only calendar feed tokens (hashed). */
  feeds: { tokenHash: string; userId: string; createdAt: string }[];
  /** Backup codes (hashed) that let a user sign in on a new device. One per user. */
  recovery?: { codeHash: string; userId: string; createdAt: string }[];
}

export async function loadOrCreateKey(dataDir: string, envKey?: string): Promise<Buffer> {
  if (envKey) {
    if (/^[0-9a-f]{64}$/i.test(envKey)) return Buffer.from(envKey, 'hex');
    const b = Buffer.from(envKey, 'base64');
    if (b.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(envKey)) return b;
    // Any other secret (e.g. a host-generated random string) is stretched into a 32-byte key.
    if (envKey.length < 24) throw new Error('BRAIN_DUMP_KEY is too short — use at least 24 random characters.');
    return createHash('sha256').update(envKey).digest();
  }
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, '.key');
  if (existsSync(path)) return Buffer.from((await readFile(path, 'utf8')).trim(), 'base64');
  const k = randomBytes(32);
  await writeFile(path, k.toString('base64'), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return k;
}

export class Store {
  private cache = new Map<string, UserState>();
  private chains = new Map<string, Promise<unknown>>();
  private index: AccountIndex = { devices: [], feeds: [] };
  private indexChain: Promise<unknown> = Promise.resolve();

  constructor(private dir: string, private key: Buffer) {}

  async init(): Promise<void> {
    await mkdir(join(this.dir, 'users'), { recursive: true });
    const p = join(this.dir, 'accounts.enc');
    if (existsSync(p)) this.index = JSON.parse(decrypt(await readFile(p, 'utf8'), this.key));
  }

  private async atomicWrite(path: string, data: string) {
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  }

  private userPath(userId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(userId)) throw new Error('bad user id');
    return join(this.dir, 'users', `${userId}.enc`);
  }

  private secretsPath(userId: string) {
    return this.userPath(userId).replace(/\.enc$/, '.secrets.enc');
  }

  // ---- accounts ----------------------------------------------------------------

  get devices(): readonly DeviceRecord[] {
    return this.index.devices;
  }

  get feeds() {
    return this.index.feeds;
  }

  get recovery() {
    return this.index.recovery ?? [];
  }

  async mutateIndex(fn: (idx: AccountIndex) => void): Promise<void> {
    const run = this.indexChain.then(async () => {
      fn(this.index);
      await this.atomicWrite(join(this.dir, 'accounts.enc'), encrypt(JSON.stringify(this.index), this.key));
    });
    this.indexChain = run.catch(() => undefined);
    await run;
  }

  userIds(): string[] {
    return [...new Set(this.index.devices.map((d) => d.userId))];
  }

  // ---- user documents --------------------------------------------------------------

  async read(userId: string): Promise<UserState> {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    const p = this.userPath(userId);
    if (!existsSync(p)) throw new Error('user not found');
    const state = migrateState(JSON.parse(decrypt(await readFile(p, 'utf8'), this.key)));
    this.cache.set(userId, state);
    return state;
  }

  async create(userId: string, timeZone: string, now: Date): Promise<UserState> {
    const state = createUserState(userId, timeZone, now);
    this.cache.set(userId, state);
    await this.atomicWrite(this.userPath(userId), encrypt(JSON.stringify(state), this.key));
    return state;
  }

  /**
   * Serialise all work on one user's document. The callback mutates state in place;
   * the document is persisted when its version changed (or when force is set).
   */
  async withUser<T>(userId: string, fn: (state: UserState) => Promise<T>, opts: { force?: boolean } = {}): Promise<T> {
    const prev = this.chains.get(userId) ?? Promise.resolve();
    const run = prev.then(async () => {
      const state = await this.read(userId);
      const before = state.version;
      const snapshot = JSON.stringify(state);
      try {
        const result = await fn(state);
        if (opts.force || state.version !== before) {
          await this.atomicWrite(this.userPath(userId), encrypt(JSON.stringify(state), this.key));
        }
        return result;
      } catch (err) {
        // Roll back in-memory changes from a failed operation.
        this.cache.set(userId, migrateState(JSON.parse(snapshot)));
        throw err;
      }
    });
    this.chains.set(userId, run.catch(() => undefined));
    return run;
  }

  async deleteUser(userId: string): Promise<void> {
    await this.withUser(userId, async () => undefined).catch(() => undefined);
    this.cache.delete(userId);
    await rm(this.userPath(userId), { force: true });
    await rm(this.secretsPath(userId), { force: true });
    await this.mutateIndex((idx) => {
      idx.devices = idx.devices.filter((d) => d.userId !== userId);
      idx.feeds = idx.feeds.filter((f) => f.userId !== userId);
      idx.recovery = (idx.recovery ?? []).filter((r) => r.userId !== userId);
    });
  }

  // ---- secrets (OAuth tokens) — never sent to clients --------------------------------

  async readSecrets(userId: string): Promise<Record<string, any>> {
    const p = this.secretsPath(userId);
    if (!existsSync(p)) return {};
    return JSON.parse(decrypt(await readFile(p, 'utf8'), this.key));
  }

  async writeSecrets(userId: string, secrets: Record<string, any>): Promise<void> {
    await this.atomicWrite(this.secretsPath(userId), encrypt(JSON.stringify(secrets), this.key));
  }

  /** For tests and diagnostics: raw files on disk must not contain plaintext. */
  async rawFiles(): Promise<string[]> {
    const files = await readdir(join(this.dir, 'users'));
    return Promise.all(files.map((f) => readFile(join(this.dir, 'users', f), 'utf8')));
  }
}
