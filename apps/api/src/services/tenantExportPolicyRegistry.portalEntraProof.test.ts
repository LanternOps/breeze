import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { clientAiTenantMappings } from '../db/schema/clientAi';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Portal registration W4 (#11381). The Entra tenant proof columns are new on an
 * org-cascade table, so `tenant-export-policy.integration.test.ts` classifies
 * them — but only under Integration Tests. Pinning it here moves the failure
 * into Test API (same reasoning as tenantExportPolicyRegistry.portalUserIdentities.test.ts).
 */
describe('client_ai_tenant_mappings export policy', () => {
  it('classifies every client_ai_tenant_mappings column; proven_evidence is excludedOpen', () => {
    const reg = getTenantExportPolicyRegistry()['client_ai_tenant_mappings'];
    expect(reg, 'client_ai_tenant_mappings has no export policy entry').toBeDefined();
    const columns = Object.values(getTableColumns(clientAiTenantMappings) as Record<string, { name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['proven_at', 'proven_via', 'proven_by_user_id', 'proven_evidence']));
    for (const col of columns) {
      expect(reg?.columns[col]?.decision, col).toBeDefined();
    }
    expect(reg?.columns['proven_evidence']).toMatchObject({ decision: 'exclude', openContainerReviewed: true });
    for (const col of ['proven_at', 'proven_via', 'proven_by_user_id']) {
      expect(reg?.columns[col]?.decision, col).toBe('include');
    }
  });
});
