import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import JSZip from 'jszip';

const {
  auditSensitiveReadMock,
  getReportRunMock,
  selectRows,
  rowsToCsvMock,
  rowsToXlsxMock,
} = vi.hoisted(() => ({
  auditSensitiveReadMock: vi.fn(),
  getReportRunMock: vi.fn(),
  selectRows: [] as unknown[][],
  rowsToCsvMock: vi.fn((rows: unknown[]) => `csv:${JSON.stringify(rows)}`),
  rowsToXlsxMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', {
      user: {
        id: '11111111-1111-4111-8111-111111111111',
        email: 'reader@example.com',
      },
      scope: 'organization',
      orgId: '22222222-2222-4222-8222-222222222222',
      partnerId: null,
      accessibleOrgIds: ['22222222-2222-4222-8222-222222222222'],
      canAccessOrg: (orgId: string) => orgId === '22222222-2222-4222-8222-222222222222',
    });
    await next();
  },
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const result = selectRows.shift() ?? [];
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'offset']) {
        chain[method] = vi.fn(() => chain);
      }
      chain.limit = vi.fn(() => Promise.resolve(result));
      return chain;
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  reports: {
    id: 'reports.id',
    orgId: 'reports.orgId',
    type: 'reports.type',
    name: 'reports.name',
    format: 'reports.format',
  },
  reportRuns: {
    id: 'reportRuns.id',
    reportId: 'reportRuns.reportId',
    result: 'reportRuns.result',
    artifactId: 'reportRuns.artifactId',
  },
  // Execution plane W05 (#5716): runs.ts reaches artifactService for the
  // from-artifact attach route, and that module reads this table off the
  // barrel. Present so this partial schema mock stays loadable.
  aiRunArtifacts: {
    id: 'aiRunArtifacts.id',
    orgId: 'aiRunArtifacts.orgId',
    runId: 'aiRunArtifacts.runId',
    expiresAt: 'aiRunArtifacts.expiresAt',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
  sql: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    REPORTS_EXPORT: { resource: 'reports', action: 'export' },
    REPORTS_READ: { resource: 'reports', action: 'read' },
    REPORTS_WRITE: { resource: 'reports', action: 'write' },
  },
}));

vi.mock('../../services/reportGenerationService', () => ({
  generateReport: vi.fn(),
  previousBaselineFor: vi.fn(),
  assertReportExecutionPreflight: vi.fn(),
  UnexecutableReportScopeError: class extends Error {},
}));

// This suite proves audit-byte fidelity, not scope semantics — the site-scope
// authority layer is exercised by data.sitescope.test.ts, so stub it permissive.
vi.mock('../../services/siteScope', () => ({
  decodeSiteScope: vi.fn(() => ({ kind: 'unrestricted' })),
  intersectSiteScopes: vi.fn((a: unknown) => a),
  isSiteScopeSubset: vi.fn(() => true),
  persistedSiteScopeValues: vi.fn(() => ({})),
  reportRunMultiOrgScopeSqlPredicate: vi.fn(() => ({})),
  reportRunScopeSqlPredicate: vi.fn(() => ({})),
  resolveRequestReportAuthority: vi.fn(),
  resolveRequestReportAuthorityMap: vi.fn(),
  siteScopeFingerprint: vi.fn(() => 'fp'),
  unrestrictedReportRunScopeSqlPredicate: vi.fn(() => ({})),
}));

vi.mock('./helpers', () => ({
  getReportRunWithOrgCheck: getReportRunMock,
  getReportWithOrgCheck: vi.fn(),
  ensureOrgAccess: vi.fn(),
  getPagination: vi.fn(),
}));

vi.mock('@breeze/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@breeze/shared')>();
  // Real .xlsx writer by default so the Excel test inspects actual workbook bytes.
  rowsToXlsxMock.mockImplementation(actual.rowsToXlsx);
  return {
    ...actual,
    rowsToCsv: rowsToCsvMock,
    rowsToXlsx: rowsToXlsxMock,
  };
});

vi.mock('../../services/sensitiveReadAudit', () => ({
  auditSensitiveRead: auditSensitiveReadMock,
}));

import { runsRoutes } from './runs';

const RUN_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '22222222-2222-4222-8222-222222222222';

function app() {
  const instance = new Hono();
  instance.route('/reports', runsRoutes);
  return instance;
}

/** Access shape returned by getReportRunWithOrgCheck post site-scope authority. */
function runAccess() {
  return {
    metadata: {
      id: RUN_ID,
      reportId: '44444444-4444-4444-8444-444444444444',
      orgId: ORG_ID,
    },
    // #3198 W01: the guard now also returns the run's owner axis and its
    // `reports` row condition (replacing the route's own org_id equality).
    owner: { orgId: ORG_ID },
    ownerCondition: {},
    authority: { scope: { kind: 'unrestricted' } },
    runScopePredicate: {},
  };
}

describe('report run sensitive-read audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.length = 0;
    getReportRunMock.mockResolvedValue(runAccess());
    rowsToCsvMock.mockImplementation((rows: unknown[]) => `csv:${JSON.stringify(rows)}`);
  });

  it('audits the exact CSV response bytes and actual result-row count', async () => {
    const rows = [{ hostname: 'pc-1' }, { hostname: 'pc-2' }];
    selectRows.push([{
      id: RUN_ID,
      orgId: ORG_ID,
      status: 'completed',
      result: { rows, rowCount: 999 },
      reportType: 'device_inventory',
      reportName: 'Inventory',
      reportFormat: 'csv',
    }]);

    const res = await app().request(`/reports/runs/${RUN_ID}/download`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toBe(`csv:${JSON.stringify(rows)}`);
    expect(auditSensitiveReadMock).toHaveBeenCalledWith(expect.anything(), {
      action: 'report.run.download',
      orgId: ORG_ID,
      resourceType: 'report_run',
      resourceId: RUN_ID,
      format: 'csv',
      rowCount: 2,
      byteCount: Buffer.byteLength(body, 'utf8'),
    });
  });

  it.each(['json', 'pdf'] as const)(
    'audits the exact serialized %s response payload',
    async (format) => {
      const result = { rows: [{ hostname: 'pc-1' }], rowCount: 1 };
      selectRows.push([{
      id: RUN_ID,
      orgId: ORG_ID,
      status: 'completed',
        result,
        reportType: 'device_inventory',
        reportName: 'Inventory',
        reportFormat: format,
      }]);

      const res = await app().request(`/reports/runs/${RUN_ID}/download?format=${format}`);
      const body = await res.text();
      const expectedBody = JSON.stringify({ type: 'device_inventory', format, data: result });

      expect(res.status).toBe(200);
      expect(body).toBe(expectedBody);
      expect(auditSensitiveReadMock).toHaveBeenCalledWith(expect.anything(), {
        action: 'report.run.download',
        orgId: ORG_ID,
        resourceType: 'report_run',
        resourceId: RUN_ID,
        format,
        rowCount: 1,
        byteCount: Buffer.byteLength(expectedBody, 'utf8'),
      });
    },
  );

  // #9956: "Excel" used to be TSV text saved as .xls (Excel warned on open).
  it('serves Excel as a real .xlsx workbook and audits its byte length', async () => {
    const rows = [{ hostname: 'pc-1', cpuPercent: 12 }];
    selectRows.push([{
      id: RUN_ID,
      orgId: ORG_ID,
      status: 'completed',
      result: { rows },
      reportType: 'device_inventory',
      reportName: 'Inventory',
      reportFormat: 'excel',
    }]);

    const res = await app().request(`/reports/runs/${RUN_ID}/download?format=excel`);
    const body = new Uint8Array(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers.get('content-disposition')).toMatch(
      /^attachment; filename="device_inventory-report-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    expect(rowsToXlsxMock).toHaveBeenCalledWith(rows);
    const sheet = await (await JSZip.loadAsync(body)).file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toContain('>hostname</t>');
    expect(sheet).toContain('>cpuPercent</t>');
    expect(sheet).toContain('>pc-1</t>');
    expect(sheet).toContain('<c r="B2"><v>12</v></c>');
    expect(auditSensitiveReadMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      format: 'excel',
      rowCount: 1,
      byteCount: body.byteLength,
    }));
  });

  it('answers 409 without auditing when the rows do not fit an Excel worksheet', async () => {
    rowsToXlsxMock.mockImplementationOnce(() => {
      throw new RangeError('too many rows');
    });
    selectRows.push([{
      id: RUN_ID,
      orgId: ORG_ID,
      status: 'completed',
      result: { rows: [{ hostname: 'pc-1' }] },
      reportType: 'device_inventory',
      reportName: 'Inventory',
      reportFormat: 'excel',
    }]);

    const res = await app().request(`/reports/runs/${RUN_ID}/download?format=excel`);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: expect.stringContaining('CSV') });
    expect(auditSensitiveReadMock).not.toHaveBeenCalled();
  });

  it('does not query or audit a missing or unauthorized run', async () => {
    getReportRunMock.mockResolvedValueOnce(null);

    const res = await app().request(`/reports/runs/${RUN_ID}/download`);

    expect(res.status).toBe(404);
    expect(selectRows).toHaveLength(0);
    expect(auditSensitiveReadMock).not.toHaveBeenCalled();
  });

  it('does not audit a non-completed run', async () => {
    selectRows.push([{
      id: RUN_ID,
      orgId: ORG_ID,
      status: 'failed',
      result: null,
      reportType: 'device_inventory',
      reportName: 'Inventory',
      reportFormat: 'csv',
    }]);

    const res = await app().request(`/reports/runs/${RUN_ID}/download`);

    expect(res.status).toBe(409);
    expect(auditSensitiveReadMock).not.toHaveBeenCalled();
  });

  it('does not audit an empty tabular report', async () => {
    selectRows.push([{
      id: RUN_ID,
      orgId: ORG_ID,
      status: 'completed',
      result: { rows: [] },
      reportType: 'device_inventory',
      reportName: 'Inventory',
      reportFormat: 'csv',
    }]);

    const res = await app().request(`/reports/runs/${RUN_ID}/download`);

    expect(res.status).toBe(409);
    expect(auditSensitiveReadMock).not.toHaveBeenCalled();
  });

  it.each(['json', 'pdf'] as const)('does not audit an empty %s report payload', async (format) => {
    selectRows.push([{
      id: RUN_ID,
      orgId: ORG_ID,
      status: 'completed',
      result: null,
      reportType: 'device_inventory',
      reportName: 'Inventory',
      reportFormat: format,
    }]);

    const res = await app().request(`/reports/runs/${RUN_ID}/download?format=${format}`);

    expect(res.status).toBe(409);
    expect(auditSensitiveReadMock).not.toHaveBeenCalled();
  });

  it.each([
    ['empty object', {}],
    ['empty rows', { rows: [] }],
    ['empty summary', { summary: {} }],
    ['array', []],
    ['scalar', 'malformed'],
  ])('does not audit an empty or malformed JSON report payload: %s', async (_label, result) => {
    selectRows.push([{
      id: RUN_ID,
      orgId: ORG_ID,
      status: 'completed',
      result,
      reportType: 'device_inventory',
      reportName: 'Inventory',
      reportFormat: 'json',
    }]);

    const res = await app().request(`/reports/runs/${RUN_ID}/download?format=json`);

    expect(res.status).toBe(409);
    expect(auditSensitiveReadMock).not.toHaveBeenCalled();
  });

  it('allows a meaningful summary-only JSON report and audits zero result rows', async () => {
    const result = { rows: [], summary: { totalDevices: 0 }, generatedAt: '2026-07-25T00:00:00Z' };
    selectRows.push([{
      id: RUN_ID,
      orgId: ORG_ID,
      status: 'completed',
      result,
      reportType: 'executive_summary',
      reportName: 'Executive Summary',
      reportFormat: 'json',
    }]);

    const res = await app().request(`/reports/runs/${RUN_ID}/download?format=json`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(auditSensitiveReadMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'report.run.download',
      rowCount: 0,
      byteCount: Buffer.byteLength(body, 'utf8'),
    }));
  });

  it('does not audit a serialization failure', async () => {
    selectRows.push([{
      id: RUN_ID,
      orgId: ORG_ID,
      status: 'completed',
      result: { rows: [{ hostname: 'pc-1' }] },
      reportType: 'device_inventory',
      reportName: 'Inventory',
      reportFormat: 'csv',
    }]);
    rowsToCsvMock.mockImplementationOnce(() => {
      throw new Error('serialization failed');
    });

    const res = await app().request(`/reports/runs/${RUN_ID}/download`);

    expect(res.status).toBe(500);
    expect(auditSensitiveReadMock).not.toHaveBeenCalled();
  });

  it('keeps successful response bytes unchanged when audit delivery is non-blocking', async () => {
    const rows = [{ hostname: 'pc-1' }];
    selectRows.push([{
      id: RUN_ID,
      orgId: ORG_ID,
      status: 'completed',
      result: { rows },
      reportType: 'device_inventory',
      reportName: 'Inventory',
      reportFormat: 'csv',
    }]);
    auditSensitiveReadMock.mockImplementationOnce(() => {
      void Promise.reject(new Error('audit backend unavailable')).catch(() => undefined);
    });

    const res = await app().request(`/reports/runs/${RUN_ID}/download`);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`csv:${JSON.stringify(rows)}`);
  });
});
