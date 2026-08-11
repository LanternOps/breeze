import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `tenancy.orgExportColumns` must classify EVERY live column of EVERY table in
 * `tenancy.orgCascadeDeleteTables` — include or exclude, no third option.
 *
 * The host enforces this against `information_schema` at export time
 * (buildTenantExportPlan → "policy columns do not match live table"), which
 * means a migration that adds a column without touching the manifest breaks the
 * GDPR right-of-access export for every org in the deployment, and does so
 * silently until someone requests an export. This test moves that failure to
 * the commit that adds the column: it parses the migration DDL and diffs it
 * against the manifest.
 */

const ROOT = path.resolve(__dirname, '..');

/** Column names per table, replaying CREATE TABLE / ADD COLUMN / DROP COLUMN. */
function columnsFromMigrations(): Map<string, string[]> {
  const dir = path.join(ROOT, 'migrations');
  const columns = new Map<string, string[]>();
  const add = (table: string, column: string) => {
    const existing = columns.get(table) ?? [];
    if (!existing.includes(column)) existing.push(column);
    columns.set(table, existing);
  };

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(path.join(dir, file), 'utf8');

    for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(\n([\s\S]*?)\n\);/g)) {
      const table = match[1]!;
      for (const rawLine of match[2]!.split('\n')) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('--')) continue;
        const column = /^([a-z_]+) /.exec(line)?.[1];
        if (column === undefined) continue;
        // Table-level constraint clauses are not columns.
        if (['primary', 'unique', 'constraint', 'foreign', 'check'].includes(column)) continue;
        add(table, column);
      }
    }

    for (const match of sql.matchAll(/ALTER TABLE (\w+)\s+ADD COLUMN IF NOT EXISTS (\w+)/g)) {
      add(match[1]!, match[2]!);
    }
    for (const match of sql.matchAll(/ALTER TABLE (\w+)\s+DROP COLUMN IF EXISTS (\w+)/g)) {
      const existing = columns.get(match[1]!);
      if (existing) columns.set(match[1]!, existing.filter((c) => c !== match[2]!));
    }
  }
  return columns;
}

interface ManifestTenancy {
  orgCascadeDeleteTables: string[];
  orgExportColumns?: Record<string, { include: string[]; exclude: string[] }>;
}

const tenancy = (
  JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')) as {
    tenancy: ManifestTenancy;
  }
).tenancy;

describe('manifest tenancy.orgExportColumns', () => {
  const migrationColumns = columnsFromMigrations();

  it('parses the migration DDL it is diffing against', () => {
    // Guards the parser itself: a silently-empty parse would make every
    // assertion below vacuous.
    expect(migrationColumns.size).toBeGreaterThanOrEqual(
      tenancy.orgCascadeDeleteTables.length,
    );
  });

  it.each(tenancy.orgCascadeDeleteTables)(
    'classifies every column of %s exactly once',
    (table) => {
      const live = migrationColumns.get(table);
      expect(live, `no CREATE TABLE found for ${table}`).toBeDefined();

      const policy = tenancy.orgExportColumns?.[table];
      expect(policy, `no orgExportColumns entry for ${table}`).toBeDefined();

      const classified = [...policy!.include, ...policy!.exclude];
      expect([...classified].sort()).toEqual([...live!].sort());
      // No column may be both included and excluded (the host rejects overlap).
      expect(new Set(classified).size).toBe(classified.length);
    },
  );

  it('never exports the encrypted source credential', () => {
    expect(tenancy.orgExportColumns?.workspace_sources?.exclude)
      .toContain('credential_enc');
  });
});
