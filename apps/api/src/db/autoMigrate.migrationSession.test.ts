import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// #8991: a fresh database migrated by an owner role that is neither SUPERUSER
// nor BYPASSRLS must apply the shipped set the same way a superuser does. That
// needs autoMigrate to run every migration (and its users-exist check) under
// `breeze.scope = 'system'`, and with `createrole_self_grant` set so roles
// created by a migration can later be made object owners. The end-to-end proof
// is CI's `check-migrations-nonsuperuser` job. This file pins the runner's
// statement order without a database.

const { postgresFactory, clientMock, callLog, migrationFiles } = vi.hoisted(() => {
  const callLog: string[] = [];
  const migrationFiles: Record<string, string> = {};

  const clientMock = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      callLog.push(`${strings.join('?').replace(/\s+/g, ' ').trim()} | values=${JSON.stringify(values)}`);
      return [];
    }),
    {
      unsafe: vi.fn(async (query: string) => {
        callLog.push(query);
        return [];
      }),
      begin: vi.fn(async (cb: (tx: unknown) => unknown) => {
        callLog.push('<begin>');
        const result = await cb(clientMock);
        callLog.push('<commit>');
        return result;
      }),
      end: vi.fn(async () => undefined),
      options: { parsers: {}, serializers: {} },
    },
  );

  return { postgresFactory: vi.fn(() => clientMock), clientMock, callLog, migrationFiles };
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

function indexOfCall(predicate: (call: string) => boolean, from = 0): number {
  for (let i = from; i < callLog.length; i++) {
    if (predicate(callLog[i]!)) return i;
  }
  return -1;
}

beforeEach(() => {
  callLog.length = 0;
  for (const key of Object.keys(migrationFiles)) delete migrationFiles[key];
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of Object.keys(migrationFiles)) delete migrationFiles[key];
});

describe('migrationSessionSql (#8991)', () => {
  it('scopes both settings to the transaction for a transactional file', () => {
    const sql = migrationSessionSql('transaction');
    expect(sql).toContain(`SELECT ${SCOPE_LOCAL};`);
    expect(sql).toContain(`PERFORM ${SELF_GRANT_LOCAL};`);
    expect(sql).not.toContain(', false)');
  });

  it('sets both settings for the session for a -- @no-transaction file', () => {
    const sql = migrationSessionSql('session');
    expect(sql).toContain(`SELECT ${SCOPE_SESSION};`);
    expect(sql).toContain(`PERFORM ${SELF_GRANT_SESSION};`);
    expect(sql).not.toContain(', true)');
  });

  it('only touches createrole_self_grant on PG16+, where the setting exists', () => {
    for (const sql of [migrationSessionSql('transaction'), migrationSessionSql('session'), MIGRATION_SESSION_RESET_SQL]) {
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
      migrationSessionSql('transaction'),
      'INSERT INTO roles VALUES (1);',
      expect.stringContaining('INSERT INTO breeze_migrations (filename, checksum)'),
      '<commit>',
    ]);
    expect(clientMock.unsafe).toHaveBeenLastCalledWith(
      expect.stringContaining('INSERT INTO breeze_migrations'),
      ['2027-01-01-000000-x.sql', 'abc'],
    );
  });
});

describe('autoMigrate session settings, end to end against a mocked connection (#8991)', () => {
  it('applies every file and the users-exist check under system scope, and resets after a no-transaction file', async () => {
    migrationFiles['2027-01-01-000000-a-seed-rows.sql'] = "INSERT INTO snmp_templates (name) VALUES ('a');";
    migrationFiles['2027-01-01-000001-b-index.sql'] =
      '-- @no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS x_idx ON x (y);';
    migrationFiles['2027-01-01-000002-c-update.sql'] = 'UPDATE roles SET name = name;';

    await autoMigrate();

    // File a: transactional, settings first inside its transaction.
    const fileA = callLog.indexOf("INSERT INTO snmp_templates (name) VALUES ('a');");
    expect(fileA).toBeGreaterThan(0);
    expect(callLog[fileA - 1]).toBe(migrationSessionSql('transaction'));
    expect(callLog[fileA - 2]).toBe('<begin>');

    // File b: no-transaction, session settings before its statements, reset after.
    const fileB = callLog.indexOf('CREATE INDEX CONCURRENTLY IF NOT EXISTS x_idx ON x (y)');
    expect(fileB).toBeGreaterThan(fileA);
    expect(callLog[fileB - 1]).toBe(migrationSessionSql('session'));
    expect(callLog[fileB + 1]).toBe(MIGRATION_SESSION_RESET_SQL);
    expect(callLog[fileB + 2]).toContain('INSERT INTO breeze_migrations');

    // File c: transactional again, so it re-elects in its own transaction.
    const fileC = callLog.indexOf('UPDATE roles SET name = name;');
    expect(fileC).toBeGreaterThan(fileB);
    expect(callLog[fileC - 1]).toBe(migrationSessionSql('transaction'));
    expect(callLog[fileC - 2]).toBe('<begin>');

    // The users-exist check that gates the auto-seed reads under system scope
    // inside a transaction. Unscoped, a non-BYPASSRLS role sees zero users and
    // re-seeds on every boot.
    const usersCheck = indexOfCall((c) => c.startsWith('SELECT id FROM users LIMIT 1'));
    expect(usersCheck).toBeGreaterThan(fileC);
    expect(callLog[usersCheck - 1]).toBe(`SELECT ${SCOPE_LOCAL}`);
    expect(callLog[usersCheck - 2]).toBe('<begin>');
    expect(callLog[usersCheck + 1]).toBe('<commit>');
    expect(seed).toHaveBeenCalledTimes(1);
  });
});

describe('check-migrations-nonsuperuser harness role (#8991)', () => {
  // The CI job is only a guard if its migration role is the least-privileged
  // owner a fresh install can have. Granting it BYPASSRLS or a role-level
  // createrole_self_grant is exactly what hid #8991.
  const source = readFileSync(path.resolve(__dirname, '../../scripts/check-migrations-nonsuperuser.ts'), 'utf8');
  const createRole = /CREATE ROLE \$\{MIGRATOR_ROLE\}([\s\S]*?);/.exec(source)?.[1] ?? '';

  it('provisions the role without SUPERUSER or BYPASSRLS', () => {
    expect(createRole).toMatch(/\bNOSUPERUSER\b/);
    expect(createRole).toMatch(/\bNOBYPASSRLS\b/);
    expect(createRole).not.toMatch(/(?<!NO)BYPASSRLS\b/);
    expect(createRole).not.toMatch(/(?<!NO)SUPERUSER\b/);
  });

  it('does not pre-set createrole_self_grant on the role (autoMigrate must set it)', () => {
    expect(source).not.toMatch(/ALTER ROLE[^;]*createrole_self_grant/i);
  });
});
