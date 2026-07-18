import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type postgres from 'postgres';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ExtensionStateStore,
  type ExtensionStateBackend,
  type ExtensionStateRecord,
  type ObservedExtensionInput,
} from './stateStore';
import type { ExtensionLifecycleState } from '../db/schema/extensions';
import {
  reconcileExtensionMigrations,
  readBundleMigrations,
  type MigratableExtension,
} from './migrator';

/**
 * Unit-runner tests (NO database). Only behaviour that decides WHETHER to touch
 * the database is exercised here:
 *   - dangerous-statement rejection (pure, before any lock/SQL)
 *   - the rollback-refusal and rolling-update gates (pure, read only the store)
 *   - the bundle→migration-file seam (reads a plain zip archive, no DB)
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

describe('readBundleMigrations — bundle→migration-file seam (no DB)', () => {
  /** Write a zip to a temp dir and return its path plus the verifier-style hash map. */
  async function writeArchive(
    members: Record<string, string>,
  ): Promise<{ archivePath: string; files: Map<string, { sha256: string; uncompressedSize: number }> }> {
    const zip = new JSZip();
    const files = new Map<string, { sha256: string; uncompressedSize: number }>();
    for (const [name, body] of Object.entries(members)) {
      zip.file(name, body);
      const bytes = Buffer.from(body, 'utf8');
      files.set(name, {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        uncompressedSize: bytes.length,
      });
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const dir = mkdtempSync(path.join(tmpdir(), 'bundle-mig-'));
    const archivePath = path.join(dir, 'demo.breeze-ext');
    writeFileSync(archivePath, buf);
    return { archivePath, files };
  }

  const MEMBERS = {
    'manifest.json': '{}',
    'server/index.js': 'exports.x = 1;',
    'migrations/0002-second.sql': 'CREATE TABLE b (id int);',
    'migrations/0001-first.sql': 'CREATE TABLE a (id int);',
    'migrations/notes.txt': 'ignore me',
  };

  it('reads sorted migrations/*.sql members from the bundle archive', async () => {
    const { archivePath, files } = await writeArchive(MEMBERS);

    const read = await readBundleMigrations({
      archivePath,
      files,
      manifest: { migrationsDir: 'migrations' } as never,
    });

    expect(read.map((f) => f.filename)).toEqual(['0001-first.sql', '0002-second.sql']);
    expect(read[0]?.sql).toContain('CREATE TABLE a');
    expect(read[1]?.sql).toContain('CREATE TABLE b');
  });

  // TIME-OF-CHECK/TIME-OF-USE: verifyExtensionBundle hashes members through one
  // handle and closes it; this re-opens the same path. If the archive is swapped
  // in between (anyone with write access to the artifact-store volume), trusting
  // the fresh read hands the attacker arbitrary DDL under a passing signature.
  it('rejects a migration whose on-disk bytes no longer match the verified hash', async () => {
    const { archivePath, files } = await writeArchive(MEMBERS);
    // The verified record says the file hashed to something else — i.e. the
    // bytes now on disk are NOT the bytes the signature covered.
    files.set('migrations/0001-first.sql', { sha256: '0'.repeat(64), uncompressedSize: 1 });

    await expect(
      readBundleMigrations({
        archivePath,
        files,
        manifest: { migrationsDir: 'migrations' } as never,
      }),
    ).rejects.toThrow(/integrity re-check failed/i);
  });

  // The member LIST must come from the verified record, not a fresh directory
  // read — otherwise an attacker can ADD a brand-new *.sql member post-verify
  // and it would be applied even though every pre-existing hash still matches.
  it('ignores an unverified migration member that only exists on disk', async () => {
    const { archivePath, files } = await writeArchive({
      ...MEMBERS,
      'migrations/0003-injected.sql': 'DROP TABLE organizations;',
    });
    files.delete('migrations/0003-injected.sql');

    const read = await readBundleMigrations({
      archivePath,
      files,
      manifest: { migrationsDir: 'migrations' } as never,
    });

    expect(read.map((f) => f.filename)).toEqual(['0001-first.sql', '0002-second.sql']);
    expect(read.some((f) => f.sql.includes('DROP TABLE'))).toBe(false);
  });
});
