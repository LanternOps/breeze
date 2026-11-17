import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { customerEmailDomains } from '../db/schema/emailInbound';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Portal registration W5 (#11382). The domain verification columns are new on
 * an org-cascade table, so `tenant-export-policy.integration.test.ts` classifies
 * them — but only under Integration Tests. Pinning it here moves the failure
 * into Test API (same reasoning as tenantExportPolicyRegistry.portalEntraProof.test.ts).
 */
describe('customer_email_domains export policy', () => {
  it('classifies every customer_email_domains column; verification_token is excludedSensitive, verified_evidence is excludedOpen', () => {
    const reg = getTenantExportPolicyRegistry()['customer_email_domains'];
    expect(reg, 'customer_email_domains has no export policy entry').toBeDefined();
    const columns = Object.values(getTableColumns(customerEmailDomains) as Record<string, { name: string }>).map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining([
      'verification_token', 'verified_at', 'verified_method', 'verified_evidence', 'verified_by_user_id',
      'last_checked_at', 'last_passed_at', 'last_check_status', 'check_failures', 'cleared_at', 'cleared_reason',
    ]));
    for (const col of columns) {
      expect(reg?.columns[col]?.decision, col).toBeDefined();
    }
    // excludedSensitive vs excludedOpen differ only by rationale.
    expect(reg?.columns['verification_token']).toMatchObject({ decision: 'exclude', rationale: expect.stringMatching(/^Authentication, credential/) });
    expect(reg?.columns['verified_evidence']).toMatchObject({ decision: 'exclude', openContainerReviewed: true, rationale: expect.stringMatching(/^Open-ended container/) });
    for (const col of ['verified_at', 'verified_method', 'verified_by_user_id', 'last_checked_at', 'last_passed_at',
      'last_check_status', 'check_failures', 'cleared_at', 'cleared_reason']) {
      expect(reg?.columns[col]?.decision, col).toBe('include');
    }
  });
});
