import '../__tests__/integration/setup';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultBuiltinEverMigrated,
  defaultExistingDeclaredTables,
} from './builtinExtensions';
import { MIGRATION_TABLE } from '../db/autoMigrate';

/**
 * The disabled built-in's table-existence and migration-ledger probes, against
 * a REAL Postgres.
 *
 * WHY THIS FILE EXISTS. `defaultExistingDeclaredTables` and
 * `defaultBuiltinEverMigrated` are the pieces of the disabled path that no unit
 * test can reach: `builtinExtensions.test.ts` drives everything through
 * injected ports, so both ports' own SQL is stubbed out there. That gap has
 * already cost once — the first version of the table query bound the names as a
 * `text[]` parameter, which passed the whole unit suite and then failed against
 * a live server with `malformed array literal`, aborting boot for every
 * deployment that had ever enabled the built-in. The table query is now an `IN
 * ${sql([...])}` list over `pg_class`; this suite proves that shape actually
 * executes and returns the right subset for the three cases the caller
 * distinguishes:
 *
 *   - NONE present   → publish nothing (declaring absent tables would point
 *                      cascade/export SQL at relations that do not exist).
 *   - SOME present   → publish a declaration FILTERED to the present subset.
 *   - ALL present    → publish the whole declaration.
 *
 * A >1-element list is used throughout on purpose: the binding bug that
 * motivated this file only appears with multiple names.
 *
 * The companion ledger cases prove the namespaced `LIKE $1` query distinguishes
 * `workspace/%` from a lookalike such as `workspace-extra/%`.
 *
 * DATABASE. It provisions its OWN throwaway database rather than using the
 * shared `breeze_test`, for two reasons: this test CREATEs and DROPs tables in
 * `public`, and a stray leftover there would read as an "unaccounted public
 * table" to every other suite's tenancy tripwire; and the probe needs no core
 * schema at all, so there is nothing to gain from migrating one. The name
 * matches the test-DB safety allowlist (`/^breeze_test(_[a-z0-9]+)?$/`), and
 * `DROP DATABASE ... WITH (FORCE)` runs first so an interrupted previous run
 * cannot leave anything behind. Mutating `process.env.DATABASE_URL` around the
 * calls is safe ONLY because the integration config sets `fileParallelism:
 * false` (vitest.integration.config.ts), so no other suite is connected while
 * the variable is swapped.
 */
const THROWAWAY_DB = 'breeze_test_probe';

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

function withDbName(connectionUrl: string, databaseName: string): string {
  const parsed = new URL(connectionUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

const PROBE_DATABASE_URL = withDbName(BASE_DATABASE_URL, THROWAWAY_DB);

/** Deliberately more than one name — see the header. */
const DECLARED = ['probe_alpha', 'probe_beta', 'probe_gamma'] as const;

describe('defaultExistingDeclaredTables (the disabled built-in table probe) against real Postgres', () => {
  let baseAdmin: Sql;
  let probeAdmin: Sql;
  let previousDatabaseUrl: string | undefined;

  /** Run the real port with DATABASE_URL pointed at the throwaway DB. */
  async function probe(tables: readonly string[]): Promise<string[]> {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = PROBE_DATABASE_URL;
    try {
      return (await defaultExistingDeclaredTables(tables)).sort();
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }

  /** Run the real migration-ledger port against the same throwaway DB. */
  async function probeEverMigrated(extensionName: string): Promise<boolean> {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = PROBE_DATABASE_URL;
    try {
      return await defaultBuiltinEverMigrated(extensionName);
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }

  beforeAll(async () => {
    baseAdmin = postgres(BASE_DATABASE_URL, { max: 1, onnotice: () => {} });
    await baseAdmin.unsafe(`DROP DATABASE IF EXISTS ${THROWAWAY_DB} WITH (FORCE)`);
    await baseAdmin.unsafe(`CREATE DATABASE ${THROWAWAY_DB}`);
    probeAdmin = postgres(PROBE_DATABASE_URL, { max: 1, onnotice: () => {} });
    await probeAdmin.unsafe(
      `CREATE TABLE ${MIGRATION_TABLE} (` +
        'filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())',
    );
  });

  afterAll(async () => {
    // Close the throwaway pool BEFORE dropping the database; FORCE also
    // terminates any session the probe's own short-lived pool left behind.
    if (probeAdmin) await probeAdmin.end({ timeout: 5 });
    if (baseAdmin) {
      await baseAdmin.unsafe(`DROP DATABASE IF EXISTS ${THROWAWAY_DB} WITH (FORCE)`);
      await baseAdmin.end({ timeout: 5 });
    }
  });

  it('returns an empty list when NONE of the declared tables exist', async () => {
    expect(await probe(DECLARED)).toEqual([]);
  });

  it('returns ONLY the present subset when SOME exist (the partial-schema case)', async () => {
    // Exactly the shape a boot that died part-way through the migration file
    // sequence leaves behind: one file's table committed, the rest never ran.
    await probeAdmin.unsafe('CREATE TABLE probe_beta (id int NOT NULL)');
    try {
      expect(await probe(DECLARED)).toEqual(['probe_beta']);
    } finally {
      await probeAdmin.unsafe('DROP TABLE IF EXISTS probe_beta');
    }
  });

  it('returns every name when ALL exist', async () => {
    for (const table of DECLARED) {
      await probeAdmin.unsafe(`CREATE TABLE ${table} (id int NOT NULL)`);
    }
    try {
      expect(await probe(DECLARED)).toEqual([...DECLARED].sort());
    } finally {
      for (const table of DECLARED) {
        await probeAdmin.unsafe(`DROP TABLE IF EXISTS ${table}`);
      }
    }
  });

  // `relkind IN ('r','p')` is the whole reason this is pg_class and not a
  // `to_regclass`-per-name loop: a VIEW named like a declared table must not be
  // reported as present. Publishing tenancy for it would hand core's cascade
  // code a relation it cannot DELETE from.
  it('does not report a VIEW that shares a declared table name', async () => {
    await probeAdmin.unsafe('CREATE VIEW probe_alpha AS SELECT 1 AS id');
    try {
      expect(await probe(DECLARED)).toEqual([]);
    } finally {
      await probeAdmin.unsafe('DROP VIEW IF EXISTS probe_alpha');
    }
  });

  // The caller short-circuits on an empty declaration, but the port must not
  // build `IN ()` — invalid SQL — if it is ever reached with one.
  it('short-circuits an empty list without touching the database', async () => {
    expect(await probe([])).toEqual([]);
  });

  it('reports false when the built-in has no namespaced migration-ledger row', async () => {
    await probeAdmin.unsafe(`DELETE FROM ${MIGRATION_TABLE}`);
    expect(await probeEverMigrated('workspace')).toBe(false);
  });

  it('reports only an exact built-in namespace prefix as migrated', async () => {
    await probeAdmin.unsafe(
      `INSERT INTO ${MIGRATION_TABLE} (filename, checksum) VALUES ($1, $2)`,
      ['workspace-extra/0001-init.sql', 'fixture-checksum'],
    );
    try {
      expect(await probeEverMigrated('workspace')).toBe(false);
      await probeAdmin.unsafe(
        `INSERT INTO ${MIGRATION_TABLE} (filename, checksum) VALUES ($1, $2)`,
        ['workspace/0001-init.sql', 'fixture-checksum'],
      );
      expect(await probeEverMigrated('workspace')).toBe(true);
    } finally {
      await probeAdmin.unsafe(`DELETE FROM ${MIGRATION_TABLE}`);
    }
  });
});
