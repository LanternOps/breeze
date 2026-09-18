import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { CORE_TENANT_EXPORT_POLICY } from './tenantExportPolicyRegistry';
import { snmpTemplates } from '../db/schema';

/**
 * The export-policy registry is the ONE registration list that fires on a new
 * COLUMN rather than a new table, and its own contract suites
 * (tenant-export-policy / tenantExportErasureRoundtrip) only run under
 * Integration Tests — a unit-green PR still reddens main there. This mirrors
 * the column set statically so the miss shows up in Test API instead.
 */
describe('snmp_templates export policy covers every column', () => {
  it('classifies each Drizzle column', () => {
    const policy = CORE_TENANT_EXPORT_POLICY['snmp_templates'];
    expect(policy).toBeDefined();
    const dbColumns = Object.values(getTableColumns(snmpTemplates))
      .map((c) => c.name);
    for (const column of dbColumns) {
      expect(Object.keys(policy!.columns), `unclassified column ${column}`).toContain(column);
    }
    expect(policy!.columns['sys_object_id_prefixes']?.decision).toBe('include');
  });
});
