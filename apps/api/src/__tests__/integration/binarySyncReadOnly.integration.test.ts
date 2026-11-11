import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * #11731, hosted shape: BINARY_SOURCE=local. After a provider switched Postgres
 * to `default_transaction_read_only = on`, the API must survive every boot
 * step that touches the database, not only autoMigrate. In local mode
 * `syncBinaries()` failing is fatal at boot (index.ts), and it used to
 * re-register every binary in the volume (a demote UPDATE plus an upsert) on
 * every boot, so a read-only database crash-looped the API even though
 * nothing had changed.
 *
 * One disposable database, fully migrated by the real `autoMigrate()` and
 * seeded, then registered once while writable (a normal first boot). Each
 * read-only phase then loads a FRESH `../../db` module (vi.resetModules), so
 * its pool opens new sessions that pick up the database's read-only default,
 * the way a restarted API would.
 */

const BASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
const APP_URL = process.env.DATABASE_URL_APP
  ?? 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
const VERSION = '0.128.0';

type BinarySyncModule = typeof import('../../services/binarySync');
type DbModule = typeof import('../../db');

let admin: Sql;
let databaseName: string;
let binDir: string;
const savedEnv: Record<string, string | undefined> = {};
let currentDb: DbModule | null = null;

function scratch(url: string): string {
  const u = new URL(url);
  u.pathname = `/${databaseName}`;
  return u.toString();
}

function setEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
}

/** Fresh module graph bound to the scratch database (a restarted process). */
async function freshModules(): Promise<{ db: DbModule; binarySync: BinarySyncModule }> {
  if (currentDb) await currentDb.closeDb();
  vi.resetModules();
  const db = (await import('../../db')) as DbModule;
  currentDb = db;
  const binarySync = (await import('../../services/binarySync')) as BinarySyncModule;
  return { db, binarySync };
}

async function writeBinary(name: string): Promise<void> {
  await writeFile(path.join(binDir, name), crypto.randomBytes(256));
}

async function setReadOnly(on: boolean): Promise<void> {
  await admin.unsafe(
    on
      ? `ALTER DATABASE "${databaseName}" SET default_transaction_read_only = on`
      : `ALTER DATABASE "${databaseName}" RESET default_transaction_read_only`,
  );
}

/** Every agent_versions row, for "nothing was written" comparisons. */
async function agentVersionRows(): Promise<string> {
  const reader = postgres(scratch(BASE_URL), { max: 1, onnotice: () => {} });
  try {
    const rows = await reader`
      SELECT id, version, component, platform, architecture, edition, checksum, is_latest,
             download_url, file_size::text AS file_size, release_manifest, manifest_signature,
             signing_key_id, created_at::text AS created_at
      FROM agent_versions ORDER BY component, platform, architecture, edition`;
    return JSON.stringify(rows);
  } finally {
    await reader.end({ timeout: 5 });
  }
}

/**
 * The database-touching boot steps index.ts runs for an api-role process in
 * local mode, in order: database startup (preflight, migrate, version record),
 * binary sync (fatal on throw in local mode), manifest signing self-test
 * (runs whenever the deployment signs its own manifests, which local mode does).
 */
async function bootDatabaseSteps(binarySync: BinarySyncModule, logger: Pick<Console, 'log' | 'warn' | 'error'>): Promise<void> {
  const { initializeDatabaseForStartup } = await import('../../db/databaseStartup');
  await initializeDatabaseForStartup({
    autoMigrateEnabled: true,
    production: true,
    upgradeChecks: true,
    env: { ...process.env, APP_VERSION: VERSION },
    logger,
  });
  await binarySync.syncBinaries();
  const { runManifestSelfTest } = await import('../../services/binarySync.selftest');
  const { withSystemDbAccessContext } = await import('../../db');
  await withSystemDbAccessContext(() => runManifestSelfTest());
}

beforeAll(async () => {
  admin = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  databaseName = `breeze_test_ro_binsync_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);

  binDir = await mkdtemp(path.join(tmpdir(), 'breeze-ro-binsync-'));
  const versionFile = path.join(binDir, 'VERSION');
  await writeFile(versionFile, `${VERSION}\n`);
  await writeBinary('breeze-agent-linux-amd64');
  await writeBinary('breeze-agent-windows-amd64.exe');
  await writeBinary('breeze-backup-linux-amd64');
  await writeBinary('breeze-backup-windows-amd64.exe');

  setEnv({
    DATABASE_URL: scratch(BASE_URL),
    DATABASE_URL_APP: scratch(APP_URL),
    BINARY_SOURCE: 'local',
    AGENT_BINARY_DIR: binDir,
    HELPER_BINARY_DIR: binDir,
    BINARY_VERSION_FILE: versionFile,
    BREEZE_VERSION: VERSION,
    APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex'),
  });
  delete process.env.APP_VERSION;

  vi.spyOn(console, 'log').mockImplementation(() => {});

  // First (writable) boot: full migration + seed, then the binaries register.
  vi.resetModules();
  const { autoMigrate } = await import('../../db/autoMigrate');
  await autoMigrate();
  const first = await freshModules();
  await first.binarySync.syncBinaries();
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
  await rm(binDir, { recursive: true, force: true });
}, 60_000);

describe('BINARY_SOURCE=local boot against a read-only database (#11731)', () => {
  it('boots with everything already registered and writes nothing', async () => {
    const before = await agentVersionRows();
    expect(JSON.parse(before).length).toBeGreaterThan(0);
    await setReadOnly(true);
    try {
      const { binarySync } = await freshModules();
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const warn = vi.spyOn(console, 'warn');

      await expect(bootDatabaseSteps(binarySync, logger)).resolves.toBeUndefined();

      expect(await agentVersionRows()).toBe(before);
      expect(binarySync.isBinarySyncDeferred()).toBe(false);
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => /deferred/.test(l))).toEqual([]);
      warn.mockRestore();
    } finally {
      await setReadOnly(false);
    }
  });

  it('defers a registration that needs a write, keeps booting, and completes it once the database is writable', async () => {
    await writeBinary('breeze-agent-darwin-arm64');
    const before = await agentVersionRows();
    await setReadOnly(true);
    let binarySync: BinarySyncModule;
    try {
      ({ binarySync } = await freshModules());
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const warn = vi.spyOn(console, 'warn');

      await expect(bootDatabaseSteps(binarySync, logger)).resolves.toBeUndefined();

      expect(await agentVersionRows()).toBe(before);
      expect(binarySync.isBinarySyncDeferred()).toBe(true);
      const deferred = warn.mock.calls.map((c) => String(c[0])).filter((l) => /deferred/.test(l));
      expect(deferred).toHaveLength(1);
      expect(deferred[0]).toMatch(/read-only/);

      // Still read-only: a retry stays quiet and leaves the work pending.
      await binarySync.retryDeferredBinarySync();
      expect(binarySync.isBinarySyncDeferred()).toBe(true);
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => /deferred/.test(l))).toHaveLength(1);
      warn.mockRestore();
    } finally {
      await setReadOnly(false);
    }

    // The database is writable again. Sessions opened while it was read-only
    // keep that default until they reconnect, so end them (as pool recycling
    // eventually would) before the retry.
    await admin`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = ${databaseName} AND pid <> pg_backend_pid()`;

    await binarySync!.retryDeferredBinarySync();

    expect(binarySync!.isBinarySyncDeferred()).toBe(false);
    const after = JSON.parse(await agentVersionRows()) as Array<{ platform: string; component: string }>;
    expect(after.some((r) => r.component === 'agent' && r.platform === 'macos')).toBe(true);
    binarySync!.stopDeferredBinarySyncRetry();
  });
});
