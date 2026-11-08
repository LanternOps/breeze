import './setup';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExtensionStateStore,
  type ExtensionStateBackend,
  type ExtensionStateRecord,
  type ObservedExtensionInput,
} from '../../extensions/stateStore';
import {
  reconcileExtensionMigrations,
  extensionLockKey,
  type MigratableExtension,
} from '../../extensions/migrator';
import { MigrationLockTimeoutError } from '../../db/migrationAdvisoryLock';

/**
 * Real-Postgres proof of the guarantees the unit runner cannot express:
 *   1. atomic rollback — a migration file that fails mid-way leaves NO table and
 *      NO ledger row (the INSERT into breeze_migrations shares the file's tx).
 *   2. advisory-lock serialization — two callers contend for the SAME extension
 *      on DIFFERENT pooled connections, yet exactly ONE applies the migration
 *      set. A holder pre-takes the session advisory lock so both reconcilers
 *      provably find it taken (each logs a wait naming the holder's pid) before
 *      either can proceed — genuine contention, not accidental sequencing.
 *   3. bounded wait (#4144) — a holder that never lets go makes the reconciler
 *      give up at its deadline with the holder's pid, applying nothing.
 *
 * The migrator's state store is in-memory here: this file exercises the
 * migrator's transactional/lock behaviour against real Postgres, not the store's
 * RLS/system-scope behaviour (proven separately in Task 2).
 */

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

class InMemoryBackend implements ExtensionStateBackend {
  private readonly rows = new Map<string, ExtensionStateRecord>();
  private readonly floors = new Map<string, Map<string, string>>();
  async upsertObserved(input: ObservedExtensionInput): Promise<void> {
    if (!this.rows.has(input.name)) {
      this.rows.set(input.name, {
        name: input.name, configuredVersion: null, activeVersion: null,
        artifactDigest: null, publisherId: null, manifestApiVersion: null,
        serverSdkVersion: null, webSdkVersion: null, enabled: true,
        lifecycleState: 'discovered', lastErrorCategory: null, lastErrorMessage: null,
        migratedAt: null, activatedAt: null, updatedAt: new Date(),
      });
    }
  }
  async setEnabled(): Promise<void> {}
  async getRow(name: string): Promise<ExtensionStateRecord | null> {
    const r = this.rows.get(name);
    return r ? { ...r } : null;
  }
  async listRows(): Promise<ExtensionStateRecord[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async recordFailure(): Promise<void> {}
  async recordActive(name: string, activeVersion: string | null): Promise<void> {
    const r = this.rows.get(name);
    if (r && activeVersion !== null) r.activeVersion = activeVersion;
  }
  async insertSchemaFloor(name: string, version: string, floor: string): Promise<void> {
    let m = this.floors.get(name);
    if (!m) { m = new Map(); this.floors.set(name, m); }
    m.set(version, floor);
  }
  async listSchemaFloors(name: string): Promise<string[]> {
    return [...(this.floors.get(name)?.values() ?? [])];
  }
}

const EXT = 'demo';
const CONTENTION_TABLE = 'ext_contention_demo';
const ROLLBACK_TABLE_OK = 'demo_ok';

let pool: Sql;
let admin: Sql;

async function tableExists(name: string): Promise<boolean> {
  const rows = await admin`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
    ) AS present`;
  return rows[0]?.present === true;
}

async function ledgerContains(filename: string): Promise<boolean> {
  const rows = await admin`SELECT 1 FROM breeze_migrations WHERE filename = ${filename} LIMIT 1`;
  return rows.length > 0;
}

async function ledgerCount(filename: string): Promise<number> {
  const rows = await admin<{ n: number }[]>`
    SELECT count(*)::int AS n FROM breeze_migrations WHERE filename = ${filename}`;
  return rows[0]?.n ?? 0;
}

async function resetDemo(): Promise<void> {
  await admin`DELETE FROM breeze_migrations WHERE filename LIKE ${`${EXT}/%`}`;
  await admin`DELETE FROM extension_schema_history WHERE extension_name = ${EXT}`;
  await admin`DELETE FROM installed_extensions WHERE name = ${EXT}`;
  await admin.unsafe(`DROP TABLE IF EXISTS ${CONTENTION_TABLE}`);
  await admin.unsafe(`DROP TABLE IF EXISTS ${ROLLBACK_TABLE_OK}`);
}

beforeEach(async () => {
  pool = postgres(DATABASE_URL, { max: 4, onnotice: () => {} });
  admin = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  await resetDemo();
});

afterEach(async () => {
  await resetDemo();
  await pool.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

afterAll(async () => {
  // pools are per-test; nothing global to tear down here.
});

describe('reconcileExtensionMigrations against real Postgres', () => {
  it('rolls back the whole failing migration and does not record its ledger row', async () => {
    const store = new ExtensionStateStore(new InMemoryBackend());
    const extension: MigratableExtension = {
      name: EXT,
      version: '1.0.0',
      schemaCompatibilityFloor: '1.0.0',
      migrations: [{
        filename: '0001-test.sql',
        // First statement is valid; second has a syntax error. The whole file
        // runs in one client.begin, so the valid CREATE must roll back too.
        sql: 'CREATE TABLE demo_ok (id int);\nCREATE TABLE demo_bad (;',
      }],
    };

    let error: unknown;
    try {
      await reconcileExtensionMigrations(extension, pool, store, 'replace');
    } catch (e) {
      error = e;
    }

    expect(String((error as Error)?.message ?? error)).toMatch(/syntax/i);
    expect(await tableExists(ROLLBACK_TABLE_OK)).toBe(false);
    expect(await ledgerContains(`${EXT}/0001-test.sql`)).toBe(false);
  });

  it('serializes two concurrent callers so exactly one applies the migration set', async () => {
    const store = new ExtensionStateStore(new InMemoryBackend());
    const extension: MigratableExtension = {
      name: EXT,
      version: '1.0.0',
      schemaCompatibilityFloor: '1.0.0',
      // No IF NOT EXISTS: a second application would throw "already exists",
      // so a passing test genuinely proves the migration ran exactly once.
      migrations: [{ filename: '0001-contention.sql', sql: `CREATE TABLE ${CONTENTION_TABLE} (id int);` }],
    };

    // Hold the extension's advisory lock on a dedicated connection so both
    // reconcilers are forced to wait for it — deterministic contention.
    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    const lockKey = extensionLockKey(EXT);
    const firstLogger = { log: vi.fn(), warn: vi.fn() };
    const secondLogger = { log: vi.fn(), warn: vi.fn() };
    let bothWaited = false;
    try {
      const holderPid = Number((await holder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
      await holder`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;

      const lockWait = { timeoutMs: 20_000, pollIntervalMs: 25 };
      const first = reconcileExtensionMigrations(extension, pool, store, 'replace', { ...lockWait, logger: firstLogger });
      const second = reconcileExtensionMigrations(extension, pool, store, 'replace', { ...lockWait, logger: secondLogger });

      // Wait until BOTH reconcilers have tried the lock, found it held, and
      // named the holder. The wait is a bounded poll (#4144), so it shows up
      // in each reconciler's log rather than as a server-side lock wait.
      const waitedOnHolder = (logger: typeof firstLogger) =>
        logger.warn.mock.calls.some((c) => String(c[0]).includes(`held by backend pid ${holderPid}`));
      for (let attempt = 0; attempt < 600; attempt++) {
        if (waitedOnHolder(firstLogger) && waitedOnHolder(secondLogger)) { bothWaited = true; break; }
        await new Promise((r) => setTimeout(r, 25));
      }

      // Release the holder so the waiting reconcilers proceed one at a time.
      await holder`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;

      await expect(Promise.all([first, second])).resolves.toBeDefined();
    } finally {
      await holder.end({ timeout: 5 });
    }

    expect(bothWaited, 'both reconcilers must contend on the advisory lock').toBe(true);
    expect(await tableExists(CONTENTION_TABLE)).toBe(true);
    // Exactly ONE ledger row — the second caller saw it already applied.
    expect(await ledgerCount(`${EXT}/0001-contention.sql`)).toBe(1);
  });

  it('gives up at the deadline naming a holder that never releases, and applies nothing (#4144)', async () => {
    const store = new ExtensionStateStore(new InMemoryBackend());
    const extension: MigratableExtension = {
      name: EXT,
      version: '1.0.0',
      schemaCompatibilityFloor: '1.0.0',
      migrations: [{ filename: '0001-contention.sql', sql: `CREATE TABLE ${CONTENTION_TABLE} (id int);` }],
    };

    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    try {
      const holderPid = Number((await holder<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
      await holder`SELECT pg_advisory_lock(hashtextextended(${extensionLockKey(EXT)}, 0))`;

      const error = await reconcileExtensionMigrations(extension, pool, store, 'replace', {
        timeoutMs: 600,
        pollIntervalMs: 50,
        logger: { log: vi.fn(), warn: vi.fn() },
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MigrationLockTimeoutError);
      expect((error as MigrationLockTimeoutError).holderPid).toBe(holderPid);
      expect((error as Error).message).toContain('[extensions]');
    } finally {
      await holder.end({ timeout: 5 });
    }

    expect(await tableExists(CONTENTION_TABLE)).toBe(false);
    expect(await ledgerCount(`${EXT}/0001-contention.sql`)).toBe(0);
    expect(await store.highestSchemaFloor(EXT)).toBeNull();
    // The reserved connection went back to the pool: a fresh reconcile on the
    // same pool now runs to completion.
    await reconcileExtensionMigrations(extension, pool, store, 'replace', { timeoutMs: 5_000 });
    expect(await ledgerCount(`${EXT}/0001-contention.sql`)).toBe(1);
  });
});
