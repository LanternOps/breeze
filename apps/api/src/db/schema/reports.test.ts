import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import {
  reportRuns,
  reports,
  reportScheduleRecipients,
  reportTypeEnum,
} from './reports';

const executionScopeColumns = [
  'executionScopeVersion',
  'executionScopeKind',
  'executionScopeSiteIds',
  'executionScopeUserId',
  'executionScopeFingerprint',
  'executionScopeCapturedAt',
  'executionScopePrincipalKind',
] as const;

describe('report execution scope provenance', () => {
  it.each([
    ['reports', reports],
    ['report_runs', reportRuns],
  ])('exposes all execution-scope columns on %s', (_name, table) => {
    const columns = getTableColumns(table);
    for (const name of executionScopeColumns) {
      expect(columns).toHaveProperty(name);
      expect(columns[name].notNull).toBe(false);
    }
  });

  it('models portal report visibility and requester provenance', () => {
    const reportColumns = getTableColumns(reports);
    const runColumns = getTableColumns(reportRuns);

    expect(reportColumns.portalSelfService.notNull).toBe(true);
    expect(reportColumns.portalSelfService.hasDefault).toBe(true);
    expect(runColumns).toHaveProperty('requestedByKind');
    expect(runColumns).toHaveProperty('requestedByUserId');
    expect(runColumns).toHaveProperty('requestedByPortalUserId');
  });

  it('keeps requester provenance valid after either requester is deleted', () => {
    const check = getTableConfig(reportRuns).checks.find(
      (candidate) => candidate.name === 'report_runs_requested_by_shape_chk',
    );
    expect(check).toBeDefined();

    const compiled = new PgDialect().sqlToQuery(check!.value).sql
      .replace(/\s+/g, ' ')
      .toLowerCase();
    expect(compiled).toContain(
      `"report_runs"."requested_by_kind" = 'user' and "report_runs"."requested_by_portal_user_id" is null`,
    );
    expect(compiled).toContain(
      `"report_runs"."requested_by_kind" = 'portal_user' and "report_runs"."requested_by_user_id" is null`,
    );
    expect(compiled).not.toContain(
      `"report_runs"."requested_by_kind" = 'user' and "report_runs"."requested_by_user_id" is not null`,
    );
    expect(compiled).not.toContain(
      `"report_runs"."requested_by_kind" = 'portal_user' and "report_runs"."requested_by_portal_user_id" is not null`,
    );
  });

  it('models contact-bound report schedule recipients', () => {
    const columns = getTableColumns(reportScheduleRecipients);
    expect(Object.keys(columns)).toEqual([
      'id',
      'reportId',
      'orgId',
      'contactId',
      'createdAt',
    ]);
    expect(columns.reportId.notNull).toBe(true);
    expect(columns.orgId.notNull).toBe(true);
    expect(columns.contactId.notNull).toBe(true);
  });
});

describe('reportTypeEnum', () => {
  it('includes both portal-safe report types', () => {
    expect(reportTypeEnum.enumValues).toContain('executive_summary');
    expect(reportTypeEnum.enumValues).toContain(
      'security_compliance_posture',
    );
  });
});
