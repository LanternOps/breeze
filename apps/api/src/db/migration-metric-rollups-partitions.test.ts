import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('metric_rollups partition bootstrap migration', () => {
  const migrationsDir = resolve(__dirname, '../../migrations');
  const foundationMigration = '2026-06-18-metric-rollups.sql';
  const partitionMigration = '2026-06-18-n-metric-rollups-partitions.sql';
  const sql = readFileSync(join(migrationsDir, partitionMigration), 'utf8');

  it('sorts after the metric_rollups foundation migration', () => {
    const files = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b));

    expect(files).toContain(foundationMigration);
    expect(files).toContain(partitionMigration);
    expect(files.indexOf(partitionMigration)).toBeGreaterThan(files.indexOf(foundationMigration));
  });

  it('pre-creates a rolling monthly partition window at migration time', () => {
    expect(sql).toContain('FOR offset_months IN -1..3 LOOP');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS %I PARTITION OF metric_rollups');
    expect(sql).toContain('FOR VALUES FROM (%L) TO (%L)');
    expect(sql).toContain('metric_rollups_y%sm%s');
  });

  it('hardens each child partition with RLS policies and breeze_app grants', () => {
    expect(sql).toContain('ALTER TABLE %I ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE %I FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO breeze_app');
  });

  it('verifies an existing same-name relation is attached to metric_rollups', () => {
    expect(sql).toContain('FROM pg_inherits');
    expect(sql).toContain("parent.relname = 'metric_rollups'");
    expect(sql).toContain('is not attached as a metric_rollups partition');
  });
});
