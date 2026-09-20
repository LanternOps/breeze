import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  deviceFilesystemCleanupRuns,
  deviceFilesystemScanState,
  deviceFilesystemSnapshots,
  filesystemCleanupRunStatusEnum,
} from './filesystem';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

/**
 * The static half of the W02 schema contract. The LIVE half — that the
 * database actually has this shape — is
 * `__tests__/integration/filesystemMultiVolumeMigration.integration.test.ts`;
 * `db:check-drift` does not compare the Drizzle mirror to a database at all
 * (apps/api/scripts/check-drift.ts:17-34), so neither test substitutes for the
 * other.
 */
describe('filesystem schema — the scan-path axis (spec §4)', () => {
  it('records scan_path on snapshots, NULLABLE in W02', () => {
    // Expand/contract (amendment 15, spec §13 #7): an old replica still
    // draining supplies no scan_path, and NOT NULL here would fail its
    // snapshot INSERT with 23502 and lose a completed scan. W03 contracts.
    const column = getTableConfig(deviceFilesystemSnapshots).columns
      .find((c) => c.name === 'scan_path');
    expect(column).toBeDefined();
    expect(column!.notNull).toBe(false);
  });

  it('indexes snapshots on (device_id, scan_path, captured_at) and drops the old two-column index', () => {
    const indexes = getTableConfig(deviceFilesystemSnapshots).indexes.map((i) => i.config.name);
    expect(indexes).toContain('idx_device_filesystem_snapshots_device_path_captured');
    expect(indexes).not.toContain('idx_device_filesystem_snapshots_device_captured');
  });

  it('keys scan state on a UNIQUE INDEX over (device_id, scan_path), not a primary key', () => {
    // Amendment 16: a primary key needs the NOT NULL W03 owns, and the old
    // single-column key had to go now because it permits one row per device.
    // ON CONFLICT (device_id, scan_path) infers a plain unique index exactly
    // as it would a constraint, so the writer contract is unchanged.
    const config = getTableConfig(deviceFilesystemScanState);
    expect(config.primaryKeys).toHaveLength(0);
    const unique = config.indexes.find(
      (i) => i.config.name === 'device_filesystem_scan_state_device_path_uidx',
    );
    expect(unique, 'the (device_id, scan_path) unique index is missing').toBeDefined();
    expect(unique!.config.unique).toBe(true);
    expect(unique!.config.columns.map((c) => (c as { name: string }).name))
      .toEqual(['device_id', 'scan_path']);
  });

  it('records a nullable scan_path and scan_generation on scan state', () => {
    const byName = new Map(
      getTableConfig(deviceFilesystemScanState).columns.map((c) => [c.name, c]),
    );
    expect(byName.get('scan_path')?.notNull).toBe(false);
    // The filesystem_analysis command id owning the current run (amendment 18).
    expect(byName.get('last_applied_command_id')).toBeDefined();
    expect(byName.get('last_applied_command_id')!.notNull).toBe(false);
    expect(byName.get('scan_generation')).toBeDefined();
    expect(byName.get('scan_generation')!.notNull).toBe(false);
  });

  it('gives cleanup runs a nullable scan_path, a kind and a command_id', () => {
    const columns = getTableConfig(deviceFilesystemCleanupRuns).columns;
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get('scan_path')?.notNull).toBe(false);
    expect(byName.get('kind')?.notNull).toBe(true);
    expect(byName.get('command_id')).toBeDefined();
    expect(byName.get('command_id')!.notNull).toBe(false);
  });

  it('carries the running status, in the order Postgres sorts the labels', () => {
    expect(filesystemCleanupRunStatusEnum.enumValues).toEqual([
      'previewed',
      'executed',
      'failed',
      'running',
    ]);
  });
});

/**
 * CLAUDE.md: the export-policy row is the ONE registration list that fires on a
 * new COLUMN, not just a new table. Every column of every org-cascade table
 * must be classified, so ADD COLUMN on a long-registered table breaks
 * `tenant-export-policy.integration.test.ts` — which only runs under
 * Integration Tests, so a unit-green PR can still redden main. This unit test
 * moves that failure into Test API for the five columns this wave adds.
 */
describe('tenant export policy — W02 columns', () => {
  const expected: Array<[string, string[]]> = [
    ['device_filesystem_snapshots', ['scan_path']],
    ['device_filesystem_scan_state', ['scan_path', 'scan_generation', 'last_applied_command_id']],
    ['device_filesystem_cleanup_runs', ['scan_path', 'kind', 'command_id']],
  ];

  for (const [table, columns] of expected) {
    for (const column of columns) {
      it(`classifies ${table}.${column} as included`, () => {
        const decision = CORE_TENANT_EXPORT_POLICY[table]?.columns[column];
        expect(decision, `${table}.${column} is unclassified`).toBeDefined();
        expect(decision!.decision).toBe('include');
      });
    }
  }
});
