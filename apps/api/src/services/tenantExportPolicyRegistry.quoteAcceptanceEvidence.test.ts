import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { quoteAcceptances } from '../db/schema/quotes';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * #6633 adds the on-behalf evidence columns to `quote_acceptances`, an
 * org-cascade table, so every one of them must be classified in
 * CORE_TENANT_EXPORT_POLICY. The live-database suites
 * (tenant-export-policy.integration.test.ts) are the real contract but only run
 * in Integration Tests; pinning the classification here moves a miss into
 * Test API. Same reasoning as tenantExportPolicyRegistry.portalBranding.test.ts.
 */
describe('quote_acceptances evidence columns export policy (#6633)', () => {
  const columns = getTenantExportPolicyRegistry()['quote_acceptances']?.columns ?? {};
  const drizzleNames = new Set(
    Object.values(getTableColumns(quoteAcceptances) as Record<string, { name: string }>).map((c) => c.name),
  );

  it.each([
    'evidence_storage_backend',
    'evidence_storage_key',
    'evidence_filename',
    'evidence_content_type',
    'evidence_size_bytes',
    'evidence_sha256',
    'evidence_uploaded_at',
    'evidence_uploaded_by_user_id',
  ])('%s is included', (name) => {
    expect(drizzleNames.has(name)).toBe(true);
    expect(columns[name]?.decision).toBe('include');
  });

  it('evidence_data (bytea) is excluded as an open container', () => {
    expect(drizzleNames.has('evidence_data')).toBe(true);
    expect(columns['evidence_data']?.decision).toBe('exclude');
  });

  it('every Drizzle column of quote_acceptances is classified', () => {
    for (const name of drizzleNames) expect(columns[name], name).toBeDefined();
  });
});
