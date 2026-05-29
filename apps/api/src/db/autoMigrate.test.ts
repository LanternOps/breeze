import { describe, it, expect } from 'vitest';
import {
  detectState,
  hashSql,
  hasNoTransactionDirective,
  splitSqlStatements,
  deriveAppConnectionString,
  CHECKSUM_RECONCILIATIONS,
} from './autoMigrate';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

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

  describe('deriveAppConnectionString', () => {
    it('swaps user and password on a basic URL', () => {
      const result = deriveAppConnectionString(
        'postgresql://breeze:secret@db:5432/breeze',
        'breeze_app',
        'app_secret',
      );
      expect(result).toBe('postgresql://breeze_app:app_secret@db:5432/breeze');
    });

    it('preserves query params like sslmode', () => {
      const result = deriveAppConnectionString(
        'postgresql://breeze:secret@db:5432/breeze?sslmode=require',
        'breeze_app',
        'app_secret',
      );
      expect(result).toBe('postgresql://breeze_app:app_secret@db:5432/breeze?sslmode=require');
    });

    it('preserves host and port', () => {
      const result = deriveAppConnectionString(
        'postgresql://admin:x@pg.internal.example.com:6432/production',
        'breeze_app',
        'pw',
      );
      expect(result).toBe('postgresql://breeze_app:pw@pg.internal.example.com:6432/production');
    });

    it('URL-encodes special characters in the password', () => {
      const result = deriveAppConnectionString(
        'postgresql://breeze:x@db:5432/breeze',
        'breeze_app',
        'p@ss/word:with spaces',
      );
      // The URL class percent-encodes @ / : and space in password position.
      expect(result).toContain('breeze_app:');
      // parsed.password returns the raw percent-encoded form; decoding it
      // should round-trip to the original (that's what postgres-js does
      // when it parses the connection string).
      const parsed = new URL(result!);
      expect(decodeURIComponent(parsed.password)).toBe('p@ss/word:with spaces');
      expect(parsed.username).toBe('breeze_app');
    });

    it('returns null when password is undefined', () => {
      expect(
        deriveAppConnectionString('postgresql://breeze:x@db:5432/breeze', 'breeze_app', undefined),
      ).toBeNull();
    });

    it('returns null when password is empty string', () => {
      expect(
        deriveAppConnectionString('postgresql://breeze:x@db:5432/breeze', 'breeze_app', ''),
      ).toBeNull();
    });

    it('returns null when admin URL is unparseable', () => {
      expect(deriveAppConnectionString('not a url', 'breeze_app', 'pw')).toBeNull();
    });

    it('works with postgres:// scheme as well as postgresql://', () => {
      const result = deriveAppConnectionString(
        'postgres://breeze:secret@db:5432/breeze',
        'breeze_app',
        'app_secret',
      );
      expect(result).toBe('postgres://breeze_app:app_secret@db:5432/breeze');
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

  // Regression test for issue #506. A `localeCompare` sort places
  // `2026-04-19-installer-bootstrap-tokens-constraints.sql` before
  // `...-tokens.sql` (because '-' < '.'), so the constraints migration ran
  // before the table that owns those constraints existed. This scans every
  // migration in the same order autoMigrate uses and asserts that each
  // referenced table was created in this file or an earlier one.
  describe('migration ordering', () => {
    const MIGRATION_FILE_PATTERN = /^\d{4}-.*\.sql$/;
    const migrationsDir = path.resolve(__dirname, '../../migrations');

    const SYSTEM_TABLES = new Set([
      'pg_policies',
      'pg_indexes',
      'pg_class',
      'pg_namespace',
      'pg_trigger',
      'pg_proc',
      'pg_constraint',
      'pg_attribute',
      'pg_type',
      'pg_tables',
      'information_schema',
    ]);

    function collectMatches(sql: string, pattern: RegExp): string[] {
      const out: string[] = [];
      for (const match of sql.matchAll(pattern)) {
        if (match[1]) out.push(match[1].toLowerCase());
      }
      return out;
    }

    function extractCreatedTables(sql: string): string[] {
      return collectMatches(
        sql,
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
      );
    }

    function extractReferencedTables(sql: string): string[] {
      const stripped = sql
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      // Only patterns that hard-fail when the table is missing. Tolerant
      // forms like `DROP TABLE IF EXISTS` or `ALTER TABLE IF EXISTS` are
      // intentionally excluded — they're a no-op against an absent table.
      const patterns = [
        /\bREFERENCES\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
        /\bALTER\s+TABLE\s+(?!IF\s+EXISTS\b)(?:ONLY\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
        /\bCREATE\s+POLICY\s+[^;]*?\bON\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
        /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[^;]*?\bON\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
        /\bCREATE\s+TRIGGER\s+[^;]*?\bON\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi,
      ];
      const refs: string[] = [];
      for (const pattern of patterns) refs.push(...collectMatches(stripped, pattern));
      return refs;
    }

    it('every referenced table is created in the same file or an earlier one', () => {
      const files = readdirSync(migrationsDir)
        .filter((name) => MIGRATION_FILE_PATTERN.test(name))
        .sort((a, b) => a.localeCompare(b));

      expect(files.length).toBeGreaterThan(0);

      const created = new Set<string>();
      const violations: string[] = [];

      for (const file of files) {
        const sql = readFileSync(path.join(migrationsDir, file), 'utf8');
        // Add tables created in this file BEFORE checking references so a
        // file that creates a table and immediately alters or self-references
        // it passes.
        for (const t of extractCreatedTables(sql)) created.add(t);
        for (const ref of extractReferencedTables(sql)) {
          if (SYSTEM_TABLES.has(ref)) continue;
          if (created.has(ref)) continue;
          violations.push(`${file} references "${ref}" before it is created`);
        }
      }

      expect(violations).toEqual([]);
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
