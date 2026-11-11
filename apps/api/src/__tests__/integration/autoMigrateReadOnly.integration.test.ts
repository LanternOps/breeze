import './setup';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres, { type Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIGRATION_TABLE,
  autoMigrate,
  discoverCoreMigrationFilenames,
  hashSql,
  planMigrations,
} from '../../db/autoMigrate';
import { ReadOnlyDatabaseError } from '../../db/readOnlyDatabase';
import { initializeDatabaseForStartup } from '../../db/databaseStartup';
import { BREEZE_VERSION_HISTORY_TABLE } from '../../db/versionHistory';

/**
 * #11731: a managed Postgres was switched to `default_transaction_read_only =
 * on` by its provider (storage exhaustion). The API image had zero pending
 * migrations, yet startup exited on `cannot execute CREATE TABLE in a read-only
 * transaction` (SQLSTATE 25006) and Docker restarted it in a loop: a degraded
 * region (no writes) became a full outage.
 *
 * Each case runs against its own disposable database, put into read-only mode
 * the same way the provider did (`ALTER DATABASE ... SET
 * default_transaction_read_only = on`), so the shared test database is never
 * made read-only and its ledger is never touched. The fixture is the minimum
 * autoMigrate reads on a migrated install: a `users` table with one row and a
 * `breeze_migrations` ledger carrying this checkout's files and checksums.
 */

const BASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

let admin: Sql;
let databaseName: string;
let scratchUrl: string;
let savedDatabaseUrl: string | undefined;

async function ledgerRows(): Promise<Array<{ filename: string; checksum: string }>> {
  const plan = planMigrations(await discoverCoreMigrationFilenames());
  return Promise.all(
    plan.map(async (m) => ({ filename: m.ledgerName, checksum: hashSql(await readFile(m.filePath, 'utf8')) })),
  );
}

/**
 * Build the fixture while the database is still writable, then flip it to
 * read-only. `omitLast` leaves the newest migration out of the ledger, so the
 * image has exactly one pending migration.
 */
async function seedMigratedDatabase(options: { omitLast?: boolean; versionRow?: string } = {}): Promise<string[]> {
  const fixture = postgres(scratchUrl, { max: 1, onnotice: () => {} });
  try {
    const rows = await ledgerRows();
    const recorded = options.omitLast ? rows.slice(0, -1) : rows;
    await fixture.unsafe(`CREATE TABLE users (id uuid PRIMARY KEY)`);
    await fixture`INSERT INTO users (id) VALUES (${crypto.randomUUID()})`;
    await fixture.unsafe(`
      CREATE TABLE ${MIGRATION_TABLE} (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await fixture`INSERT INTO ${fixture(MIGRATION_TABLE)} ${fixture(recorded, 'filename', 'checksum')}`;
    if (options.versionRow) {
      await fixture.unsafe(`
        CREATE TABLE ${BREEZE_VERSION_HISTORY_TABLE} (
          version TEXT PRIMARY KEY,
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await fixture`INSERT INTO ${fixture(BREEZE_VERSION_HISTORY_TABLE)} (version) VALUES (${options.versionRow})`;
    }
    return rows.slice(recorded.length).map((r) => r.filename);
  } finally {
    await fixture.end({ timeout: 5 });
  }
}

async function makeReadOnly(): Promise<void> {
  await admin.unsafe(`ALTER DATABASE "${databaseName}" SET default_transaction_read_only = on`);
}

/** Ledger contents read over a fresh (read-only) session, to prove nothing was written. */
async function ledgerCount(): Promise<number> {
  const reader = postgres(scratchUrl, { max: 1, onnotice: () => {} });
  try {
    const [setting] = await reader<{ readOnly: string }[]>`SELECT current_setting('transaction_read_only') AS "readOnly"`;
    expect(setting?.readOnly).toBe('on');
    const [row] = await reader.unsafe<{ count: string }[]>(`SELECT count(*)::text AS count FROM ${MIGRATION_TABLE}`);
    return Number(row?.count);
  } finally {
    await reader.end({ timeout: 5 });
  }
}

beforeEach(async () => {
  admin = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  databaseName = `breeze_test_readonly_${crypto.randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(BASE_URL);
  url.pathname = `/${databaseName}`;
  scratchUrl = url.toString();
  savedDatabaseUrl = process.env.DATABASE_URL;
  // autoMigrate and ensureAppRole both read DATABASE_URL directly.
  process.env.DATABASE_URL = scratchUrl;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env.DATABASE_URL = savedDatabaseUrl;
  await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end({ timeout: 5 });
});

describe('autoMigrate against a read-only database (#11731)', () => {
  it('starts cleanly with zero pending migrations and writes nothing', async () => {
    await seedMigratedDatabase();
    const before = await (async () => {
      await makeReadOnly();
      return ledgerCount();
    })();

    await expect(autoMigrate()).resolves.toBeUndefined();

    expect(await ledgerCount()).toBe(before);
  });

  it('refuses to start with pending migrations, naming the read-only condition and the pending file', async () => {
    const pending = await seedMigratedDatabase({ omitLast: true });
    expect(pending).toHaveLength(1);
    await makeReadOnly();

    const error = await autoMigrate().then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(ReadOnlyDatabaseError);
    const message = (error as Error).message;
    expect(message).toMatch(/read-only/);
    expect(message).toContain('1 pending migration');
    expect(message).toContain(pending[0]);
    // Actionable: says what to do, not just what went wrong.
    expect(message).toMatch(/writable/);
  });

  it('refuses to bootstrap a fresh database that is read-only, with the same specific error', async () => {
    await makeReadOnly();

    const error = await autoMigrate().then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(ReadOnlyDatabaseError);
    expect((error as Error).message).toMatch(/read-only/);
  });

  it('runs the whole database startup sequence (preflight, migrate, version record) without throwing', async () => {
    // The version this image would record is already on file: the read-only
    // database needs no change, so the record step must not fail either.
    await seedMigratedDatabase({ versionRow: '0.128.0' });
    await makeReadOnly();
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(
      initializeDatabaseForStartup({
        autoMigrateEnabled: true,
        production: true,
        upgradeChecks: true,
        env: { ...process.env, DATABASE_URL: scratchUrl, APP_VERSION: '0.128.0' },
        logger,
        // The request pool is the shared test database's; the role check is
        // not what this case is about.
        readRequestRole: async () => ({ currentUser: 'breeze_app', isSuperuser: false, bypassesRls: false }),
      }),
    ).resolves.toBeUndefined();

    const warnings = logger.warn.mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => /Could not record the running version/.test(w))).toEqual([]);
  });
});
