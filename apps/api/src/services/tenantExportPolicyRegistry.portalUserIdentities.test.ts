import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { portalUserIdentities, portalUsers } from '../db/schema/portal';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Portal registration W2 (#11379). portal_user_identities and
 * portal_users.browser_access are new on org-cascade tables, so
 * `tenant-export-policy.integration.test.ts` classifies every column — but that
 * suite needs a live database, so a missed classification would only red in
 * Integration Tests. Pinning it here moves the failure into Test API (same
 * reasoning as tenantExportPolicyRegistry.portalBranding.test.ts).
 */
describe('portal_user_identities export policy', () => {
  it('classifies every portal_user_identities column as include', () => {
    const reg = getTenantExportPolicyRegistry()['portal_user_identities'];
    expect(reg, 'portal_user_identities has no export policy entry').toBeDefined();
    const columns = Object.values(getTableColumns(portalUserIdentities) as Record<string, { name: string }>).map((c) => c.name);
    expect(columns.length).toBe(10);
    for (const col of columns) {
      expect(reg?.columns[col]?.decision, col).toBe('include');
    }
  });

  it('classifies portal_users.browser_access as include', () => {
    expect(getTenantExportPolicyRegistry()['portal_users']?.columns['browser_access']?.decision).toBe('include');
    expect((getTableColumns(portalUsers) as Record<string, { name: string }>)['browserAccess']?.name).toBe('browser_access');
  });
});
