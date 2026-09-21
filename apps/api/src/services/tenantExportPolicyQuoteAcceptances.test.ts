import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { CORE_TENANT_EXPORT_POLICY } from './tenantExportPolicyRegistry';
import { quoteAcceptances } from '../db/schema/quotes';

/**
 * The export-policy registry fires on a NEW COLUMN of an already-registered
 * org-cascade table, not just on a new table (CLAUDE.md, the one row of the
 * cascade table that behaves that way). This asserts the four on-behalf columns
 * are classified, and classified as ordinary customer data: none is json/jsonb/
 * bytea, and none matches SUSPICIOUS_NAME_PARTS.
 */
describe('quote_acceptances export policy covers the on-behalf columns', () => {
  const policy = CORE_TENANT_EXPORT_POLICY['quote_acceptances'];

  it('classifies every column of the Drizzle table', () => {
    expect(policy).toBeDefined();
    const columns = Object.values(getTableColumns(quoteAcceptances)).map((c) => c.name);
    for (const column of columns) {
      expect(Object.keys(policy!.columns), `unclassified column ${column}`).toContain(column);
    }
  });

  it('puts the four provenance columns in `included`', () => {
    for (const col of ['origin', 'method', 'reference', 'recorded_by_user_id']) {
      expect(policy!.columns[col]?.decision, `${col} must be exported with the tenant's data`).toBe('include');
    }
  });
});
