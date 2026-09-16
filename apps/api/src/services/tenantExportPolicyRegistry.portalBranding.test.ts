import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { portalBranding } from '../db/schema/portal';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * chrome_accent (packages/shared/src/types/portalChromeAccent.ts) added
 * alongside the migration in this same PR. portal_branding is an org-cascade
 * table, so `tenant-export-policy.integration.test.ts` classifies every
 * column of it — but that suite needs a live database, so a missed
 * classification only reds in Integration Tests. Pinning it here moves the
 * failure into Test API, same reasoning as the network_monitors TLS-column
 * test (tenantExportPolicyRegistry.tls.test.ts).
 */
describe('portal_branding.chrome_accent export policy', () => {
  it('is mapped and included (plain enum-shaped varchar, not jsonb/bytea, no SUSPICIOUS_NAME_PARTS hit)', () => {
    expect(
      getTenantExportPolicyRegistry()['portal_branding']?.columns['chrome_accent']?.decision,
    ).toBe('include');
    expect(
      (getTableColumns(portalBranding) as Record<string, { name: string }>)['chromeAccent']?.name,
    ).toBe('chrome_accent');
  });
});
