/**
 * #5020 Tier 1 — guards the discovery_jobs / organization_users / automations
 * sweep-index migration. The live shape (column order, validity, partial
 * predicate) is proved against real Postgres in
 * `__tests__/integration/tier1SweepIndexes.integration.test.ts`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const MIGRATION = '2026-12-23-100000-tier1-sweep-indexes.sql';

const TIER1_SWEEP_INDEXES = [
  { table: 'discovery_jobs', index: 'discovery_jobs_profile_status_idx', columns: '(profile_id, status)' },
  { table: 'discovery_jobs', index: 'discovery_jobs_status_updated_at_idx', columns: '(status, updated_at)' },
  { table: 'organization_users', index: 'organization_users_org_user_idx', columns: '(org_id, user_id)' },
  { table: 'organization_users', index: 'organization_users_user_id_idx', columns: '(user_id)' },
  { table: 'automations', index: 'automations_enabled_org_idx', columns: '(org_id) WHERE enabled' },
] as const;

function listMigrationFilenames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((filename) => /^\d{4}-.*\.sql$/.test(filename))
    .sort((a, b) => a.localeCompare(b));
}

function readStatements(): string {
  // Strip `--` comments: the file's prose may mention words like UPDATE.
  return readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*--/.test(line))
    .join('\n');
}

describe('Tier-1 sweep indexes migration (#5020)', () => {
  it('is present and sorts after the newest migration it was authored on top of', () => {
    const files = listMigrationFilenames();
    expect(files).toContain(MIGRATION);
    // Assert the anchor exists so a rename cannot make indexOf return -1 and
    // pass the ordering check vacuously.
    expect(files).toContain('2026-12-22-100000-fix-memory-rebuild-attempted-at.sql');
    expect(files.indexOf(MIGRATION)).toBeGreaterThan(
      files.indexOf('2026-12-22-100000-fix-memory-rebuild-attempted-at.sql'),
    );
  });

  it('is a @no-transaction file — CREATE INDEX CONCURRENTLY cannot run in a transaction block', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), 'utf8');
    expect(sql.split('\n')[0]).toMatch(/^\s*--\s*@no-transaction\b/);
  });

  it('contains indexes only — no DML, no scope elevation, no inner BEGIN/COMMIT', () => {
    const statements = readStatements();
    expect(statements).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/i);
    expect(statements).not.toMatch(/\bset_config\s*\(/i);
    expect(statements).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it('creates every index concurrently and idempotently on its table', () => {
    const statements = readStatements().replace(/\s+/g, ' ');
    for (const { table, index } of TIER1_SWEEP_INDEXES) {
      expect(statements).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index} ON public.${table} `);
    }
  });

  it('fails loudly on an INVALID index left by an interrupted CONCURRENTLY build', () => {
    const statements = readStatements();
    expect(statements).toMatch(/indisvalid/);
    expect(statements).toMatch(/RAISE EXCEPTION/);
    for (const { table, index } of TIER1_SWEEP_INDEXES) {
      expect(statements).toMatch(new RegExp(`'public\\.${table}'::regclass,\\s*'${index}'`));
    }
  });
});
