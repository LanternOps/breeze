import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

// ── Mocks for the "core migration advisory lock" describe block below ──────
// Hoisted above the `./autoMigrate` import (vitest hoists every `vi.mock`
// call to the top of the file regardless of source position) so the module's
// internal `import postgres from 'postgres'` and `readFile`/`readdir` from
// `node:fs/promises` resolve to these fakes. No other describe block in this
// file calls `autoMigrate()` itself or reads via `node:fs/promises` — every
// other test below exercises pure exports or reads the real migrations
// directory via the SYNC `node:fs` API imported below, which this does not
// touch.
const { postgresFactory, clientMock, callLog, lockState } = vi.hoisted(() => {
  const callLog: string[] = [];
  const lockState: { failPattern: RegExp | null } = { failPattern: null };

  const clientMock = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      callLog.push(`${strings.join('?')} | values=${JSON.stringify(values)}`);
      return [];
    }),
    {
      unsafe: vi.fn(async (query: string) => {
        callLog.push(query);
        if (lockState.failPattern?.test(query)) {
          throw new Error(`mock DB failure: ${query}`);
        }
        return [];
      }),
      begin: vi.fn(async (cb: (tx: unknown) => unknown) => cb(clientMock)),
      end: vi.fn(async () => undefined),
      // `./autoMigrate` transitively imports `./seed` -> `./index`, whose
      // module-level `drizzle(client, { schema })` call (the app's own
      // request pool, unrelated to autoMigrate's own `postgres(...)` client)
      // also resolves through this same mocked factory. drizzle-orm's
      // postgres-js driver reads `client.options.parsers`/`serializers` at
      // construction time (see requestDatabasePool.test.ts for the same
      // shape requirement).
      options: { parsers: {}, serializers: {} },
    },
  );

  return { postgresFactory: vi.fn(() => clientMock), clientMock, callLog, lockState };
});

vi.mock('postgres', () => ({ default: postgresFactory }));
vi.mock('node:fs/promises', () => ({
  // Empty migration set: `autoMigrate()` takes the "no migration files
  // found" early return right after the tracking-table setup, which is
  // exactly the phase this describe block needs to observe the lock around
  // without simulating the entire apply pipeline (ensureAppRole/seed/etc).
  readdir: vi.fn(async () => []),
  readFile: vi.fn(async () => ''),
}));

import {
  detectState,
  assertAppRoleBootstrapped,
  hashSql,
  hasNoTransactionDirective,
  splitSqlStatements,
  CHECKSUM_RECONCILIATIONS,
  planMigrations,
  partitionLedgerRows,
  autoMigrate,
  CORE_MIGRATION_LOCK_KEY,
} from './autoMigrate';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { users } from './schema/users';
import * as oauthSchema from './schema/oauth';
import { quotes } from './schema/quotes';
import { deviceMtlsCertificates } from './schema/deviceMtlsCertificates';
import { manifestSigningKeyDelegations } from './schema/manifestSigningKeys';
import { devices } from './schema/devices';

// The 2026-08-06 date was reserved for the security remediation waves — though
// two same-day migrations from unrelated work landed in it as well
// (-e-action-intents-origin-principal, -f-m365-comms-delegated; see the Wave 6
// tests below, which document exactly that). All eight have now shipped.
//
// The block is CLOSED. Every file in it is content-hash immutable, and the
// files carry ordering dependencies on each other (the wave tests below assert
// several), so a new file wedged into the block replays in the wrong order on
// a fresh DB. At least one planned migration is already known to re-create a
// function the block defines — see the m365-comms plan doc, whose migrations
// this PR moved to a later date for exactly this reason.
//
// Previous guards expressed this as a shape (`-a..-f` slot letters). That was
// wrong twice over: it silently blessed `2026-08-06-a-something-unrelated.sql`,
// and it read as an open range with `-g-` free for the taking. Three separate
// authors reached for `-g-` (#2995, #3008, and the m365-comms plan doc) — the
// convention documented for same-day ordering is exactly "take the next
// letter", so that is the *natural* reading of a slot-letter rule.
//
// The mechanism is therefore an explicit frozen manifest, not a pattern: these
// eight filenames and no others. A ninth file on this date fails and is told to
// use a later date. See `scripts/check-migration-naming.sh` for the same rule
// enforced at commit time (which is where an author should hit it) — its copy
// of this manifest is asserted identical below — and
// `apps/api/migrations/README.md` for the authoring-facing writeup.
const RESERVED_MIGRATION_DATE = '2026-08-06-';
const RESERVED_BLOCK_MIGRATIONS = [
  '2026-08-06-a-report-site-scope.sql',
  '2026-08-06-b-live-authorization.sql',
  '2026-08-06-c-quote-response-capability.sql',
  '2026-08-06-d-device-mtls-certificate-history.sql',
  '2026-08-06-e-action-intents-origin-principal.sql',
  '2026-08-06-e-agent-outbound-network-capability.sql',
  '2026-08-06-f-m365-comms-delegated.sql',
  '2026-08-06-f-manifest-key-delegations.sql',
] as const;

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const GUARD_SCRIPT = path.join(REPO_ROOT, 'scripts/check-migration-naming.sh');

function listMigrationFilenames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((filename) => /^\d{4}-.*\.sql$/.test(filename))
    .sort((a, b) => a.localeCompare(b));
}

describe('autoMigrate', () => {
  describe('detectState', () => {
    it('should return "fresh" when no users table exists', () => {
      expect(detectState(false, false)).toBe('fresh');
    });

    it('should return "fresh" when users table missing even if breeze_migrations exists', () => {
      // Impossible in practice but the function should treat no users as fresh
      expect(detectState(false, true)).toBe('fresh');
    });

    it('should return "legacy" when users exists but breeze_migrations does not', () => {
      expect(detectState(true, false)).toBe('legacy');
    });

    it('should return "normal" when both users and breeze_migrations exist', () => {
      expect(detectState(true, true)).toBe('normal');
    });
  });

  describe('assertAppRoleBootstrapped', () => {
    it('does not throw when ensureAppRole succeeded', () => {
      expect(() => assertAppRoleBootstrapped(true, false)).not.toThrow();
      expect(() => assertAppRoleBootstrapped(true, true)).not.toThrow();
    });

    it('does not throw when ensureAppRole was skipped but breeze_app already exists (e.g. compose-provisioned dev DB)', () => {
      expect(() => assertAppRoleBootstrapped(false, true)).not.toThrow();
    });

    it('throws a pointed error when ensureAppRole was skipped AND breeze_app does not exist (#4048)', () => {
      expect(() => assertAppRoleBootstrapped(false, false)).toThrow(
        /BREEZE_APP_DB_PASSWORD.*POSTGRES_PASSWORD.*globalPassThroughEnv/s,
      );
    });
  });

  describe('hashSql', () => {
    it('should return a hex SHA-256 hash of the input', () => {
      const input = 'SELECT 1;';
      const expected = createHash('sha256').update(input).digest('hex');
      expect(hashSql(input)).toBe(expected);
    });

    it('should return a 64-character hex string', () => {
      const result = hashSql('CREATE TABLE foo (id INT);');
      expect(result).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should return consistent results for the same input', () => {
      const sql = 'ALTER TABLE devices ADD COLUMN test TEXT;';
      expect(hashSql(sql)).toBe(hashSql(sql));
    });

    it('should return different hashes for different inputs', () => {
      expect(hashSql('SELECT 1;')).not.toBe(hashSql('SELECT 2;'));
    });

    it('should handle empty string', () => {
      const expected = createHash('sha256').update('').digest('hex');
      expect(hashSql('')).toBe(expected);
    });

    it('should handle multiline SQL', () => {
      const sql = `
        CREATE TABLE test (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
        );
      `;
      const expected = createHash('sha256').update(sql).digest('hex');
      expect(hashSql(sql)).toBe(expected);
    });
  });

  describe('migration file pattern', () => {
    const MIGRATION_FILE_PATTERN = /^\d{4}-.*\.sql$/;

    it('should match numbered migration files', () => {
      expect(MIGRATION_FILE_PATTERN.test('0001-baseline.sql')).toBe(true);
      expect(MIGRATION_FILE_PATTERN.test('0065-users-setup-completed-at.sql')).toBe(true);
    });

    it('should match files with hyphens and multiple words', () => {
      expect(MIGRATION_FILE_PATTERN.test('0010-psa-provider-and-patch-compliance-reports.sql')).toBe(true);
    });

    it('should reject files without leading digits', () => {
      expect(MIGRATION_FILE_PATTERN.test('baseline.sql')).toBe(false);
      expect(MIGRATION_FILE_PATTERN.test('abc-baseline.sql')).toBe(false);
    });

    it('should reject files with fewer than 4 leading digits', () => {
      expect(MIGRATION_FILE_PATTERN.test('001-baseline.sql')).toBe(false);
    });

    it('should reject non-SQL files', () => {
      expect(MIGRATION_FILE_PATTERN.test('0001-baseline.ts')).toBe(false);
      expect(MIGRATION_FILE_PATTERN.test('0001-baseline.txt')).toBe(false);
    });

    it('should reject directories and other entries', () => {
      expect(MIGRATION_FILE_PATTERN.test('optional')).toBe(false);
      expect(MIGRATION_FILE_PATTERN.test('.gitkeep')).toBe(false);
    });

    it('should require something after the digits', () => {
      expect(MIGRATION_FILE_PATTERN.test('0001.sql')).toBe(false);
    });

    it('should match exactly 4-digit prefixes', () => {
      expect(MIGRATION_FILE_PATTERN.test('9999-last.sql')).toBe(true);
      // 5-digit prefix still matches because \d{4} matches the first four
      // and the fifth digit is consumed by .*
      expect(MIGRATION_FILE_PATTERN.test('00001-future.sql')).toBe(false);
    });
  });

  describe('hasNoTransactionDirective', () => {
    it('returns true when "-- @no-transaction" is the first line', () => {
      expect(hasNoTransactionDirective('-- @no-transaction\nCREATE INDEX foo ON bar (x);')).toBe(
        true,
      );
    });

    it('returns true when the directive has leading whitespace', () => {
      expect(hasNoTransactionDirective('   -- @no-transaction\nSELECT 1;')).toBe(true);
    });

    it('returns true when the directive appears after non-directive lines', () => {
      // Order in the file should not matter — operators may add the marker
      // after a copyright header. The runner checks the whole file.
      expect(
        hasNoTransactionDirective('-- header\n-- comment\n-- @no-transaction\nSELECT 1;'),
      ).toBe(true);
    });

    it('returns false when the directive is missing', () => {
      expect(hasNoTransactionDirective('CREATE INDEX IF NOT EXISTS foo ON bar (x);')).toBe(false);
    });

    it('returns false for a comment that merely mentions @no-transaction inline', () => {
      // The marker must be the start of the comment ("-- @no-transaction"),
      // not a substring of a normal comment, so that a sentence like
      // "# @no-transaction can be useful" in a docstring doesn't accidentally
      // opt a migration out of the transaction.
      expect(
        hasNoTransactionDirective(
          '-- This migration is normal. See the @no-transaction docs for index migrations.\nSELECT 1;',
        ),
      ).toBe(false);
    });

    it('returns false for a line that is not a SQL comment', () => {
      expect(hasNoTransactionDirective('@no-transaction\nSELECT 1;')).toBe(false);
      expect(hasNoTransactionDirective('# @no-transaction\nSELECT 1;')).toBe(false);
    });

    it('matches "@no-transaction" only as a whole word', () => {
      expect(hasNoTransactionDirective('-- @no-transactional\nSELECT 1;')).toBe(false);
    });
  });

  describe('splitSqlStatements', () => {
    it('splits a typical CREATE INDEX CONCURRENTLY migration', () => {
      const sql = `-- @no-transaction
-- Devices: scale indexes for /devices list endpoint.

CREATE INDEX CONCURRENTLY IF NOT EXISTS devices_org_id_last_seen_at_idx
  ON devices (org_id, last_seen_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS devices_org_id_status_idx
  ON devices (org_id, status);
`;
      const out = splitSqlStatements(sql);
      expect(out).toHaveLength(2);
      expect(out[0]).toContain('devices_org_id_last_seen_at_idx');
      expect(out[1]).toContain('devices_org_id_status_idx');
      expect(out[0]).not.toContain(';');
      expect(out[1]).not.toContain(';');
    });

    it('returns an empty array for a comment-only file', () => {
      expect(splitSqlStatements('-- nothing here\n-- @no-transaction\n')).toEqual([]);
    });

    it('returns a single statement when there is no trailing semicolon', () => {
      expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1']);
    });

    it('preserves semicolons inside single-quoted string literals', () => {
      const sql = "INSERT INTO t (s) VALUES ('a;b;c'); INSERT INTO t (s) VALUES ('d');";
      const out = splitSqlStatements(sql);
      expect(out).toHaveLength(2);
      expect(out[0]).toBe("INSERT INTO t (s) VALUES ('a;b;c')");
      expect(out[1]).toBe("INSERT INTO t (s) VALUES ('d')");
    });

    it("handles SQL-doubled single quotes inside literals", () => {
      const sql = "INSERT INTO t (s) VALUES ('Bobby''s; table'); SELECT 1;";
      const out = splitSqlStatements(sql);
      expect(out).toHaveLength(2);
      expect(out[0]).toBe("INSERT INTO t (s) VALUES ('Bobby''s; table')");
      expect(out[1]).toBe('SELECT 1');
    });

    it('preserves semicolons inside dollar-quoted blocks', () => {
      const sql = `CREATE OR REPLACE FUNCTION f() RETURNS void AS $$
BEGIN
  RAISE NOTICE 'a;b;c';
END;
$$ LANGUAGE plpgsql;

SELECT 1;`;
      const out = splitSqlStatements(sql);
      expect(out).toHaveLength(2);
      expect(out[0]).toContain('CREATE OR REPLACE FUNCTION');
      expect(out[0]).toContain("RAISE NOTICE 'a;b;c'");
      expect(out[1]).toBe('SELECT 1');
    });

    it('handles tagged dollar quotes ($tag$ ... $tag$)', () => {
      const sql = "DO $body$ BEGIN PERFORM 1; END $body$; SELECT 2;";
      const out = splitSqlStatements(sql);
      expect(out).toHaveLength(2);
      expect(out[0]).toBe('DO $body$ BEGIN PERFORM 1; END $body$');
      expect(out[1]).toBe('SELECT 2');
    });

    it('strips line comments but preserves the statements following them', () => {
      const sql = `-- header comment with a; semicolon
CREATE INDEX CONCURRENTLY IF NOT EXISTS foo_idx ON t (a);
-- another comment
CREATE INDEX CONCURRENTLY IF NOT EXISTS bar_idx ON t (b);`;
      const out = splitSqlStatements(sql);
      expect(out).toHaveLength(2);
      expect(out[0]).toContain('foo_idx');
      expect(out[1]).toContain('bar_idx');
    });
  });
});

describe('core migration advisory lock (#4086)', () => {
  beforeEach(() => {
    callLog.length = 0;
    lockState.failPattern = null;
    vi.clearAllMocks();
  });

  function acquireIndex(): number {
    return callLog.findIndex((c) => c.includes('pg_advisory_lock(') && c.includes(CORE_MIGRATION_LOCK_KEY));
  }
  function releaseIndex(): number {
    return callLog.findIndex((c) => c.includes('pg_advisory_unlock(') && c.includes(CORE_MIGRATION_LOCK_KEY));
  }

  it('acquires the session advisory lock before any tracking-table work, and releases it after (happy path)', async () => {
    await autoMigrate();

    const trackingTableIndex = callLog.findIndex((c) => c.includes('CREATE TABLE IF NOT EXISTS breeze_migrations'));

    expect(acquireIndex()).toBe(0);
    expect(trackingTableIndex).toBeGreaterThan(acquireIndex());
    expect(releaseIndex()).toBeGreaterThan(trackingTableIndex);
    // The lock release is the LAST DB call this run makes — nothing runs
    // after it except closing the connection.
    expect(releaseIndex()).toBe(callLog.length - 1);
    expect(clientMock.end).toHaveBeenCalledTimes(1);
  });

  it('still releases the lock (and closes the connection) when a migration step throws', async () => {
    lockState.failPattern = /CREATE TABLE IF NOT EXISTS breeze_migrations/;

    await expect(autoMigrate()).rejects.toThrow(/mock DB failure/);

    const failureIndex = callLog.findIndex((c) => c.includes('CREATE TABLE IF NOT EXISTS breeze_migrations'));

    expect(acquireIndex()).toBe(0);
    expect(failureIndex).toBeGreaterThan(acquireIndex());
    // The unlock in autoMigrate()'s inner `finally` still ran despite the throw.
    expect(releaseIndex()).toBeGreaterThan(failureIndex);
    expect(clientMock.end).toHaveBeenCalledTimes(1);
  });
});

describe('db:migrate entrypoint (#3065)', () => {
  // `pnpm db:migrate` executes a dedicated entry file via tsx. That file must
  // unconditionally invoke autoMigrate() — the original bug was the script
  // pointing at the library module itself, which only exports the function,
  // so the command exited 0 having applied nothing. A conditional
  // "am I the main module?" guard is not acceptable here either: comparing
  // import.meta.url to process.argv[1] fails open on percent-encodable or
  // symlinked paths, silently reproducing the same no-op.
  const apiRoot = path.resolve(__dirname, '..', '..');

  function resolveEntrypoint(): { entrypoint: string; source: string } {
    const pkg = JSON.parse(readFileSync(path.join(apiRoot, 'package.json'), 'utf8'));
    const script: string = pkg.scripts['db:migrate'];
    expect(script).toMatch(/^tsx /);
    const entrypoint = script.replace(/^tsx\s+/, '').trim();
    return { entrypoint, source: readFileSync(path.join(apiRoot, entrypoint), 'utf8') };
  }

  it('package.json db:migrate points at a dedicated entry file, not the library module', () => {
    const { entrypoint, source } = resolveEntrypoint();
    expect(source.length).toBeGreaterThan(0);
    // The library module must stay import-safe for the API boot path, so the
    // script may not point straight at it.
    expect(path.basename(entrypoint)).not.toBe('autoMigrate.ts');
  });

  it('the entrypoint invokes autoMigrate() unconditionally and exits by outcome', () => {
    const { source } = resolveEntrypoint();

    // Invokes the runner (not just imports it)...
    expect(source).toContain('autoMigrate()');
    // ...must not hide the call behind a main-module guard (fails open on
    // percent-encoded/symlinked paths — the silent-no-op failure mode again).
    expect(source).not.toContain('import.meta.url ===');
    // Success must exit 0 explicitly (the auto-seed step opens the shared
    // pool, which would otherwise hold the event loop open forever)...
    expect(source).toContain('process.exit(0)');
    // ...and failure must exit non-zero.
    expect(source).toContain('process.exit(1)');
  });
});

describe('CHECKSUM_RECONCILIATIONS', () => {
  const migrationsDir = path.resolve(__dirname, '../../migrations');

  it('each entry targets a real shipped migration whose CURRENT content hashes to `to`', () => {
    const entries = Object.entries(CHECKSUM_RECONCILIATIONS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [filename, rec] of entries) {
      // The current on-disk file must hash to the declared `to`. If someone
      // edits one of these migrations again, this fails until `to` is updated —
      // preventing a silently-stale heal map.
      const content = readFileSync(path.join(migrationsDir, filename), 'utf8');
      expect(hashSql(content)).toBe(rec.to);
      // A reconciliation must represent an actual change, with valid checksums.
      expect(rec.from).not.toBe(rec.to);
      expect(rec.from).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.to).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('migration filename conventions', () => {
  it('adds no new migration to the closed 2026-08-06 reserved block', () => {
    const onDisk = listMigrationFilenames().filter((filename) =>
      filename.startsWith(RESERVED_MIGRATION_DATE),
    );
    const manifest: string[] = [...RESERVED_BLOCK_MIGRATIONS];
    const squatters = onDisk.filter((filename) => !manifest.includes(filename));

    expect(
      squatters,
      squatters.length === 0
        ? ''
        : `Migration(s) added to the CLOSED reserved ${RESERVED_MIGRATION_DATE} block:\n` +
          squatters.map((filename) => `  - ${filename}`).join('\n') +
          `\n\nThat date is not a free namespace and its letters do NOT run past the\n` +
          `shipped set. Rename the file to a date AFTER the block (a plain\n` +
          `YYYY-MM-DD-<slug>.sql on today's date sorts last, which is normally\n` +
          `what you actually want) and update every reference to the old path —\n` +
          `integration tests replay migrations BY PATH, so a stale name is an\n` +
          `ENOENT in Integration Tests, not a compile error.\n` +
          `See apps/api/migrations/README.md.`,
    ).toEqual([]);

    // Guard the other direction too: a manifest entry that no longer exists on
    // disk means a shipped migration was deleted or renamed, which re-applies
    // under the new name on every already-migrated database.
    const missing = manifest.filter((filename) => !onDisk.includes(filename));
    expect(
      missing,
      missing.length === 0
        ? ''
        : `Shipped reserved-block migration(s) missing from apps/api/migrations: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('keeps the commit-time naming guard in sync with the reserved-block manifest', () => {
    // The pre-commit guard is where an author should hit this, and it is
    // deliberately a standalone shell script (no toolchain needed). It carries
    // its own copy of the date and the manifest, so assert BOTH element-for-
    // element — a substring check on the date alone would still pass while the
    // two guards enforced different memberships.
    const guard = readFileSync(GUARD_SCRIPT, 'utf8');

    expect(guard).toMatch(new RegExp(`^RESERVED_DATE="${RESERVED_MIGRATION_DATE}"$`, 'm'));

    const arrayBody = guard.match(/^RESERVED_BLOCK=\(\n([\s\S]*?)^\)$/m)?.[1];
    expect(arrayBody, 'could not parse RESERVED_BLOCK=( … ) out of the guard script').toBeDefined();

    const shellManifest = (arrayBody ?? '')
      .split('\n')
      .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    expect(shellManifest).toEqual([...RESERVED_BLOCK_MIGRATIONS]);
  });

  it('rejects a squatter migration when the commit-time guard actually runs', () => {
    // The guard runs on every PR, but only ever against a clean tree — that
    // proves the pass branch and nothing else. Drive its FAILURE path against a
    // fixture directory so "the guard still fires" is a test, not a memory of
    // having tried it once by hand.
    const fixture = mkdtempSync(path.join(tmpdir(), 'migration-naming-'));
    try {
      for (const filename of RESERVED_BLOCK_MIGRATIONS) {
        writeFileSync(path.join(fixture, filename), '-- fixture\n');
      }

      const run = (): { status: number | null; stderr: string } => {
        const result = spawnSync('bash', [GUARD_SCRIPT], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, BREEZE_MIGRATIONS_DIR: fixture },
        });
        return { status: result.status, stderr: result.stderr };
      };

      // The shipped block alone is clean.
      expect(run().status).toBe(0);

      // A ninth file on the reserved date is rejected, and named.
      writeFileSync(path.join(fixture, '2026-08-06-g-squatter.sql'), '-- fixture\n');
      const squatter = run();
      expect(squatter.status).toBe(1);
      expect(squatter.stderr).toContain('2026-08-06-g-squatter.sql');
      expect(squatter.stderr).toContain('CLOSED');
      rmSync(path.join(fixture, '2026-08-06-g-squatter.sql'));

      // A filename the runner would silently skip is rejected, and named.
      writeFileSync(path.join(fixture, 'no-date-prefix.sql'), '-- fixture\n');
      const undiscoverable = run();
      expect(undiscoverable.status).toBe(1);
      expect(undiscoverable.stderr).toContain('no-date-prefix.sql');
      rmSync(path.join(fixture, 'no-date-prefix.sql'));

      // An empty directory must FAIL rather than report OK having checked
      // nothing — the vacuous-guard failure mode this whole suite exists for.
      for (const filename of RESERVED_BLOCK_MIGRATIONS) {
        rmSync(path.join(fixture, filename));
      }
      expect(run().status).toBe(1);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('resolves every core migration path referenced from apps/api/src', () => {
    // Integration suites replay migrations by path (readFileSync of
    // `../../../migrations/<file>.sql`). Those references are executable code,
    // not prose: renaming a migration without sweeping them fails as an ENOENT
    // minutes into Integration Tests, long after Test API has gone green.
    // This assertion moves that failure into the unit job, where it is instant.
    const srcDir = path.resolve(__dirname, '..');
    const referenced = new Map<string, string>();

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'node_modules') walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        // Extension bundles carry their OWN migrations directories, and their
        // tests build synthetic in-memory bundles whose fixture filenames
        // intentionally do not exist on disk. Skip only those test files —
        // extension SOURCE files do cite real core migrations (e.g.
        // extensions/stateStore.ts), and those references should be held to
        // the same standard as any other.
        //
        // Note this scan does not distinguish code from comments, so a prose
        // mention of a migration path is checked too. That is intended: a
        // comment citing a migration that no longer exists is also rot.
        if (full.includes(`${path.sep}extensions${path.sep}`) && entry.name.endsWith('.test.ts')) {
          continue;
        }
        const contents = readFileSync(full, 'utf8');
        for (const match of contents.matchAll(/migrations\/(\d{4}-[A-Za-z0-9._-]*\.sql)/g)) {
          const filename = match[1];
          if (filename && !referenced.has(filename)) {
            referenced.set(filename, path.relative(REPO_ROOT, full));
          }
        }
      }
    };
    walk(srcDir);

    expect(referenced.size).toBeGreaterThan(0);

    const onDisk = new Set(readdirSync(MIGRATIONS_DIR));
    const dangling = [...referenced.entries()]
      .filter(([filename]) => !onDisk.has(filename))
      .map(([filename, source]) => `${filename} (referenced from ${source})`);

    expect(
      dangling,
      dangling.length === 0
        ? ''
        : `Migration path(s) referenced from apps/api/src that do not exist:\n` +
          dangling.map((entry) => `  - ${entry}`).join('\n') +
          `\n\nA migration was renamed or deleted without sweeping its references.`,
    ).toEqual([]);
    // Explicit timeout: this case reads every .ts file under apps/api/src, so
    // its runtime scales with the repo and is dominated by scheduler delay when
    // the full 1,342-file suite runs it in parallel. Vitest's 5s default is a
    // latent tripwire — and one that matters more here than most, because a
    // flaky version of this guard is indistinguishable from the renamed-
    // migration ENOENT it exists to move out of Integration Tests.
  }, 60_000);
});

describe('migration ordering vs a remote ref (--against-ref, pre-push guard)', () => {
  // The commit-time guard (--staged, above) can only see history already
  // reachable from the branch's own HEAD. It is blind to a migration that
  // lands on origin/main AFTER the branch was cut — which is exactly what
  // happened on 2026-10-03: a branch carrying 2026-10-02-100001-… passed the
  // commit-time guard clean, while origin/main had meanwhile gained
  // 2026-10-03-audit-chain-verify-range.sql, which sorts after it. CI's
  // "Check Migrations" job (running against the merge commit) would have
  // caught it, but only after a push and a red run — the file had to be
  // renamed and pushed again. --against-ref exists to catch this locally,
  // in a pre-push hook, before that round-trip.
  //
  // This drives the guard against a REAL temporary git repo (with a bare
  // "origin" remote) rather than the fixture-directory technique the
  // --staged tests above use, because the new mode's whole job is to diff
  // two refs — there is no ref to diff without an actual repository.
  function git(args: string[], cwd: string): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(
        `git ${args.join(' ')} (cwd=${cwd}) failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
    }
    return result.stdout;
  }

  function runGuard(
    cwd: string,
    args: string[],
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync('bash', [GUARD_SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, BREEZE_MIGRATIONS_DIR: 'migrations' },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  // Builds: a bare "origin" remote, a work tree with a base migration pushed
  // to origin/main, then a "feature" branch cut from that base — mirroring a
  // real branch-and-push flow.
  function makeRepo(): { dir: string; origin: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'migration-order-work-'));
    const origin = mkdtempSync(path.join(tmpdir(), 'migration-order-origin-'));
    git(['init', '--bare', '--initial-branch=main', origin], origin);

    git(['init', '--initial-branch=main', dir], dir);
    git(['config', 'user.email', 'guard-test@example.com'], dir);
    git(['config', 'user.name', 'Guard Test'], dir);
    git(['remote', 'add', 'origin', origin], dir);

    mkdirSync(path.join(dir, 'migrations'));
    writeFileSync(path.join(dir, 'migrations', '2026-10-01-base.sql'), '-- base\n');
    git(['add', '.'], dir);
    git(['commit', '-m', 'base'], dir);
    git(['push', 'origin', 'main'], dir);

    git(['checkout', '-b', 'feature'], dir);
    return { dir, origin };
  }

  function cleanup(repo: { dir: string; origin: string }): void {
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(repo.origin, { recursive: true, force: true });
  }

  it('passes when the branch\'s new migration sorts after the newest on origin/main', () => {
    const repo = makeRepo();
    try {
      writeFileSync(path.join(repo.dir, 'migrations', '2026-10-04-feature.sql'), '-- feature\n');
      git(['add', '.'], repo.dir);
      git(['commit', '-m', 'feature migration'], repo.dir);
      git(['fetch', 'origin', 'main'], repo.dir);

      const result = runGuard(repo.dir, ['--against-ref', 'origin/main']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('OK');
    } finally {
      cleanup(repo);
    }
  });

  it('fails, naming the offending file and the remedy, when origin/main gained a migration meanwhile that sorts after the branch\'s new one', () => {
    const repo = makeRepo();
    try {
      // The branch adds a migration that looks fine relative to its own
      // history (sorts after the base it was cut from)...
      writeFileSync(path.join(repo.dir, 'migrations', '2026-10-02-100001-feature.sql'), '-- feature\n');
      git(['add', '.'], repo.dir);
      git(['commit', '-m', 'feature migration'], repo.dir);

      // ...but meanwhile origin/main gained a migration that sorts AFTER it.
      git(['checkout', 'main'], repo.dir);
      writeFileSync(path.join(repo.dir, 'migrations', '2026-10-03-main-progressed.sql'), '-- main\n');
      git(['add', '.'], repo.dir);
      git(['commit', '-m', 'main progressed'], repo.dir);
      git(['push', 'origin', 'main'], repo.dir);
      git(['checkout', 'feature'], repo.dir);
      git(['fetch', 'origin', 'main'], repo.dir);

      const result = runGuard(repo.dir, ['--against-ref', 'origin/main']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('2026-10-02-100001-feature.sql');
      expect(result.stderr).toContain('2026-10-03-main-progressed.sql');
      expect(result.stderr.toLowerCase()).toContain('rename');
    } finally {
      cleanup(repo);
    }
  });

  it('passes with no violations when the branch adds no new migrations', () => {
    const repo = makeRepo();
    try {
      git(['fetch', 'origin', 'main'], repo.dir);
      const result = runGuard(repo.dir, ['--against-ref', 'origin/main']);
      expect(result.status, result.stderr).toBe(0);
    } finally {
      cleanup(repo);
    }
  });

  it('fails with a clear error, not a false OK, when the given ref does not exist', () => {
    const repo = makeRepo();
    try {
      const result = runGuard(repo.dir, ['--against-ref', 'origin/does-not-exist']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('origin/does-not-exist');
    } finally {
      cleanup(repo);
    }
  });
});

describe('core migration ordering', () => {
  it('discovers the report site-scope migration exactly once in lexical order', () => {
    const ledgerNames = planMigrations(listMigrationFilenames()).map(
      (migration) => migration.ledgerName,
    );
    const reserved = '2026-08-06-a-report-site-scope.sql';

    expect(ledgerNames.filter((filename) => filename === reserved)).toHaveLength(1);
    expect(ledgerNames).toEqual([...ledgerNames].sort((a, b) => a.localeCompare(b)));
    // This file opens the reserved block. The block's membership is guarded by
    // 'migration filename conventions' above — deliberately NOT here, so a
    // squatter reds a test whose name says what is wrong instead of this one.
    const reservedBlock = ledgerNames.filter((filename) =>
      filename.startsWith(RESERVED_MIGRATION_DATE),
    );
    expect(reservedBlock[0]).toBe(reserved);
  });
});

describe('Wave 3 durable live authorization expansion', () => {
  it('maps the user permission epoch as a non-null bigint defaulting to zero', () => {
    const column = getTableConfig(users).columns.find((candidate) => candidate.name === 'permissions_epoch');

    expect(column).toBeDefined();
    expect(column?.getSQLType()).toBe('bigint');
    expect(column?.notNull).toBe(true);
    expect(column?.default).toBe(0);
  });

  it('defines the complete oauth_revocation_retries schema contract', () => {
    const retryTable = (oauthSchema as Record<string, unknown>).oauthRevocationRetries;
    expect(retryTable).toBeDefined();
    if (!retryTable) return;

    const config = getTableConfig(retryTable as Parameters<typeof getTableConfig>[0]);
    expect(config.name).toBe('oauth_revocation_retries');
    expect(config.columns.map((column) => column.name)).toEqual([
      'id',
      'user_id',
      'marker_type',
      'marker_id',
      'expires_at',
      'attempts',
      'next_attempt_at',
      'last_error_code',
      'completed_at',
      'created_at',
      'updated_at',
    ]);
    expect(config.indexes.map((index) => index.config.name).sort()).toEqual([
      'oauth_revocation_retries_due_idx',
      'oauth_revocation_retries_incomplete_marker_uq',
      'oauth_revocation_retries_user_idx',
    ]);
  });

  it('maps versioned quote response and read-link revocation columns', () => {
    const columns = new Map(
      getTableConfig(quotes).columns.map((column) => [column.name, column]),
    );

    expect(columns.get('public_token_version')?.getSQLType()).toBe('integer');
    expect(columns.get('public_token_version')?.notNull).toBe(true);
    expect(columns.get('public_token_version')?.default).toBe(0);
    expect(columns.get('public_response_jti')?.getSQLType()).toBe('varchar(128)');
    expect(columns.get('public_response_consumed_at')?.getSQLType()).toBe('timestamp with time zone');
    expect(columns.get('public_response_outcome')?.getSQLType()).toBe('varchar(16)');
    expect(columns.get('public_link_revoked_at')?.getSQLType()).toBe('timestamp with time zone');
  });

  it('orders the reserved live-authorization migrations after all preceding migrations', () => {
    const files = listMigrationFilenames();
    const liveAuthorization = '2026-08-06-b-live-authorization.sql';
    const quoteCapability = '2026-08-06-c-quote-response-capability.sql';

    expect(files).toContain(liveAuthorization);
    expect(files).toContain(quoteCapability);
    const reservedBlock = files.filter((file) => file.startsWith(RESERVED_MIGRATION_DATE));
    // Assert RELATIVE order, not adjacency (see the Wave 6 capability and
    // delegation migration tests below for the full rationale): a sibling
    // branch is free to land its own migration between -b- and -c- in the
    // same date block, and adjacency would turn that into a red main
    // pointing at the wrong wave.
    expect(reservedBlock.indexOf(quoteCapability)).toBeGreaterThan(
      reservedBlock.indexOf(liveAuthorization),
    );
  });

  it('registers oauth_revocation_retries as a user-id-scoped RLS table', () => {
    const rlsCoverage = readFileSync(
      path.resolve(__dirname, '../__tests__/integration/rls-coverage.integration.test.ts'),
      'utf8',
    );
    const allowlist = rlsCoverage.match(
      /const USER_ID_SCOPED_TABLES[\s\S]*?new Set<string>\(\[([\s\S]*?)\]\);/,
    )?.[1];

    expect(allowlist).toContain("'oauth_revocation_retries'");
  });
});

describe('Wave 5 device mTLS certificate history', () => {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const certificateHistory = '2026-08-06-d-device-mtls-certificate-history.sql';

  it('orders the certificate-history migration after the reserved Wave 3 quote-capability migration', () => {
    const files = listMigrationFilenames();
    const quoteCapability = '2026-08-06-c-quote-response-capability.sql';

    expect(files).toContain(certificateHistory);
    const reservedBlock = files.filter((file) => file.startsWith(RESERVED_MIGRATION_DATE));
    // Assert RELATIVE order, not adjacency (see the Wave 6 capability and
    // delegation migration tests below for the full rationale): a sibling
    // branch is free to land its own migration between -c- and -d- in the
    // same date block, and adjacency would turn that into a red main
    // pointing at the wrong wave.
    expect(reservedBlock.indexOf(certificateHistory)).toBeGreaterThan(
      reservedBlock.indexOf(quoteCapability),
    );
  });

  it('defines the composite FK, state checks, indexes, and column shape for device_mtls_certificates', () => {
    const cfg = getTableConfig(deviceMtlsCertificates);

    expect(cfg.columns.map((c) => c.name).sort()).toEqual(
      [
        'activated_at',
        'activation_expires_at',
        'created_at',
        'device_id',
        'expires_at',
        'fingerprint_sha256',
        'id',
        'issued_at',
        'last_revoke_error',
        'legacy_provenance',
        'next_revoke_attempt_at',
        'org_id',
        'provider_certificate_id',
        'public_key_spki',
        'revoke_attempts',
        'revoked_at',
        'serial_number',
        'state',
        'updated_at',
      ].sort(),
    );

    expect(cfg.foreignKeys.map((fk) => fk.getName())).toContain(
      'device_mtls_certificates_device_org_fkey',
    );

    expect(cfg.checks.map((check) => check.name).sort()).toEqual(
      [
        'device_mtls_certificates_active_time_chk',
        'device_mtls_certificates_fingerprint_chk',
        'device_mtls_certificates_pending_expiry_chk',
        'device_mtls_certificates_revoked_time_chk',
        'device_mtls_certificates_state_chk',
      ].sort(),
    );

    expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual(
      [
        'device_mtls_certificates_one_active_uq',
        'device_mtls_certificates_org_device_state_idx',
        'device_mtls_certificates_org_serial_uq',
        'device_mtls_certificates_provider_uq',
        'device_mtls_certificates_retry_idx',
      ].sort(),
    );
  });

  it('enables and forces RLS with all four breeze_has_org_access policies plus breeze_app grants in the migration file', () => {
    const migrationSql = readFileSync(path.join(migrationsDir, certificateHistory), 'utf8');

    expect(migrationSql).toMatch(/ALTER TABLE device_mtls_certificates ENABLE ROW LEVEL SECURITY/);
    expect(migrationSql).toMatch(/ALTER TABLE device_mtls_certificates FORCE ROW LEVEL SECURITY/);
    for (const cmd of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(migrationSql).toMatch(new RegExp(`FOR ${cmd}[\\s\\S]*?breeze_has_org_access`));
    }
    expect(migrationSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON device_mtls_certificates TO breeze_app/,
    );
  });
});

describe('Wave 6 agent outbound-network-policy capability handshake', () => {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const capabilityMigration = '2026-08-06-e-agent-outbound-network-capability.sql';
  const certificateHistory = '2026-08-06-d-device-mtls-certificate-history.sql';

  it('orders the capability migration after the reserved Wave 5 certificate-history migration and before the delegation migration', () => {
    const files = listMigrationFilenames();

    expect(files).toContain(capabilityMigration);

    // Assert RELATIVE order, not adjacency. An earlier revision asserted this
    // file sorted *immediately* after Wave 5's, which is not an invariant this
    // wave owns: a sibling branch is free to land its own migration in the
    // same date block, and one did (2026-08-06-e-action-intents-origin-
    // principal.sql, from the action-intents work). Adjacency assertions turn
    // any concurrent migration into a red main that points at the wrong wave.
    //
    // What actually matters is the dependency order this wave relies on:
    // Wave 5's certificate-history migration first, then this wave's capability
    // column, then the delegation table.
    const delegationTable = '2026-08-06-f-manifest-key-delegations.sql';
    expect(files.indexOf(capabilityMigration)).toBeGreaterThan(files.indexOf(certificateHistory));
    expect(files.indexOf(delegationTable)).toBeGreaterThan(files.indexOf(capabilityMigration));
  });

  it('maps outbound_network_policy_version as a non-null integer defaulting to zero', () => {
    const column = getTableConfig(devices).columns.find(
      (candidate) => candidate.name === 'outbound_network_policy_version',
    );

    expect(column).toBeDefined();
    expect(column?.getSQLType()).toBe('integer');
    expect(column?.notNull).toBe(true);
    expect(column?.default).toBe(0);
  });

  it('is an idempotent expand-only ADD COLUMN with no inner transaction directives', () => {
    const migrationSql = readFileSync(path.join(migrationsDir, capabilityMigration), 'utf8');

    expect(migrationSql).toMatch(
      /ADD COLUMN IF NOT EXISTS outbound_network_policy_version integer NOT NULL DEFAULT 0/,
    );
    expect(migrationSql).not.toMatch(/\bBEGIN;/);
    expect(migrationSql).not.toMatch(/\bCOMMIT;/);
  });
});

describe('Wave 6 signed manifest key delegation', () => {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const delegationMigration = '2026-08-06-f-manifest-key-delegations.sql';
  const capabilityMigration = '2026-08-06-e-agent-outbound-network-capability.sql';

  it('orders the delegation migration after the Wave 6 capability migration', () => {
    const files = listMigrationFilenames();

    expect(files).toContain(delegationMigration);
    expect(files).toContain(capabilityMigration);

    // Assert RELATIVE order, not adjacency. An earlier revision asserted this
    // file sorted *immediately* after the capability migration, which is not
    // an invariant this wave owns: a sibling branch is free to land its own
    // migration in the same 2026-08-06 date block, and one did
    // (2026-08-06-f-m365-comms-delegated.sql, from the delegated-comms work),
    // landing lexically between the two. Adjacency assertions turn any
    // concurrent migration into a red main that points at the wrong wave.
    //
    // What actually matters is the sequencing this wave relies on: its own
    // capability-column migration lands before its own delegation-table
    // migration, matching the design order in the Wave 6 plan.
    expect(files.indexOf(delegationMigration)).toBeGreaterThan(
      files.indexOf(capabilityMigration),
    );
  });

  it('declares the delegation table column shape, unique epoch, and window check', () => {
    const cfg = getTableConfig(manifestSigningKeyDelegations);

    expect(cfg.name).toBe('manifest_signing_key_delegations');
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(
      [
        'activated_at',
        'created_at',
        'epoch',
        'id',
        'new_key_id',
        'new_public_key_b64',
        'not_after',
        'not_before',
        'old_key_id',
        'signature_b64',
      ].sort(),
    );

    // The epoch is the monotonic replay counter the agent compares against.
    // UNIQUE is what makes epoch reuse impossible at the storage layer rather
    // than only in the CLI's pre-checks.
    const epoch = cfg.columns.find((c) => c.name === 'epoch');
    expect(epoch?.notNull).toBe(true);
    expect(epoch?.isUnique).toBe(true);
    expect(epoch?.getSQLType()).toBe('bigint');

    expect(cfg.checks.map((check) => check.name).sort()).toEqual(
      ['manifest_signing_key_delegations_window_chk'].sort(),
    );
  });

  it('is idempotent, has no inner transaction directives, and forces system-only RLS', () => {
    const migrationSql = readFileSync(path.join(migrationsDir, delegationMigration), 'utf8');

    expect(migrationSql).toMatch(
      /CREATE TABLE IF NOT EXISTS manifest_signing_key_delegations/,
    );
    // autoMigrate wraps each file in client.begin(...) — an inner BEGIN;/COMMIT;
    // only emits "there is already a transaction in progress".
    expect(migrationSql).not.toMatch(/\bBEGIN;/);
    expect(migrationSql).not.toMatch(/\bCOMMIT;/);

    expect(migrationSql).toMatch(
      /ALTER TABLE manifest_signing_key_delegations ENABLE ROW LEVEL SECURITY/,
    );
    expect(migrationSql).toMatch(
      /ALTER TABLE manifest_signing_key_delegations FORCE ROW LEVEL SECURITY/,
    );

    // Exact system-only policy shape, copied from manifest_signing_keys: BOTH
    // USING and WITH CHECK must require the system scope. A USING-only policy
    // would let a tenant context INSERT rows it cannot read.
    expect(migrationSql).toMatch(
      /CREATE POLICY manifest_signing_key_delegations_system_only[\s\S]*?USING \(current_setting\('breeze\.scope', true\) = 'system'\)[\s\S]*?WITH CHECK \(current_setting\('breeze\.scope', true\) = 'system'\)/,
    );
    // Policy creation guarded on pg_policies so re-applying is a no-op.
    expect(migrationSql).toMatch(/FROM pg_policies/);

    // Only what the system-context service role needs. DELETE is deliberately
    // absent: nothing in the delegation lifecycle removes a record.
    //
    // Assert against EXECUTABLE sql — `--` comment text in this file discusses
    // grants in prose, and a naive whole-file regex matches the prose instead
    // of the statement (it did, on the first run).
    const executableSql = migrationSql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    expect(executableSql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON manifest_signing_key_delegations TO breeze_app;/,
    );
    const grantStatements = executableSql.match(/GRANT[\s\S]*?;/g) ?? [];
    expect(grantStatements).toHaveLength(1);
    expect(grantStatements[0]).not.toMatch(/DELETE/);
  });

  it('has the same system-only policy shape as manifest_signing_keys (no drift between the two)', () => {
    const delegationSql = readFileSync(path.join(migrationsDir, delegationMigration), 'utf8');
    const signingKeySql = readFileSync(
      path.join(migrationsDir, '2026-05-09-manifest-signing-keys.sql'),
      'utf8',
    );

    const predicate = /current_setting\('breeze\.scope', true\) = 'system'/g;
    // Two occurrences each (USING + WITH CHECK) — the delegation table must
    // not be laxer than the key table it derives its trust from.
    expect(signingKeySql.match(predicate)).toHaveLength(2);
    expect(delegationSql.match(predicate)).toHaveLength(2);
  });
});

describe('extension-owned ledger rows', () => {
  it('plans core migrations only — extension migrations are the extension migrator\'s job', () => {
    const plan = planMigrations([
      '2026-07-08-automation-run-device-results.sql',
      '9999-last.sql',
    ]);

    expect(plan.map((migration) => migration.ledgerName)).toEqual([
      '2026-07-08-automation-run-device-results.sql',
      '9999-last.sql',
    ]);
  });

  it('partitions ledger rows: bare core rows verified, namespaced extension rows skipped', () => {
    const { verify, skip } = partitionLedgerRows([
      '0001-core.sql',
      'workspace/2026-07-10-a.sql',
      'ghost/2026-01-01-x.sql',
    ]);

    expect(verify).toEqual(['0001-core.sql']);
    expect(skip).toEqual(['workspace/2026-07-10-a.sql', 'ghost/2026-01-01-x.sql']);
  });
});
