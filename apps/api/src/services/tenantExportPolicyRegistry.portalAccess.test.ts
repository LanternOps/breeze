import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { portalAccessPolicies, portalAccessRequests } from '../db/schema/portalAccess';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * portal access policy + request tables (W3, #11380). Both are org-cascade
 * tables, so tenant-export-policy.integration.test.ts classifies every column,
 * but that suite needs a live database and only reds under Integration Tests.
 * Pinning it here moves the failure into Test API (same reasoning as
 * tenantExportPolicyRegistry.portalBranding.test.ts).
 */
describe('portal access tables export policy (W3)', () => {
  const registry = getTenantExportPolicyRegistry();

  it.each([
    ['portal_access_policies', portalAccessPolicies],
    ['portal_access_requests', portalAccessRequests],
  ] as const)('classifies every %s column as include', (table, schema) => {
    const policy = registry[table];
    expect(policy, `${table} must be registered`).toBeDefined();
    const dbColumns = Object.values(getTableColumns(schema) as Record<string, { name: string }>).map((c) => c.name);
    for (const col of dbColumns) {
      expect(policy!.columns[col]?.decision, `${table}.${col}`).toBe('include');
    }
    expect(Object.keys(policy!.columns).sort()).toEqual([...dbColumns].sort());
  });

  it('keeps password_mode via reviewedIncluded (holds a mode, not a secret)', () => {
    expect(registry['portal_access_policies']?.columns['password_mode']?.decision).toBe('include');
  });
});
