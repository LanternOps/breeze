import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// #8991: a fresh database migrated by an owner role that is neither SUPERUSER
// nor BYPASSRLS must apply the shipped set the same way a superuser does. That
// needs autoMigrate to run every migration (and its users-exist check) under
// `breeze.scope = 'system'`, and with `createrole_self_grant` set so roles
// created by a migration can later be made object owners. The end-to-end proof
// is CI's `check-migrations-nonsuperuser` job, which runs the real set on PG16.
// This file pins the runner's statement order without a database.

const { postgresFactory, clientMock, callLog, migrationFiles, failOn } = vi.hoisted(() => {
  const callLog: string[] = [];
  const migrationFiles: Record<string, string> = {};
  const failOn: { pattern: RegExp | null } = { pattern: null };

  const clientMock = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim();
      callLog.push(`${text} | values=${JSON.stringify(values)}`);
      // The bounded core-lock acquire (#4144) reads `locked`; uncontended here.
      if (text.includes('pg_try_advisory_lock(')) return [{ locked: true }];
      return [];
    }),
    {
      unsafe: vi.fn(async (query: string) => {
        callLog.push(query);
        if (failOn.pattern?.test(query)) throw new Error(`mock DB failure: ${query}`);
        return [];
      }),
      begin: vi.fn(async (cb: (tx: unknown) => unknown) => {
        callLog.push('<begin>');
        try {
          const result = await cb(clientMock);
          callLog.push('<commit>');
          return result;
        } catch (err) {
          callLog.push('<rollback>');
          throw err;
        }
      }),
      end: vi.fn(async () => undefined),
      options: { parsers: {}, serializers: {} },
    },
  );

  return { postgresFactory: vi.fn(() => clientMock), clientMock, callLog, migrationFiles, failOn };
});

vi.mock('postgres', () => ({ default: postgresFactory }));
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(async () => Object.keys(migrationFiles)),
  readFile: vi.fn(async (filePath: string) => migrationFiles[String(filePath).split(/[\\/]/).pop() ?? ''] ?? ''),
}));
vi.mock('./ensureAppRole', () => ({ ensureAppRole: vi.fn(async () => true) }));
vi.mock('./seed', () => ({ seed: vi.fn(async () => undefined) }));

import {
  applyMigrationInTransaction,
  autoMigrate,
  migrationSessionSql,
  MIGRATION_SESSION_RESET_SQL,
} from './autoMigrate';
import { seed } from './seed';

const SCOPE_LOCAL = "set_config('breeze.scope', 'system', true)";
const SCOPE_SESSION = "set_config('breeze.scope', 'system', false)";
const SELF_GRANT_LOCAL = "set_config('createrole_self_grant', 'set, inherit', true)";
const SELF_GRANT_SESSION = "set_config('createrole_self_grant', 'set, inherit', false)";
const TX_SETTINGS = migrationSessionSql('transaction');
const SESSION_SETTINGS = migrationSessionSql('session');

function indexOfCall(predicate: (call: string) => boolean, from = 0): number {
  for (let i = from; i < callLog.length; i++) {
    if (predicate(callLog[i]!)) return i;
  }
  return -1;
}

const isLedgerInsert = (call: string) => call.includes('INSERT INTO breeze_migrations');

/**
 * Asserts `bodyIndex` runs inside a transaction that issued `settingsSql`
 * before it. Order-based rather than adjacency-based, so an unrelated extra
 * statement in the transaction does not break it.
 */
function expectRunsInTransactionAfter(bodyIndex: number, settingsSql: string): void {
  expect(bodyIndex).toBeGreaterThanOrEqual(0);
  const begin = callLog.lastIndexOf('<begin>', bodyIndex);
  expect(begin, `no transaction opened before ${callLog[bodyIndex]}`).toBeGreaterThanOrEqual(0);
  expect(callLog.slice(begin, bodyIndex), 'transaction closed before the body ran').not.toContain('<commit>');
  const settings = callLog.indexOf(settingsSql, begin);
  expect(settings, 'settings not issued in this transaction before the body').toBeGreaterThan(begin);
  expect(settings).toBeLessThan(bodyIndex);
  const commit = callLog.indexOf('<commit>', bodyIndex);
  expect(commit, 'transaction never committed').toBeGreaterThan(bodyIndex);
}

beforeEach(() => {
  callLog.length = 0;
  failOn.pattern = null;
  for (const key of Object.keys(migrationFiles)) delete migrationFiles[key];
  vi.clearAllMocks();
});

describe('migrationSessionSql (#8991)', () => {
  it('scopes both settings to the transaction for a transactional file', () => {
    expect(TX_SETTINGS).toContain(`SELECT ${SCOPE_LOCAL};`);
    expect(TX_SETTINGS).toContain(`PERFORM ${SELF_GRANT_LOCAL};`);
    expect(TX_SETTINGS).not.toContain(', false)');
  });

  it('sets both settings for the session for a -- @no-transaction file', () => {
    expect(SESSION_SETTINGS).toContain(`SELECT ${SCOPE_SESSION};`);
    expect(SESSION_SETTINGS).toContain(`PERFORM ${SELF_GRANT_SESSION};`);
    expect(SESSION_SETTINGS).not.toContain(', true)');
  });

  it('only touches createrole_self_grant on PG16+, where the setting exists', () => {
    for (const sql of [TX_SETTINGS, SESSION_SETTINGS, MIGRATION_SESSION_RESET_SQL]) {
      expect(sql).toMatch(/IF current_setting\('server_version_num'\)::int >= 160000 THEN[\s\S]*createrole_self_grant[\s\S]*END IF;/);
    }
  });

  it('reset restores both settings to their defaults', () => {
    expect(MIGRATION_SESSION_RESET_SQL).toContain('RESET "breeze.scope";');
    expect(MIGRATION_SESSION_RESET_SQL).toContain("EXECUTE 'RESET createrole_self_grant'");
  });
});

describe('applyMigrationInTransaction (#8991)', () => {
  it('runs the transaction-local settings, then the file, then the ledger row, in one transaction', async () => {
    await applyMigrationInTransaction(clientMock as never, '2027-01-01-000000-x.sql', 'INSERT INTO roles VALUES (1);', 'abc');

    expect(callLog).toEqual([
      '<begin>',
      TX_SETTINGS,
      'INSERT INTO roles VALUES (1);',
      expect.stringContaining('INSERT INTO breeze_migrations (filename, checksum)'),
      '<commit>',
    ]);
    expect(clientMock.unsafe).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO breeze_migrations'),
      ['2027-01-01-000000-x.sql', 'abc'],
    );
  });

  it('records the ledger row inside the same transaction, so a ledger failure rolls the file back', async () => {
    failOn.pattern = /INSERT INTO breeze_migrations/;

    await expect(
      applyMigrationInTransaction(clientMock as never, '2027-01-01-000000-x.sql', 'UPDATE roles SET name = name;', 'abc'),
    ).rejects.toThrow(/mock DB failure/);

    expect(callLog).toContain('<rollback>');
    expect(callLog).not.toContain('<commit>');
    expect(callLog.indexOf('UPDATE roles SET name = name;')).toBeGreaterThan(callLog.indexOf('<begin>'));
  });
});

describe('autoMigrate session settings, end to end against a mocked connection (#8991)', () => {
  it('pins one connection with postgres.js connection recycling off', async () => {
    await autoMigrate();

    // Recycling (default max_lifetime 30-60 min) would silently swap the
    // connection mid-run and drop session-level settings and the advisory lock.
    expect(postgresFactory).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ max: 1, max_lifetime: 0 }),
    );
  });

  it('applies every pending file and the users-exist check under system scope, and resets after a no-transaction file', async () => {
    migrationFiles['2027-01-01-000000-a-seed-rows.sql'] = "INSERT INTO snmp_templates (name) VALUES ('a');";
    migrationFiles['2027-01-01-000001-b-index.sql'] =
      '-- @no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS x_idx ON x (y);';
    migrationFiles['2027-01-01-000002-c-update.sql'] = 'UPDATE roles SET name = name;';

    await autoMigrate();

    // File a: transactional, settings issued inside its own transaction first.
    const fileA = callLog.indexOf("INSERT INTO snmp_templates (name) VALUES ('a');");
    expectRunsInTransactionAfter(fileA, TX_SETTINGS);

    // File b: no-transaction. Session settings go out before its statement, the
    // statement runs outside any transaction, and the reset precedes its ledger row.
    const fileB = callLog.indexOf('CREATE INDEX CONCURRENTLY IF NOT EXISTS x_idx ON x (y)');
    expect(fileB).toBeGreaterThan(fileA);
    const previousCommit = callLog.lastIndexOf('<commit>', fileB);
    expect(callLog.slice(previousCommit + 1, fileB)).not.toContain('<begin>');
    const sessionSet = callLog.indexOf(SESSION_SETTINGS, previousCommit);
    expect(sessionSet).toBeGreaterThan(previousCommit);
    expect(sessionSet).toBeLessThan(fileB);
    const reset = callLog.indexOf(MIGRATION_SESSION_RESET_SQL, fileB);
    const ledgerB = indexOfCall(isLedgerInsert, fileB);
    expect(reset).toBeGreaterThan(fileB);
    expect(ledgerB).toBeGreaterThan(reset);

    // File c: transactional again, so it elects in its own transaction.
    const fileC = callLog.indexOf('UPDATE roles SET name = name;');
    expect(fileC).toBeGreaterThan(fileB);
    expectRunsInTransactionAfter(fileC, TX_SETTINGS);

    // The users-exist check that gates the auto-seed reads under system scope.
    // Unscoped, a non-BYPASSRLS role sees zero users and re-seeds on every boot.
    const usersCheck = indexOfCall((c) => c.startsWith('SELECT id FROM users LIMIT 1'));
    expect(usersCheck).toBeGreaterThan(fileC);
    expectRunsInTransactionAfter(usersCheck, `SELECT ${SCOPE_LOCAL}`);
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it('applies the fresh-database baseline under the same transaction-local settings', async () => {
    migrationFiles['0001-baseline.sql'] = 'CREATE TABLE users (id uuid);';
    migrationFiles['0002-legacy.sql'] = 'ALTER TABLE users ADD COLUMN x int;';

    await autoMigrate();

    const baseline = callLog.indexOf('CREATE TABLE users (id uuid);');
    expectRunsInTransactionAfter(baseline, TX_SETTINGS);
    const baselineLedger = indexOfCall(isLedgerInsert, baseline);
    expect(baselineLedger).toBeLessThan(callLog.indexOf('<commit>', baseline));

    // 0002 is folded into the baseline on a fresh database: its ledger row is
    // recorded (the ON CONFLICT insert) after the baseline, and its SQL never runs.
    expect(indexOfCall((c) => isLedgerInsert(c) && c.includes('ON CONFLICT'), baseline)).toBeGreaterThan(baselineLedger);
    expect(callLog).not.toContain('ALTER TABLE users ADD COLUMN x int;');
  });
});

describe('check-migrations-nonsuperuser harness role (#8991)', () => {
  // The CI job is only a guard if its migration role is the least-privileged
  // owner a fresh install can have. Granting it BYPASSRLS or a role-level
  // createrole_self_grant is exactly what hid #8991.
  const source = readFileSync(path.resolve(__dirname, '../../scripts/check-migrations-nonsuperuser.ts'), 'utf8');
  const createRole = /CREATE ROLE \$\{MIGRATOR_ROLE\}([\s\S]*?);/.exec(source)?.[1] ?? '';
  const alterRoleAttrs = /ALTER ROLE \$\{MIGRATOR_ROLE\} (NO[^`]*)`/.exec(source)?.[1] ?? '';

  it('provisions the role without SUPERUSER or BYPASSRLS, and re-asserts that on a reused cluster', () => {
    for (const attrs of [createRole, alterRoleAttrs]) {
      expect(attrs).toMatch(/\bNOSUPERUSER\b/);
      expect(attrs).toMatch(/\bNOBYPASSRLS\b/);
      expect(attrs).not.toMatch(/(?<!NO)BYPASSRLS\b/);
      expect(attrs).not.toMatch(/(?<!NO)SUPERUSER\b/);
    }
    expect(alterRoleAttrs).toMatch(/\bNOREPLICATION\b/);
  });

  it('never sets createrole_self_grant on the role, and clears a leftover one (autoMigrate must set it)', () => {
    expect(source).not.toMatch(/ALTER ROLE[^;`]*\bSET\s+createrole_self_grant/i);
    expect(source).toMatch(/ALTER ROLE \$\{MIGRATOR_ROLE\} RESET createrole_self_grant/);
  });
});
