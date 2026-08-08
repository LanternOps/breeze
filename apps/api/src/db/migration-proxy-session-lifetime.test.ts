import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { tunnelSessions } from './schema/tunnels';
import { CORE_TENANT_EXPORT_POLICY } from '../services/tenantExportPolicyRegistry';

/**
 * Proxy access consolidation (#3199) — Task 1: tunnel_sessions.last_activity_at
 * + tunnel_allowlists dedupe/expression-unique-index migration.
 *
 * Spec: docs/superpowers/specs/monitoring/2026-08-08-proxy-access-consolidation-design.md
 * (Architecture A.4, C.2).
 *
 * NOTE ON COVERAGE: this file is a structural/static check of the migration
 * SQL and its Drizzle/export-policy mirrors — it does NOT execute the SQL
 * against Postgres (no live DB is available in this environment). The
 * collapse logic's actual runtime behavior (survivor selection, bool_or
 * folding, index-build success after collapse) can only be verified against
 * a real database — that verification is still outstanding and must happen
 * in CI or a real dev environment before merge.
 *
 * `./autoMigrate.test.ts` is deliberately NOT reused as a base here: importing
 * `./autoMigrate` transitively pulls in `./seed`, which crashes the vitest
 * worker in this sandboxed environment (reproduced on a clean, unmodified
 * tree via `git stash` — not caused by this change). This file avoids that
 * import graph entirely and reads the migration file directly instead.
 */

const MIGRATION_PATH = join(
  __dirname,
  '../../migrations/2026-08-08-proxy-session-lifetime.sql',
);
const sql = readFileSync(MIGRATION_PATH, 'utf8');

describe('2026-08-08-proxy-session-lifetime.sql', () => {
  it('is discoverable by the migration runner\'s filename pattern', () => {
    // apps/api/src/db/autoMigrate.ts discovers files matching this pattern
    // and applies them in localeCompare order. A name that doesn't match is
    // silently never applied.
    expect(/^\d{4}-.*\.sql$/.test('2026-08-08-proxy-session-lifetime.sql')).toBe(true);
  });

  it('adds tunnel_sessions.last_activity_at idempotently as timestamptz', () => {
    expect(sql).toContain(
      'ALTER TABLE "tunnel_sessions" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamptz;',
    );
  });

  it('creates the expression unique index without a WHERE clause (not a partial index)', () => {
    const marker = 'CREATE UNIQUE INDEX IF NOT EXISTS "tunnel_allowlists_org_direction_pattern_site_idx"';
    expect(sql).toContain(marker);
    const fromIndex = sql.slice(sql.indexOf(marker));
    expect(fromIndex).not.toMatch(/\bWHERE\b/i);
    // Same key the collapse below dedupes on.
    expect(fromIndex).toContain('"org_id"');
    expect(fromIndex).toContain('"direction"');
    expect(fromIndex).toContain('"pattern"');
    expect(fromIndex).toContain(
      "COALESCE(\"site_id\", '00000000-0000-0000-0000-000000000000'::uuid)",
    );
  });

  it('collapses colliding tunnel_allowlists rows keeping the OLDEST survivor', () => {
    expect(sql).toContain(
      'PARTITION BY org_id, direction, pattern, COALESCE(site_id, \'00000000-0000-0000-0000-000000000000\'::uuid)',
    );
    expect(sql).toContain('ORDER BY created_at ASC, id ASC');
  });

  it('folds enabled = bool_or(enabled) across the colliding group into the survivor before deleting losers', () => {
    expect(sql).toContain('bool_or(ta.enabled)');
    expect(sql).toMatch(/UPDATE tunnel_allowlists ta\s+SET enabled = m\.group_enabled/);
    // The UPDATE (fold) must run before the DELETE (loser removal).
    expect(sql.indexOf('SET enabled = m.group_enabled')).toBeLessThan(
      sql.indexOf('DELETE FROM tunnel_allowlists'),
    );
  });

  it('reports the collapsed row count unconditionally, even when zero (forensic-trail convention)', () => {
    expect(sql).toContain('GET DIAGNOSTICS n = ROW_COUNT;');
    expect(sql).toContain(
      "RAISE WARNING 'collapsed % duplicate tunnel_allowlists rows', n;",
    );
    // Deliberately NOT gated behind `IF n > 0 THEN` — see
    // 2026-06-27-c-default-update-ring-dedup.sql for the same precedent.
    expect(sql).not.toContain('IF n > 0');
  });

  it('does not open its own transaction block', () => {
    // autoMigrate wraps each file in client.begin(...) already; an inner
    // BEGIN;/COMMIT; just emits a harmless NOTICE and serves no purpose. The
    // DO $$ ... BEGIN ... END $$ block's BEGIN is a PL/pgSQL block header, not
    // transaction control, and is never followed directly by a semicolon.
    expect(sql).not.toMatch(/\bBEGIN;/);
    expect(sql).not.toMatch(/\bCOMMIT;/i);
  });

  it('every ALTER/CREATE statement is idempotency-guarded (IF NOT EXISTS or DO $$ ... EXCEPTION)', () => {
    const alterLines = sql.split('\n').filter((line) => /^\s*ALTER TABLE\b/i.test(line));
    for (const line of alterLines) {
      expect(line).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    }
    const createLines = sql.split('\n').filter((line) => /^\s*CREATE (UNIQUE )?INDEX\b/i.test(line));
    expect(createLines.length).toBeGreaterThan(0);
    for (const line of createLines) {
      expect(line).toMatch(/IF NOT EXISTS/i);
    }
    // No bare CREATE TABLE/TYPE (this migration only ALTERs/dedupes/indexes
    // pre-existing objects from 2026-04-03-tunnel-sessions.sql).
    expect(sql).not.toMatch(/^\s*CREATE TABLE\b/im);
  });
});

describe('tunnelSessions.lastActivityAt (Drizzle schema mirror)', () => {
  it('matches the migration column: nullable timestamptz', () => {
    const column = getTableConfig(tunnelSessions).columns.find(
      (candidate) => candidate.name === 'last_activity_at',
    );
    expect(column).toBeDefined();
    expect(column?.notNull).toBe(false);
    expect(column?.columnType).toBe('PgTimestamp');
    expect((column as unknown as { withTimezone: boolean }).withTimezone).toBe(true);
    expect(column?.getSQLType()).toBe('timestamp with time zone');
  });
});

describe('tunnel_sessions export-policy registration (#3199)', () => {
  it('classifies last_activity_at as included — org-cascade table, unregistered ADD COLUMN breaks the export-policy integration suite', () => {
    const policy = CORE_TENANT_EXPORT_POLICY['tunnel_sessions'];
    if (!policy) throw new Error('tunnel_sessions export policy is not registered');
    expect(policy.columns['last_activity_at']).toBeDefined();
    expect(policy.columns['last_activity_at']?.decision).toBe('include');
  });
});
