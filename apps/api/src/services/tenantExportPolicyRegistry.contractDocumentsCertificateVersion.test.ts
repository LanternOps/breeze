import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { contractDocuments } from '../db/schema/contractDocuments';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * #10513 adds `certificate_version` to `contract_documents`, an org-cascade
 * table, so it must be classified in CORE_TENANT_EXPORT_POLICY. The
 * live-database suite (tenant-export-policy.integration.test.ts) is the real
 * contract but only runs in Integration Tests; pinning it here moves a miss
 * into Test API (same reasoning as the quote_acceptances evidence test).
 */
describe('contract_documents certificate_version export policy (#10513)', () => {
  const columns = getTenantExportPolicyRegistry()['contract_documents']?.columns ?? {};
  const drizzleNames = new Set(
    Object.values(getTableColumns(contractDocuments) as Record<string, { name: string }>).map((c) => c.name),
  );

  it('certificate_version exists and is included (a plain smallint, part of the signed record)', () => {
    expect(drizzleNames.has('certificate_version')).toBe(true);
    expect(columns['certificate_version']?.decision).toBe('include');
  });

  it('every Drizzle column of contract_documents is classified', () => {
    for (const name of drizzleNames) expect(columns[name], name).toBeDefined();
  });
});
