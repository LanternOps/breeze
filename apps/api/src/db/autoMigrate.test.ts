import { afterEach, describe, it, expect } from 'vitest';
import {
  detectState,
  hashSql,
  hasNoTransactionDirective,
  splitSqlStatements,
  CHECKSUM_RECONCILIATIONS,
  planMigrations,
  partitionLedgerRows,
} from './autoMigrate';
import { createHash } from 'node:crypto';
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

describe('core migration ordering', () => {
  const migrationsDir = path.resolve(__dirname, '../../migrations');

  it('discovers the report site-scope migration exactly once in lexical order', () => {
    const filenames = readdirSync(migrationsDir)
      .filter((filename) => /^\d{4}-.*\.sql$/.test(filename))
      .sort((a, b) => a.localeCompare(b));
    const ledgerNames = planMigrations(filenames).map((migration) => migration.ledgerName);
    const reserved = '2026-08-06-a-report-site-scope.sql';

    expect(ledgerNames.filter((filename) => filename === reserved)).toHaveLength(1);
    expect(ledgerNames).toEqual([...ledgerNames].sort((a, b) => a.localeCompare(b)));
    // 2026-08-06-a..f is reserved by the remediation program and later waves
    // append to it, so assert the block is the contiguous lexical tail opened
    // by this file rather than pinning it as the single last migration.
    const reservedBlock = ledgerNames.filter((filename) => filename.startsWith('2026-08-06-'));
    expect(ledgerNames.slice(-reservedBlock.length)).toEqual(reservedBlock);
    expect(reservedBlock[0]).toBe(reserved);
  });
});

describe('Wave 3 durable live authorization expansion', () => {
  const migrationsDir = path.resolve(__dirname, '../../migrations');

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
    const files = readdirSync(migrationsDir)
      .filter((file) => /^\d{4}-.*\.sql$/.test(file))
      .sort((a, b) => a.localeCompare(b));
    const liveAuthorization = '2026-08-06-b-live-authorization.sql';
    const quoteCapability = '2026-08-06-c-quote-response-capability.sql';

    expect(files).toContain(liveAuthorization);
    expect(files).toContain(quoteCapability);
    // Later waves append -d..-f to the reserved 2026-08-06 block, so assert
    // the block is the contiguous lexical tail rather than pinning the
    // global tail.
    const reservedBlock = files.filter((file) => file.startsWith('2026-08-06-'));
    expect(files.slice(-reservedBlock.length)).toEqual(reservedBlock);
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
    const files = readdirSync(migrationsDir)
      .filter((file) => /^\d{4}-.*\.sql$/.test(file))
      .sort((a, b) => a.localeCompare(b));
    const quoteCapability = '2026-08-06-c-quote-response-capability.sql';

    expect(files).toContain(certificateHistory);
    // -d..-f is still reserved for later waves, so assert the block remains
    // the contiguous lexical tail, rather than pinning this file as the
    // single last migration.
    const reservedBlock = files.filter((file) => file.startsWith('2026-08-06-'));
    expect(files.slice(-reservedBlock.length)).toEqual(reservedBlock);
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
    const files = readdirSync(migrationsDir)
      .filter((file) => /^\d{4}-.*\.sql$/.test(file))
      .sort((a, b) => a.localeCompare(b));

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
    const files = readdirSync(migrationsDir)
      .filter((file) => /^\d{4}-.*\.sql$/.test(file))
      .sort((a, b) => a.localeCompare(b));

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

describe('extension migrations', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
    tempRoots.length = 0;
  });

  function makeExtensionRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'ext-'));
    tempRoots.push(root);
    return root;
  }

  function scaffoldExtension(root: string, name: string, files: Record<string, string>): string {
    const dir = path.join(root, name);
    mkdirSync(path.join(dir, 'migrations'), { recursive: true });
    writeFileSync(
      path.join(dir, 'breeze-extension.json'),
      JSON.stringify({ name, routeNamespace: name, entry: 'src/index.ts', tenancy: {} }),
    );
    for (const [filename, sql] of Object.entries(files)) {
      writeFileSync(path.join(dir, 'migrations', filename), sql);
    }
    return dir;
  }

  it('lists extension migrations after all core migrations, prefixed with the extension name', () => {
    const extRoot = makeExtensionRoot();
    scaffoldExtension(extRoot, 'workspace', {
      '2026-07-10-workspace-foundation.sql': 'SELECT 1;',
    });

    const plan = planMigrations(
      ['2026-07-08-automation-run-device-results.sql', '9999-last.sql'],
      extRoot,
    );

    expect(plan.map((migration) => migration.ledgerName)).toEqual([
      '2026-07-08-automation-run-device-results.sql',
      '9999-last.sql',
      'workspace/2026-07-10-workspace-foundation.sql',
    ]);
  });

  it('applies extensions in name order, files in localeCompare order within each', () => {
    const extRoot = makeExtensionRoot();
    scaffoldExtension(extRoot, 'zeta', { '2026-01-01-z.sql': 'SELECT 1;' });
    scaffoldExtension(extRoot, 'alpha', {
      '2026-01-02-b.sql': 'SELECT 1;',
      '2026-01-01-a.sql': 'SELECT 1;',
    });

    const plan = planMigrations([], extRoot);

    expect(plan.map((migration) => migration.ledgerName)).toEqual([
      'alpha/2026-01-01-a.sql',
      'alpha/2026-01-02-b.sql',
      'zeta/2026-01-01-z.sql',
    ]);
  });

  it('rejects extension migration filenames that do not match the core pattern', () => {
    const extRoot = makeExtensionRoot();
    scaffoldExtension(extRoot, 'workspace', { 'workspace-init.sql': 'SELECT 1;' });

    expect(planMigrations([], extRoot).map((migration) => migration.ledgerName)).toEqual([]);
  });

  it('partitions ledger rows: present-extension rows verified, absent-extension rows skipped', () => {
    const extRoot = makeExtensionRoot();
    scaffoldExtension(extRoot, 'workspace', { '2026-07-10-a.sql': 'SELECT 1;' });

    const { verify, skip } = partitionLedgerRows(
      ['0001-core.sql', 'workspace/2026-07-10-a.sql', 'ghost/2026-01-01-x.sql'],
      extRoot,
    );

    expect(verify).toEqual(['0001-core.sql', 'workspace/2026-07-10-a.sql']);
    expect(skip).toEqual(['ghost/2026-01-01-x.sql']);
  });
});
