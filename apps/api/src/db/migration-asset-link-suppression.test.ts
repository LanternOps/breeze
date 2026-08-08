import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { discoveredAssets } from './schema/discovery';
import { CORE_TENANT_EXPORT_POLICY } from '../services/tenantExportPolicyRegistry';

/**
 * Asset-link lifecycle (#3261) — Task 1: discovered_assets.auto_link_suppressed_at
 * migration.
 *
 * Spec: docs/superpowers/specs/monitoring/2026-08-08-asset-link-lifecycle-design.md
 * (Architecture A.1-A.4).
 *
 * NOTE ON COVERAGE: this file is a structural/static check of the migration
 * SQL and its Drizzle/export-policy mirrors — it does NOT execute the SQL
 * against Postgres (no live DB is available in this environment). Runtime
 * verification (`pnpm db:migrate && pnpm db:check-drift`, plus the
 * export-policy integration suite) is still outstanding and must happen in CI
 * or a real dev environment before merge.
 *
 * `./autoMigrate.test.ts` is deliberately NOT reused as a base here — see
 * `./migration-proxy-session-lifetime.test.ts` for why (importing
 * `./autoMigrate` transitively pulls in `./seed`, which crashes the vitest
 * worker in this sandboxed environment). This file reads the migration file
 * directly instead.
 */

const MIGRATION_PATH = join(
  __dirname,
  '../../migrations/2026-08-08-asset-link-suppression.sql',
);
const sql = readFileSync(MIGRATION_PATH, 'utf8');

describe('2026-08-08-asset-link-suppression.sql', () => {
  it("is discoverable by the migration runner's filename pattern", () => {
    // apps/api/src/db/autoMigrate.ts discovers files matching this pattern
    // and applies them in localeCompare order. A name that doesn't match is
    // silently never applied.
    expect(/^\d{4}-.*\.sql$/.test('2026-08-08-asset-link-suppression.sql')).toBe(true);
  });

  it('adds discovered_assets.auto_link_suppressed_at idempotently as timestamptz', () => {
    expect(sql).toContain(
      'ALTER TABLE "discovered_assets" ADD COLUMN IF NOT EXISTS "auto_link_suppressed_at" timestamptz;',
    );
  });

  it('does not open its own transaction block', () => {
    // autoMigrate wraps each file in client.begin(...) already; an inner
    // BEGIN;/COMMIT; just emits a harmless NOTICE and serves no purpose.
    expect(sql).not.toMatch(/\bBEGIN;/);
    expect(sql).not.toMatch(/\bCOMMIT;/i);
  });

  it('every ALTER statement is idempotency-guarded (ADD COLUMN IF NOT EXISTS)', () => {
    const alterLines = sql.split('\n').filter((line) => /^\s*ALTER TABLE\b/i.test(line));
    expect(alterLines.length).toBeGreaterThan(0);
    for (const line of alterLines) {
      expect(line).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    }
    // No bare CREATE TABLE/TYPE — this migration only ALTERs the pre-existing
    // discovered_assets table.
    expect(sql).not.toMatch(/^\s*CREATE TABLE\b/im);
  });

  it('explains the durable-unlink rationale (not just the raw column add)', () => {
    // Guards against a future "simplify the comments" pass losing the reason
    // this column exists (CLAUDE.md working-instruction for this task).
    expect(sql).toMatch(/re-runs the mac\/ip auto-linker/i);
    expect(sql.toLowerCase()).toContain('scan cycle');
  });
});

describe('discoveredAssets.autoLinkSuppressedAt (Drizzle schema mirror)', () => {
  it('matches the migration column: nullable timestamptz', () => {
    const column = getTableConfig(discoveredAssets).columns.find(
      (candidate) => candidate.name === 'auto_link_suppressed_at',
    );
    expect(column).toBeDefined();
    expect(column?.notNull).toBe(false);
    expect(column?.columnType).toBe('PgTimestamp');
    expect((column as unknown as { withTimezone: boolean }).withTimezone).toBe(true);
    expect(column?.getSQLType()).toBe('timestamp with time zone');
  });
});

describe('discovered_assets export-policy registration (#3261)', () => {
  it('classifies auto_link_suppressed_at as included — org-cascade table, unregistered ADD COLUMN breaks the export-policy integration suite', () => {
    const policy = CORE_TENANT_EXPORT_POLICY['discovered_assets'];
    if (!policy) throw new Error('discovered_assets export policy is not registered');
    expect(policy.columns['auto_link_suppressed_at']).toBeDefined();
    expect(policy.columns['auto_link_suppressed_at']?.decision).toBe('include');
  });
});
