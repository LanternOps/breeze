import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { contractDocuments } from '../db/schema/contractDocuments';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * #10294 follow-up adds `template_name_snapshot` to `contract_documents`, an
 * org-cascade table, so it must be classified in CORE_TENANT_EXPORT_POLICY.
 * The live-database suite (tenant-export-policy.integration.test.ts) is the
 * real contract but only runs in Integration Tests; pinning it here moves a
 * miss into Test API (same reasoning as the quote_acceptances evidence test).
 */
describe('contract_documents template-name snapshot export policy (#10294)', () => {
  const columns = getTenantExportPolicyRegistry()['contract_documents']?.columns ?? {};
  const drizzleNames = new Set(
    Object.values(getTableColumns(contractDocuments) as Record<string, { name: string }>).map((c) => c.name),
  );

  it('template_name_snapshot exists and is included (plain varchar, part of the signed record)', () => {
    expect(drizzleNames.has('template_name_snapshot')).toBe(true);
    expect(columns['template_name_snapshot']?.decision).toBe('include');
  });

  it('every Drizzle column of contract_documents is classified', () => {
    for (const name of drizzleNames) expect(columns[name], name).toBeDefined();
  });
});
