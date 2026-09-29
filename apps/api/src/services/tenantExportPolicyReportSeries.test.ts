import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { CORE_TENANT_EXPORT_POLICY } from './tenantExportPolicyRegistry';
import { reports, reportScheduleRecipients, reportSeriesOrgTargets } from '../db/schema/reports';

/**
 * CLAUDE.md: the export-policy row fires on a NEW COLUMN of an
 * already-registered org-cascade table, not only on a new table. Multi-org
 * report series W02 adds four columns to `reports`, one to
 * `report_schedule_recipients`, and the new org-cascade table
 * `report_series_org_targets`. None is json/jsonb/bytea and none matches
 * SUSPICIOUS_NAME_PARTS, so all go to `included`.
 */
describe('multi-org report series export policy', () => {
  it.each([
    ['reports', reports],
    ['report_schedule_recipients', reportScheduleRecipients],
    ['report_series_org_targets', reportSeriesOrgTargets],
  ] as const)('classifies every Drizzle column of %s', (name, table) => {
    const policy = CORE_TENANT_EXPORT_POLICY[name];
    expect(policy, `${name} has no export policy`).toBeDefined();
    for (const column of Object.values(getTableColumns(table)).map((c) => c.name)) {
      expect(Object.keys(policy!.columns), `unclassified ${name}.${column}`).toContain(column);
    }
  });

  it('exports the new columns as ordinary tenant data', () => {
    const expectIncluded = (table: string, columns: string[]) => {
      for (const column of columns) {
        expect(CORE_TENANT_EXPORT_POLICY[table]!.columns[column]?.decision, `${table}.${column}`).toBe('include');
      }
    };
    expectIncluded('reports', ['series_id', 'series_revision', 'archived_at', 'detached_from_series_id']);
    expectIncluded('report_schedule_recipients', ['mode']);
    expectIncluded('report_series_org_targets', ['id', 'series_id', 'org_id', 'created_at']);
  });
});
