import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { reportRuns, reports, reportTypeEnum } from './reports';

const executionScopeColumns = [
  'executionScopeVersion',
  'executionScopeKind',
  'executionScopeSiteIds',
  'executionScopeUserId',
  'executionScopeFingerprint',
  'executionScopeCapturedAt',
] as const;

describe('report execution scope provenance', () => {
  it.each([
    ['reports', reports],
    ['report_runs', reportRuns],
  ])('exposes all six nullable execution-scope columns on %s', (_name, table) => {
    const columns = getTableColumns(table);

    for (const columnName of executionScopeColumns) {
      expect(columns).toHaveProperty(columnName);
      expect(columns[columnName].notNull).toBe(false);
    }
  });
});

describe('reportTypeEnum', () => {
  it('includes the security & compliance posture type', () => {
    expect(reportTypeEnum.enumValues).toContain('security_compliance_posture');
  });

  it('keeps the original six types', () => {
    for (const t of [
      'device_inventory',
      'software_inventory',
      'alert_summary',
      'compliance',
      'performance',
      'executive_summary'
    ]) {
      expect(reportTypeEnum.enumValues).toContain(t);
    }
  });
});
