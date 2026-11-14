import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { portalUserIdentities, portalUsers } from '../db/schema/portal';
import { portalDirectoryActions, portalDirectoryRuns } from '../db/schema/portalDirectory';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Portal registration W8 (#11385, plan D12): directory deprovisioning. Two new
 * org-cascade tables, nine new portal_user_identities columns and
 * portal_users.disabled_by. tenant-export-policy.integration.test.ts
 * classifies every column, but that suite needs a live database and only reds
 * under Integration Tests. Pinning it here moves the failure into Test API
 * (same reasoning as tenantExportPolicyRegistry.portalBranding.test.ts).
 *
 * Every column is a plain value (text, text[], smallint/integer, boolean,
 * timestamptz, uuid): no json/jsonb/bytea, so nothing is excludedOpen.
 */
const columnNames = (schema: Parameters<typeof getTableColumns>[0]) =>
  Object.values(getTableColumns(schema) as Record<string, { name: string }>).map((c) => c.name);

const NEW_IDENTITY_COLUMNS = [
  'disabled_at',
  'disabled_reason',
  'disabled_blockers',
  'directory_chain',
  'directory_seen_at',
  'directory_absent_runs',
  'directory_absent_since',
  'directory_last_run_id',
  'directory_rearm_since',
] as const;

describe('portal directory deprovisioning export policy (W8)', () => {
  const registry = getTenantExportPolicyRegistry();

  it.each([
    ['portal_directory_runs', portalDirectoryRuns],
    ['portal_directory_actions', portalDirectoryActions],
  ] as const)('classifies every %s column as include', (table, schema) => {
    const policy = registry[table];
    expect(policy, `${table} must be registered`).toBeDefined();
    const dbColumns = columnNames(schema);
    for (const col of dbColumns) {
      expect(policy!.columns[col]?.decision, `${table}.${col}`).toBe('include');
    }
    expect(Object.keys(policy!.columns).sort()).toEqual([...dbColumns].sort());
  });

  it('classifies every new portal_user_identities column as include', () => {
    const policy = registry['portal_user_identities'];
    const dbColumns = columnNames(portalUserIdentities);
    for (const col of NEW_IDENTITY_COLUMNS) {
      expect(dbColumns, `Drizzle portal_user_identities.${col}`).toContain(col);
      expect(policy?.columns[col]?.decision, `portal_user_identities.${col}`).toBe('include');
    }
  });

  it('classifies portal_users.disabled_by as include', () => {
    expect(columnNames(portalUsers)).toContain('disabled_by');
    expect(registry['portal_users']?.columns['disabled_by']?.decision).toBe('include');
  });
});
