import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  m365CaPolicies,
  m365IntuneDevices,
  m365LicenseSkus,
  m365PostureRollups,
  m365SecureScoreSnapshots,
  m365SyncState,
  m365Users,
} from './m365Sync';

const ENTITY_COMMON = [
  'id', 'org_id', 'graph_id', 'core_hash',
  'first_seen_at', 'last_changed_at', 'is_stale', 'stale_since',
];

describe('m365 tenant sync schema', () => {
  it('every table is org-scoped with a NOT NULL org_id (tenancy shape 1)', () => {
    for (const table of [
      m365SyncState, m365Users, m365IntuneDevices, m365CaPolicies,
      m365LicenseSkus, m365SecureScoreSnapshots, m365PostureRollups,
    ]) {
      const orgId = getTableConfig(table).columns.find((c) => c.name === 'org_id');
      expect(orgId, `${getTableConfig(table).name} has no org_id`).toBeDefined();
      expect(orgId!.notNull, `${getTableConfig(table).name}.org_id must be NOT NULL`).toBe(true);
    }
  });

  it('the four entity tables share the change-detection lifecycle columns', () => {
    for (const table of [m365Users, m365IntuneDevices, m365CaPolicies, m365LicenseSkus]) {
      const names = getTableConfig(table).columns.map((c) => c.name);
      for (const column of ENTITY_COMMON) {
        expect(names, `${getTableConfig(table).name} missing ${column}`).toContain(column);
      }
    }
  });

  it('m365_sync_state carries the full claim/lease/generation protocol', () => {
    expect(getTableConfig(m365SyncState).columns.map((c) => c.name).sort()).toEqual([
      'connection_id', 'continuation', 'created_at', 'domain', 'id',
      'interval_seconds', 'last_complete_snapshot_at', 'last_counts', 'last_error',
      'last_item_count', 'last_run_at', 'last_status', 'last_success_at',
      'lease_until', 'next_sync_at', 'org_id', 'run_generation', 'sources',
      'truncated', 'updated_at',
    ].sort());
  });

  it('names the Intune link column breeze_device_id, not device_id', () => {
    // Load-bearing: `device_id` would pull the table into
    // breeze_device_child_orgid_tables() (a re-stamp loop that would fight the
    // composite FK) and into cascadeDelete.test.ts's device_id contract, both
    // of which are wrong for a link-only column. See routes/devices/moveOrg.ts.
    const names = getTableConfig(m365IntuneDevices).columns.map((c) => c.name);
    expect(names).toContain('breeze_device_id');
    expect(names).not.toContain('device_id');
    expect(names).not.toContain('linked_device_id');
  });

  it('both history tables pin the tenant the rows came from', () => {
    for (const table of [m365SecureScoreSnapshots, m365PostureRollups]) {
      const tenantId = getTableConfig(table).columns.find((c) => c.name === 'tenant_id');
      expect(tenantId, `${getTableConfig(table).name}.tenant_id missing`).toBeDefined();
      expect(tenantId!.notNull).toBe(true);
    }
  });

  it('m365_license_skus keys on graph_id so the shared persist path needs no special case', () => {
    const names = getTableConfig(m365LicenseSkus).columns.map((c) => c.name);
    expect(names).toContain('graph_id');
    expect(names).not.toContain('sku_id');
    expect(names).toContain('sku_part_number');
  });
});
