import type postgres from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExtensionStateStore,
  type ExtensionStateBackend,
  type ExtensionStateRecord,
  type ObservedExtensionInput,
} from './stateStore';
import type { ExtensionLifecycleState } from '../db/schema/extensions';
import {
  checkExtensionMigrationParity,
  reconcileExtensionMigrations,
  type MigratableExtension,
} from './migrator';
import { hashSql } from '../db/autoMigrate';
import { MigrationLockTimeoutError } from '../db/migrationAdvisoryLock';

/**
 * Unit-runner tests (NO database). Only behaviour that decides WHETHER to touch
 * the database is exercised here:
 *   - dangerous-statement rejection (pure, before any lock/SQL)
 *   - the rollback-refusal and rolling-update gates (pure, read only the store)
 *
 * The genuinely transactional guarantees — atomic rollback with no ledger row,
 * and single-application under advisory-lock contention — require real Postgres
 * DDL and live in `__tests__/integration/extensionMigrator.integration.test.ts`
 * (the unit runner has no DB; see apps/api/vitest.config.ts).
 */

// Minimal in-memory state backend mirroring the Drizzle backend's semantics,
// used only to drive the gate decisions.
class InMemoryBackend implements ExtensionStateBackend {
  private readonly rows = new Map<string, ExtensionStateRecord>();
  private readonly floors = new Map<string, Map<string, string>>();

  async upsertObserved(input: ObservedExtensionInput): Promise<void> {
    if (!this.rows.has(input.name)) {
      this.rows.set(input.name, {
        name: input.name,
        configuredVersion: input.configuredVersion ?? null,
        activeVersion: input.activeVersion ?? null,
        artifactDigest: input.digest ?? null,
        publisherId: input.publisher ?? null,
        manifestApiVersion: null,
        serverSdkVersion: null,
        webSdkVersion: null,
        enabled: true,
        lifecycleState: 'discovered',
        lastErrorCategory: null,
        lastErrorMessage: null,
        migratedAt: null,
        activatedAt: null,
        updatedAt: new Date(),
      });
    }
  }

  async setEnabled(): Promise<void> {}

  async getRow(name: string): Promise<ExtensionStateRecord | null> {
    const row = this.rows.get(name);
    return row ? { ...row } : null;
  }

  async listRows(): Promise<ExtensionStateRecord[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async recordFailure(): Promise<void> {}

  async recordActive(name: string, activeVersion: string | null): Promise<void> {
    const row = this.rows.get(name);
    if (!row) return;
    row.lifecycleState = 'active' as ExtensionLifecycleState;
    if (activeVersion !== null) row.activeVersion = activeVersion;
  }

  async insertSchemaFloor(name: string, version: string, floor: string): Promise<void> {
    let byVersion = this.floors.get(name);
    if (!byVersion) {
      byVersion = new Map();
      this.floors.set(name, byVersion);
    }
    byVersion.set(version, floor);
  }

  async listSchemaFloors(name: string): Promise<string[]> {
    return [...(this.floors.get(name)?.values() ?? [])];
  }
}

// A postgres.Sql that throws the instant it is touched — proves the gate/
// validation logic short-circuits before ANY database work.
const failingSql = new Proxy(function noop() {}, {
  get() {
    throw new Error('reconcile touched the database before passing its gates');
  },
  apply() {
    throw new Error('reconcile touched the database before passing its gates');
  },
}) as unknown as postgres.Sql;

function migratable(overrides: Partial<MigratableExtension> = {}): MigratableExtension {
  return {
    name: 'demo',
    version: '2.0.0',
    schemaCompatibilityFloor: '1.0.0',
    migrations: [{ filename: '0001-test.sql', sql: 'CREATE TABLE demo_x (id int);' }],
    ...overrides,
  };
}

describe('reconcileExtensionMigrations — gates and validation (no DB)', () => {
  let store: ExtensionStateStore;

  beforeEach(() => {
    store = new ExtensionStateStore(new InMemoryBackend());
  });

  it('refuses rolling migration when the new floor excludes the active version', async () => {
    await store.upsertObserved({ name: 'demo', configuredVersion: '1.4.0' });
    await store.recordActive('demo', '1.4.0');

    await expect(
      reconcileExtensionMigrations(
        migratable({ version: '2.0.0', schemaCompatibilityFloor: '1.5.0' }),
        failingSql,
        store,
        'rolling',
      ),
    ).rejects.toThrow(/non-rolling/);
  });

  it('allows the same forward bundle under an explicit replace rollout', async () => {
    await store.upsertObserved({ name: 'demo', configuredVersion: '1.4.0' });
    await store.recordActive('demo', '1.4.0');

    // Under 'replace' the rolling gate does not apply, so reconcile proceeds
    // past the gates and reaches the DB — which our failing sql surfaces. The
    // point is only that it is NOT rejected with /non-rolling/.
    await expect(
      reconcileExtensionMigrations(
        migratable({ version: '2.0.0', schemaCompatibilityFloor: '1.5.0' }),
        failingSql,
        store,
        'replace',
      ),
    ).rejects.toThrow(/database/);
  });

  it('refuses a code rollback below the highest recorded schema floor', async () => {
    await store.recordSchemaFloor('demo', '2.0.0', '2.0.0');

    await expect(
      reconcileExtensionMigrations(
        migratable({ version: '1.0.0' }),
        failingSql,
        store,
        'replace',
      ),
    ).rejects.toThrow(/rollback|older/i);
  });

  it.each([
    ['-- @no-transaction directive', '-- @no-transaction\nCREATE INDEX x ON demo_x (id);'],
    ['CREATE INDEX CONCURRENTLY', 'CREATE INDEX CONCURRENTLY x ON demo_x (id);'],
    ['REINDEX CONCURRENTLY', 'REINDEX INDEX CONCURRENTLY x;'],
    ['VACUUM', 'VACUUM demo_x;'],
    ['a BEGIN transaction-control statement', 'BEGIN; CREATE TABLE demo_x (id int); COMMIT;'],
  ])('rejects a migration containing %s before any DB work', async (_label, sql) => {
    await expect(
      reconcileExtensionMigrations(
        migratable({ migrations: [{ filename: '0001-test.sql', sql }] }),
        failingSql,
        store,
        'replace',
      ),
    ).rejects.toThrow(/not permitted|must not|transaction/i);
  });
});

/**
 * Lock wiring (#4144 item 5): the per-extension advisory lock is a BOUNDED
 * non-blocking try, so a wedged holder fails the boot with a named holder
 * instead of hanging it. A fake reserved connection is enough to prove the
 * wiring — the real-Postgres contention case is in
 * `__tests__/integration/extensionMigrator.integration.test.ts`.
 */
describe('reconcileExtensionMigrations — bounded advisory lock (no DB)', () => {
  function fakePool(tryResult: boolean) {
    const calls: string[] = [];
    const reserved = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join('?');
        calls.push(`${text} | ${JSON.stringify(values)}`);
        if (text.includes('pg_try_advisory_lock(')) return [{ locked: tryResult }];
        if (text.includes('pg_locks')) {
          return [{ pid: 777, application_name: '', client_addr: null, state: 'active', backend_start: null }];
        }
        return [];
      },
      {
        unsafe: async (query: string) => {
          calls.push(query);
          return [];
        },
        release: vi.fn(),
      },
    );
    const sql = { reserve: async () => reserved } as unknown as postgres.Sql;
    return { sql, calls, reserved };
  }

  it('times out naming the holder, releases the reserved connection, and applies nothing', async () => {
    const store = new ExtensionStateStore(new InMemoryBackend());
    const { sql, calls, reserved } = fakePool(false);
    const logger = { log: vi.fn(), warn: vi.fn() };

    const error = await reconcileExtensionMigrations(migratable(), sql, store, 'replace', {
      timeoutMs: 40,
      pollIntervalMs: 10,
      logger,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MigrationLockTimeoutError);
    expect((error as MigrationLockTimeoutError).lockKey).toBe('breeze-extension:demo');
    expect((error as Error).message).toContain('pid 777');
    expect(reserved.release).toHaveBeenCalledTimes(1);
    // Never acquired → nothing applied, and no unlock of a lock it never held.
    expect(calls.some((c) => c === 'BEGIN')).toBe(false);
    expect(calls.some((c) => c.includes('pg_advisory_unlock('))).toBe(false);
    expect(calls.some((c) => /\bpg_advisory_lock\(/.test(c))).toBe(false);
    expect(await store.highestSchemaFloor('demo')).toBeNull();
  });

  it('takes the lock with a non-blocking try, applies the file, then unlocks', async () => {
    const store = new ExtensionStateStore(new InMemoryBackend());
    const { sql, calls, reserved } = fakePool(true);

    await reconcileExtensionMigrations(migratable(), sql, store, 'replace', {
      timeoutMs: 1_000,
      logger: { log: vi.fn(), warn: vi.fn() },
    });

    const tryAt = calls.findIndex((c) => c.includes('pg_try_advisory_lock(') && c.includes('breeze-extension:demo'));
    const beginAt = calls.indexOf('BEGIN');
    const unlockAt = calls.findIndex((c) => c.includes('pg_advisory_unlock(') && c.includes('breeze-extension:demo'));
    expect(tryAt).toBe(0);
    expect(beginAt).toBeGreaterThan(tryAt);
    expect(unlockAt).toBeGreaterThan(beginAt);
    expect(calls.some((c) => /\bpg_advisory_lock\(/.test(c))).toBe(false);
    expect(reserved.release).toHaveBeenCalledTimes(1);
  });
});

/**
 * `checkExtensionMigrationParity` — the `mode: 'worker'` read-only
 * counterpart to `reconcileExtensionMigrations` (wave 3.5d-b, #4086). Unlike
 * that function, this one takes no lock and runs no transaction — it is a
 * single `SELECT`, so a minimal fake exposing just `.unsafe()` is enough
 * (no need for the integration suite's real Postgres).
 */
describe('checkExtensionMigrationParity', () => {
  function fakeSql(rows: Array<{ filename: string; checksum: string }>): postgres.Sql {
    return { unsafe: async () => rows } as unknown as postgres.Sql;
  }

  const fileA = { filename: '0001-init.sql', sql: 'CREATE TABLE demo_x (id int);' };
  const fileB = { filename: '0002-add-column.sql', sql: 'ALTER TABLE demo_x ADD COLUMN y int;' };

  it('reports no missing/mismatched entries when the ledger fully matches', async () => {
    const sql = fakeSql([
      { filename: 'demo/0001-init.sql', checksum: hashSql(fileA.sql) },
      { filename: 'demo/0002-add-column.sql', checksum: hashSql(fileB.sql) },
    ]);

    const result = await checkExtensionMigrationParity({ name: 'demo', migrations: [fileA, fileB] }, sql);

    expect(result).toEqual({ missing: [], mismatched: [] });
  });

  it('reports a file absent from the ledger as missing', async () => {
    const sql = fakeSql([{ filename: 'demo/0001-init.sql', checksum: hashSql(fileA.sql) }]);

    const result = await checkExtensionMigrationParity({ name: 'demo', migrations: [fileA, fileB] }, sql);

    expect(result.missing).toEqual(['demo/0002-add-column.sql']);
    expect(result.mismatched).toEqual([]);
  });

  it('reports a present file whose checksum no longer matches as mismatched', async () => {
    const sql = fakeSql([
      { filename: 'demo/0001-init.sql', checksum: 'stale-checksum-from-a-different-file-content' },
    ]);

    const result = await checkExtensionMigrationParity({ name: 'demo', migrations: [fileA] }, sql);

    expect(result.missing).toEqual([]);
    expect(result.mismatched).toEqual(['demo/0001-init.sql']);
  });

  it('reports empty parity for an extension with no on-disk migrations', async () => {
    const sql = fakeSql([]);

    const result = await checkExtensionMigrationParity({ name: 'demo', migrations: [] }, sql);

    expect(result).toEqual({ missing: [], mismatched: [] });
  });
});
