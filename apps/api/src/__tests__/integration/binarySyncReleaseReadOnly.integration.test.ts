import crypto from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * #11741 ("Also noted"): BINARY_SOURCE=github. The boot-time release sync is
 * non-fatal, so a database a provider switched to
 * `default_transaction_read_only = on` did not crash the API, but the sync's
 * refused writes were logged once and never retried: the release stayed
 * unregistered until the next restart. Boot now defers it (the deferral
 * BINARY_SOURCE=local already uses) and registers the release once the
 * database accepts writes.
 *
 * One disposable database, fully migrated by the real `autoMigrate()`. The
 * GitHub release lookup is stubbed (one agent asset, a checksums.txt) so the
 * test needs no network; every database read and write is real. Each
 * read-only phase loads a FRESH `../../db` module so its pool opens sessions
 * that pick up the read-only default, the way a restarted API would.
 */

const BASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP
  ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
const TAG = 'v0.128.0';
const CHECKSUM = 'b'.repeat(64);
const ASSET_BASE = `https://github.com/example/breeze/releases/download/${TAG}`;

const release = vi.hoisted(() => ({ lookups: 0 }));

vi.mock('../../services/urlSafety', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/urlSafety')>()),
  safeFetchFollowingRedirects: vi.fn(async (url: string) => {
    if (url.endsWith('/checksums.txt')) {
      return new Response(`${CHECKSUM}  breeze-agent-linux-amd64\n`, { status: 200 });
    }
    release.lookups += 1;
    return new Response(
      JSON.stringify({
        tag_name: TAG,
        assets: [
          { name: 'checksums.txt', browser_download_url: `${ASSET_BASE}/checksums.txt`, size: 100 },
          { name: 'breeze-agent-linux-amd64', browser_download_url: `${ASSET_BASE}/breeze-agent-linux-amd64`, size: 4096 },
        ],
      }),
      { status: 200 },
    );
  }),
}));

type BinarySyncModule = typeof import('../../services/binarySync');
type DbModule = typeof import('../../db');

let admin: Sql;
let databaseName: string;
const savedEnv: Record<string, string | undefined> = {};
let currentDb: DbModule | null = null;

function scratch(url: string): string {
  const u = new URL(url);
  u.pathname = `/${databaseName}`;
  return u.toString();
}

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function freshModules(): Promise<{ db: DbModule; binarySync: BinarySyncModule }> {
  if (currentDb) await currentDb.closeDb();
  vi.resetModules();
  const db = (await import('../../db')) as DbModule;
  currentDb = db;
  const binarySync = (await import('../../services/binarySync')) as BinarySyncModule;
  return { db, binarySync };
}

async function setReadOnly(on: boolean): Promise<void> {
  await admin.unsafe(
    on
      ? `ALTER DATABASE "${databaseName}" SET default_transaction_read_only = on`
      : `ALTER DATABASE "${databaseName}" RESET default_transaction_read_only`,
  );
}

async function releaseRows(): Promise<Array<{ component: string; platform: string; architecture: string; checksum: string }>> {
  const reader = postgres(scratch(BASE_URL), { max: 1, onnotice: () => {} });
  try {
    return await reader<Array<{ component: string; platform: string; architecture: string; checksum: string }>>`
      SELECT component, platform, architecture, checksum FROM agent_versions
      WHERE version = ${TAG.slice(1)} ORDER BY component, platform, architecture`;
  } finally {
    await reader.end({ timeout: 5 });
  }
}

/** Boot's sync exactly as index.ts runs it in github mode: non-fatal, failure handed on. */
async function bootSync(binarySync: BinarySyncModule): Promise<{ threw: boolean; retryPending: boolean }> {
  try {
    await binarySync.syncBinaries();
    return { threw: false, retryPending: false };
  } catch (err) {
    return { threw: true, retryPending: binarySync.scheduleGithubSyncRetry(err) };
  }
}

beforeAll(async () => {
  admin = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  databaseName = `breeze_test_ro_ghsync_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);

  setEnv({
    DATABASE_URL: scratch(BASE_URL),
    DATABASE_URL_APP: scratch(APP_URL),
    BINARY_SOURCE: 'github',
    BINARY_VERSION: TAG.slice(1),
    BREEZE_VERSION: undefined,
    APP_VERSION: undefined,
    BREEZE_BINARIES_VERSION: undefined,
    BINARY_EDITION: undefined,
    APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex'),
  });

  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.resetModules();
  const { autoMigrate } = await import('../../db/autoMigrate');
  await autoMigrate();
}, 300_000);

afterAll(async () => {
  vi.restoreAllMocks();
  if (currentDb) await currentDb.closeDb().catch(() => {});
  currentDb = null;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
}, 60_000);

describe('BINARY_SOURCE=github boot sync against a read-only database (#11741)', () => {
  it('defers the sync, keeps booting, and registers the release once the database is writable', async () => {
    expect(await releaseRows()).toEqual([]);
    await setReadOnly(true);
    let binarySync: BinarySyncModule;
    try {
      ({ binarySync } = await freshModules());
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const boot = await bootSync(binarySync);

      // Non-fatal as before, but now deferred rather than dropped.
      expect(boot).toEqual({ threw: true, retryPending: true });
      expect(binarySync.isBinarySyncDeferred()).toBe(true);
      expect(binarySync.isGithubSyncRetryPending()).toBe(false);
      expect(await releaseRows()).toEqual([]);
      const deferred = warn.mock.calls.map((c) => String(c[0])).filter((l) => /registration deferred/.test(l));
      expect(deferred).toHaveLength(1);
      expect(deferred[0]).toMatch(/read-only/);

      // Still read-only: a retry only probes, and leaves the work pending.
      const lookups = release.lookups;
      await binarySync.retryDeferredBinarySync();
      expect(binarySync.isBinarySyncDeferred()).toBe(true);
      expect(release.lookups).toBe(lookups);
      warn.mockRestore();
      error.mockRestore();
    } finally {
      await setReadOnly(false);
    }

    // Writable again. Sessions opened while it was read-only keep that default
    // until they reconnect (readOnlySessionRecovery recycles them in a running
    // API), so end them before the retry.
    await admin`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = ${databaseName} AND pid <> pg_backend_pid()`;

    await binarySync!.retryDeferredBinarySync();

    expect(binarySync!.isBinarySyncDeferred()).toBe(false);
    expect(await releaseRows()).toEqual([
      { component: 'agent', platform: 'linux', architecture: 'amd64', checksum: CHECKSUM },
    ]);
    binarySync!.stopDeferredBinarySyncRetry();
    binarySync!.stopGithubSyncRetry();
  });
});
