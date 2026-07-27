import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const permissionState = vi.hoisted(() => ({
  deny: false,
  last: null as { resource: string; action: string } | null,
  permissions: undefined as { allowedSiteIds?: string[] } | undefined
}));

// Mutable auth context so individual tests can exercise partner/system scopes
// (mirrors the permissionState pattern). Defaults to an org-scoped caller.
const authState = vi.hoisted(() => {
  const ORG = '11111111-1111-1111-1111-111111111111';
  const makeDefault = () => ({
    user: { id: 'user-123', email: 'test@example.com' },
    scope: 'organization' as string,
    partnerId: null as string | null,
    orgId: ORG as string | null,
    accessibleOrgIds: [ORG] as string[],
    canAccessOrg: ((orgId: string) => orgId === ORG) as (orgId: string) => boolean
  });
  return { makeDefault, auth: makeDefault() as ReturnType<typeof makeDefault> };
});

const siteScopeState = vi.hoisted(() => {
  const orgId = '11111111-1111-1111-1111-111111111111';
  const userId = '44444444-4444-4444-8444-444444444444';
  const capturedAt = new Date('2026-07-25T12:00:00.000Z');
  const unrestrictedScope = { version: 1, kind: 'unrestricted', orgId } as const;
  return {
    exactPredicate: { op: 'definitionScope', mode: 'exact' },
    compositePredicate: { op: 'definitionScope', mode: 'composite' },
    systemPredicate: { op: 'definitionScope', mode: 'system' },
    exactRunPredicate: { op: 'runScope', mode: 'exact' },
    compositeRunPredicate: { op: 'runScope', mode: 'composite' },
    systemRunPredicate: { op: 'runScope', mode: 'system' },
    result: {
      ok: true,
      authority: {
        scope: unrestrictedScope,
        principalUserId: userId,
        capturedAt,
        fingerprint: 'f'.repeat(64)
      }
    } as any,
    mapResult: new Map() as Map<string, any>
  };
});

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../services/siteScope', () => ({
  resolveRequestReportAuthority: vi.fn(async () => siteScopeState.result),
  resolveRequestReportAuthorityMap: vi.fn(async () => siteScopeState.mapResult),
  reportDefinitionScopeSqlPredicate: vi.fn(() => siteScopeState.exactPredicate),
  reportDefinitionMultiOrgScopeSqlPredicate: vi.fn(() => siteScopeState.compositePredicate),
  unrestrictedReportDefinitionScopeSqlPredicate: vi.fn(() => siteScopeState.systemPredicate),
  reportRunScopeSqlPredicate: vi.fn(() => siteScopeState.exactRunPredicate),
  reportRunMultiOrgScopeSqlPredicate: vi.fn(() => siteScopeState.compositeRunPredicate),
  unrestrictedReportRunScopeSqlPredicate: vi.fn(() => siteScopeState.systemRunPredicate),
  siteScopeFingerprint: vi.fn((scope: any) =>
    scope.kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64)
  ),
  persistedSiteScopeValues: vi.fn((authority: any) => ({
    executionScopeVersion: 1,
    executionScopeKind: authority.scope.kind,
    executionScopeSiteIds: authority.scope.kind === 'restricted'
      ? [...new Set(authority.scope.siteIds)].sort()
      : null,
    executionScopeUserId: authority.principalUserId,
    executionScopeFingerprint: authority.fingerprint,
    executionScopeCapturedAt: authority.capturedAt
  })),
  decodeSiteScope: vi.fn((row: any, orgId: string) => {
    if (row.executionScopeKind === undefined) {
      return siteScopeState.result.authority.scope;
    }
    if (row.executionScopeVersion === null) {
      return { version: 1, kind: 'legacy_unscoped', orgId };
    }
    if (row.executionScopeKind === 'restricted') {
      return {
        version: 1,
        kind: 'restricted',
        orgId,
        siteIds: row.executionScopeSiteIds ?? []
      };
    }
    return { version: 1, kind: row.executionScopeKind, orgId };
  }),
  isSiteScopeSubset: vi.fn(() => true),
  intersectSiteScopes: vi.fn((persisted: any) => persisted)
}));

vi.mock('../services/securityComplianceReport', () => ({
  generateSecurityCompliancePostureReport: vi.fn(async () => ({
    rows: [],
    rowCount: 0,
    summary: {},
    generatedAt: 'x'
  }))
}));

vi.mock('../services/reportGenerationService', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../services/reportGenerationService')
  >();
  return {
    ...actual,
    generateReport: vi.fn(actual.generateReport),
    previousBaselineFor: vi.fn(actual.previousBaselineFor),
  };
});

vi.mock('drizzle-orm', () => ({
  and: (...conditions: any[]) => ({ op: 'and', conditions }),
  or: (...conditions: any[]) => ({ op: 'or', conditions }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  gte: (column: unknown, value: unknown) => ({ op: 'gte', column, value }),
  lte: (column: unknown, value: unknown) => ({ op: 'lte', column, value }),
  desc: (column: unknown) => ({ op: 'desc', column }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values })
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve([]))
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([]))
      }))
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve())
      }))
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve())
    })),
    transaction: vi.fn()
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn())
}));

vi.mock('../db/schema', () => ({
  reports: {
    id: 'reports.id',
    orgId: 'reports.orgId',
    name: 'reports.name',
    type: 'reports.type',
    schedule: 'reports.schedule',
    format: 'reports.format',
    updatedAt: 'reports.updatedAt',
    lastGeneratedAt: 'reports.lastGeneratedAt',
    executionScopeVersion: 'reports.executionScopeVersion',
    executionScopeKind: 'reports.executionScopeKind',
    executionScopeSiteIds: 'reports.executionScopeSiteIds',
    executionScopeUserId: 'reports.executionScopeUserId',
    executionScopeFingerprint: 'reports.executionScopeFingerprint',
    executionScopeCapturedAt: 'reports.executionScopeCapturedAt'
  },
  reportRuns: {
    id: 'reportRuns.id',
    reportId: 'reportRuns.reportId',
    status: 'reportRuns.status',
    startedAt: 'reportRuns.startedAt',
    completedAt: 'reportRuns.completedAt',
    outputUrl: 'reportRuns.outputUrl',
    errorMessage: 'reportRuns.errorMessage',
    rowCount: 'reportRuns.rowCount',
    result: 'reportRuns.result',
    createdAt: 'reportRuns.createdAt',
    executionScopeVersion: 'reportRuns.executionScopeVersion',
    executionScopeKind: 'reportRuns.executionScopeKind',
    executionScopeSiteIds: 'reportRuns.executionScopeSiteIds',
    executionScopeUserId: 'reportRuns.executionScopeUserId',
    executionScopeFingerprint: 'reportRuns.executionScopeFingerprint',
    executionScopeCapturedAt: 'reportRuns.executionScopeCapturedAt'
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    hostname: 'devices.hostname',
    displayName: 'devices.displayName',
    osType: 'devices.osType',
    osVersion: 'devices.osVersion',
    architecture: 'devices.architecture',
    agentVersion: 'devices.agentVersion',
    status: 'devices.status',
    lastSeenAt: 'devices.lastSeenAt',
    enrolledAt: 'devices.enrolledAt',
    tags: 'devices.tags',
    siteId: 'devices.siteId'
  },
  deviceSoftware: {
    id: 'deviceSoftware.id',
    name: 'deviceSoftware.name',
    version: 'deviceSoftware.version',
    publisher: 'deviceSoftware.publisher',
    installDate: 'deviceSoftware.installDate',
    isSystem: 'deviceSoftware.isSystem',
    deviceId: 'deviceSoftware.deviceId'
  },
  deviceMetrics: {
    deviceId: 'deviceMetrics.deviceId',
    timestamp: 'deviceMetrics.timestamp',
    cpuPercent: 'deviceMetrics.cpuPercent',
    ramPercent: 'deviceMetrics.ramPercent',
    diskPercent: 'deviceMetrics.diskPercent'
  },
  deviceHardware: {
    deviceId: 'deviceHardware.deviceId',
    cpuModel: 'deviceHardware.cpuModel',
    cpuCores: 'deviceHardware.cpuCores',
    ramTotalMb: 'deviceHardware.ramTotalMb',
    diskTotalGb: 'deviceHardware.diskTotalGb',
    manufacturer: 'deviceHardware.manufacturer',
    model: 'deviceHardware.model',
    serialNumber: 'deviceHardware.serialNumber'
  },
  alerts: {
    orgId: 'alerts.orgId',
    deviceId: 'alerts.deviceId',
    ruleId: 'alerts.ruleId',
    title: 'alerts.title',
    severity: 'alerts.severity',
    status: 'alerts.status',
    triggeredAt: 'alerts.triggeredAt',
    acknowledgedAt: 'alerts.acknowledgedAt',
    resolvedAt: 'alerts.resolvedAt'
  },
  alertRules: {
    id: 'alertRules.id',
    name: 'alertRules.name'
  },
  organizations: {},
  sites: {
    id: 'sites.id',
    name: 'sites.name'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState.auth);
    c.set('permissions', permissionState.permissions);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    permissionState.last = { resource, action };
    if (permissionState.deny) {
      return c.text('Permission denied', 403);
    }
    return next();
  })
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    REPORTS_READ: { resource: 'reports', action: 'read' },
    REPORTS_WRITE: { resource: 'reports', action: 'write' },
    REPORTS_EXPORT: { resource: 'reports', action: 'export' },
    REPORTS_DELETE: { resource: 'reports', action: 'delete' }
  },
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId)
}));

import { db } from '../db';
import { reportRoutes } from './reports';
import { generateReport } from '../services/reportGenerationService';
import { generateSecurityCompliancePostureReport } from '../services/securityComplianceReport';
import { writeRouteAudit } from '../services/auditEvents';
import {
  decodeSiteScope,
  isSiteScopeSubset,
  intersectSiteScopes,
  reportDefinitionMultiOrgScopeSqlPredicate,
  reportDefinitionScopeSqlPredicate,
  reportRunMultiOrgScopeSqlPredicate,
  reportRunScopeSqlPredicate,
  resolveRequestReportAuthority,
  resolveRequestReportAuthorityMap,
  unrestrictedReportDefinitionScopeSqlPredicate,
  unrestrictedReportRunScopeSqlPredicate
} from '../services/siteScope';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ALLOWED = '22222222-2222-2222-2222-222222222222';
const SITE_DENIED = '33333333-3333-3333-3333-333333333333';
const DEVICE_ALLOWED = '44444444-4444-4444-4444-444444444444';
const DEVICE_DENIED = '55555555-5555-5555-5555-555555555555';

/** A thenable that resolves to `rows` and supports any drizzle chain method. */
function selectChain(rows: any) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit', 'offset', 'for']) {
    p[m] = () => p;
  }
  return p;
}

function conditionHas(condition: any, op: string, column: string, predicate: (value: any) => boolean): boolean {
  if (!condition) return false;
  if (condition.op === 'and') {
    return condition.conditions.some((child: any) => conditionHas(child, op, column, predicate));
  }
  return condition.op === op && condition.column === column && predicate(condition.value ?? condition.values);
}

function filterByDeviceSite<T extends { siteId?: string }>(rows: T[], condition: any): T[] {
  if (conditionHas(condition, 'eq', 'devices.siteId', (value) => typeof value === 'string')) {
    const siteId = findConditionValue(condition, 'eq', 'devices.siteId') as string;
    return rows.filter((row) => row.siteId === siteId);
  }
  if (conditionHas(condition, 'inArray', 'devices.siteId', (values) => Array.isArray(values))) {
    const siteIds = findConditionValue(condition, 'inArray', 'devices.siteId') as string[];
    return rows.filter((row) => row.siteId && siteIds.includes(row.siteId));
  }
  return rows;
}

function filterByDeviceIds<T extends { id?: string; deviceId?: string }>(rows: T[], condition: any, column: string): T[] {
  if (!conditionHas(condition, 'inArray', column, (values) => Array.isArray(values))) return rows;
  const deviceIds = findConditionValue(condition, 'inArray', column) as string[];
  return rows.filter((row) => deviceIds.includes(row.deviceId ?? row.id ?? ''));
}

function findConditionValue(condition: any, op: string, column: string): unknown {
  if (!condition) return undefined;
  if (condition.op === 'and') {
    for (const child of condition.conditions) {
      const value = findConditionValue(child, op, column);
      if (value !== undefined) return value;
    }
    return undefined;
  }
  if (condition.op === op && condition.column === column) {
    return condition.value ?? condition.values;
  }
  return undefined;
}

function mockDeviceInventoryQueries(rows: Array<{ id: string; siteId: string; hostname: string }>) {
  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn((condition) => ({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue(filterByDeviceSite(rows, condition))
              })
            })
          }))
        })
      })
    } as any)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn((condition) => Promise.resolve([{ count: filterByDeviceSite(rows, condition).length }]))
      })
    } as any);
}

function mockSoftwareInventoryQueries(rows: Array<{ id: string; deviceId: string; siteId: string; name: string }>) {
  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn((condition) => ({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue(filterByDeviceSite(rows, condition))
              })
            })
          }))
        })
      })
    } as any)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn((condition) => Promise.resolve([{ count: filterByDeviceSite(rows, condition).length }]))
        })
      })
    } as any)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn((condition) => ({
            groupBy: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(filterByDeviceSite(rows, condition))
              })
            })
          }))
        })
      })
    } as any);
}

function mockMetricsQueries(
  deviceRows: Array<{ id: string; siteId: string }>,
  metricRows: Array<{ deviceId: string; hostname: string; cpuPercent: number; ramPercent: number; diskPercent: number; timestamp: Date }>
) {
  vi.mocked(db.select)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn((condition) => Promise.resolve(filterByDeviceSite(deviceRows, condition)))
      })
    } as any)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn((condition) => {
          const rows = filterByDeviceIds(metricRows, condition, 'deviceMetrics.deviceId');
          return Promise.resolve([{
            avgCpu: rows.reduce((sum, row) => sum + row.cpuPercent, 0) / (rows.length || 1),
            avgRam: rows.reduce((sum, row) => sum + row.ramPercent, 0) / (rows.length || 1),
            avgDisk: rows.reduce((sum, row) => sum + row.diskPercent, 0) / (rows.length || 1)
          }]);
        })
      })
    } as any)
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn((condition) => ({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(filterByDeviceIds(metricRows, condition, 'deviceMetrics.deviceId'))
            })
          }))
        })
      })
    } as any);
}

type SummaryAlert = {
  orgId: string;
  siteId: string | null;
  severity: string;
  status: string;
  day: string;
  ruleId: string;
  ruleName: string;
};

/**
 * Evaluates a mocked WHERE tree against one seeded alert. Date bounds always
 * pass (fixtures sit inside every window); organization and device-site
 * predicates are the interesting axes.
 */
function alertMatches(alert: SummaryAlert, condition: any): boolean {
  if (!condition) return true;
  if (condition.op === 'and') {
    return condition.conditions.every((child: any) => alertMatches(alert, child));
  }
  if (condition.op === 'or') {
    return condition.conditions.some((child: any) => alertMatches(alert, child));
  }
  if (condition.op === 'eq') {
    if (condition.column === 'alerts.orgId' || condition.column === 'devices.orgId') {
      return alert.orgId === condition.value;
    }
    if (condition.column === 'devices.siteId') {
      return alert.siteId === condition.value;
    }
    return true;
  }
  if (condition.op === 'inArray') {
    if (condition.column === 'alerts.orgId' || condition.column === 'devices.orgId') {
      return (condition.values as string[]).includes(alert.orgId);
    }
    if (condition.column === 'devices.siteId') {
      return alert.siteId !== null && (condition.values as string[]).includes(alert.siteId);
    }
    return true;
  }
  return true;
}

/** The device-scope branch the alerts-summary handler conjoins into every aggregate. */
function findDeviceScopeNode(condition: any): any {
  const children = condition?.op === 'and' ? condition.conditions : [condition];
  return children.find(
    (child: any) =>
      child?.op === 'or' ||
      ((child?.op === 'inArray' || child?.op === 'eq') && child.column === 'devices.siteId')
  );
}

function countBy(rows: SummaryAlert[], key: 'severity' | 'status' | 'day'): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
  }
  return [...counts.entries()];
}

/**
 * Mocks the five alerts-summary aggregates in handler order (severity, status,
 * day, top rules, total) and records each query's join conditions and WHERE
 * tree so tests can prove one shared device predicate reaches all of them.
 */
function mockAlertsSummaryQueries(rows: SummaryAlert[]) {
  const captured: any[] = [];
  const joins: any[][] = [[], [], [], [], []];
  const projections: Array<(visible: SummaryAlert[]) => any[]> = [
    (visible) => countBy(visible, 'severity').map(([severity, count]) => ({ severity, count })),
    (visible) => countBy(visible, 'status').map(([status, count]) => ({ status, count })),
    (visible) =>
      countBy(visible, 'day')
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([date, count]) => ({ date, count })),
    (visible) => {
      const byRule = new Map<string, { ruleId: string; ruleName: string; count: number }>();
      for (const row of visible) {
        const existing = byRule.get(row.ruleId);
        if (existing) existing.count += 1;
        else byRule.set(row.ruleId, { ruleId: row.ruleId, ruleName: row.ruleName, count: 1 });
      }
      return [...byRule.values()].sort((left, right) => right.count - left.count).slice(0, 10);
    },
    (visible) => [{ count: visible.length }]
  ];

  projections.forEach((project, index) => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: () => {
        const node: any = {};
        node.innerJoin = (_table: unknown, condition: unknown) => {
          joins[index]!.push(condition);
          return node;
        };
        node.where = (condition: any) => {
          captured.push(condition);
          const promise: any = Promise.resolve(
            project(rows.filter((row) => alertMatches(row, condition)))
          );
          promise.groupBy = () => promise;
          promise.orderBy = () => promise;
          promise.limit = () => promise;
          return promise;
        };
        return node;
      }
    } as any);
  });

  return { captured, joins };
}

function mockGenerateDeviceInventoryQuery(rows: Array<{ hostname: string; siteId: string }>) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn((condition) => ({
          orderBy: vi.fn().mockResolvedValue(filterByDeviceSite(rows, condition))
        }))
      })
    })
  } as any);
}

function scopedRunRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    reportId: 'rep-1',
    orgId: ORG_ID,
    status: 'completed',
    executionScopeVersion: 1,
    executionScopeKind: 'unrestricted',
    executionScopeSiteIds: null,
    executionScopeUserId: '44444444-4444-4444-8444-444444444444',
    executionScopeFingerprint: 'f'.repeat(64),
    executionScopeCapturedAt: new Date('2026-07-25T12:00:00.000Z'),
    ...overrides,
  };
}

describe('GET /reports/runs/:id/download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionState.deny = false;
    permissionState.permissions = undefined;
  });

  it('streams CSV for a completed run with stored rows', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);

    vi.mocked(db.select)
      // getReportRunWithOrgCheck → run row (with orgId for access check)
      .mockReturnValueOnce(selectChain([
        scopedRunRow()
      ]))
      // download handler → result + report meta
      .mockReturnValueOnce(selectChain([
        {
          ...scopedRunRow(),
          result: { rows: [{ hostname: 'pc-1', os: 'windows' }], rowCount: 1 },
          reportType: 'device_inventory',
          reportName: 'Inventory',
          reportFormat: 'csv'
        }
      ]));

    const res = await app.request('/reports/runs/run-1/download');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const body = await res.text();
    expect(body).toContain('hostname');
    expect(body).toContain('"pc-1"');
  });

  it('returns 409 when the run is not completed', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([scopedRunRow({ status: 'pending' })]))
      .mockReturnValueOnce(selectChain([scopedRunRow({ status: 'pending' })]));
    const res = await app.request('/reports/runs/run-1/download');
    expect(res.status).toBe(409);
  });

  it('returns 409 when a completed run has no tabular rows', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([scopedRunRow()]))
      .mockReturnValueOnce(selectChain([{ ...scopedRunRow(), result: { summary: {} }, reportType: 'executive_summary', reportName: 'Exec', reportFormat: 'csv' }]));
    const res = await app.request('/reports/runs/run-1/download');
    expect(res.status).toBe(409);
  });

  it('returns 404 for a run the caller cannot access', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);
    vi.mocked(db.select).mockReturnValueOnce(selectChain([]));
    const res = await app.request('/reports/runs/run-1/download');
    expect(res.status).toBe(404);
  });

  it('returns the snapshot as JSON for pdf format', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([scopedRunRow()]))
      .mockReturnValueOnce(selectChain([{ ...scopedRunRow(), result: { rows: [{ hostname: 'pc-1' }], rowCount: 1 }, reportType: 'device_inventory', reportName: 'Inventory', reportFormat: 'pdf' }]));
    const res = await app.request('/reports/runs/run-1/download?format=pdf');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = await res.json();
    expect(json.data.rows[0].hostname).toBe('pc-1');
  });
});

describe('POST /reports/:id/generate persists a snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissionState.deny = false;
    permissionState.permissions = undefined;
  });

  it('generates synchronously and stores result + completed status', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);

    const setArgs: any[] = [];
    vi.mocked(db.update).mockReturnValue({
      set: (v: any) => { setArgs.push(v); return { where: () => Promise.resolve() }; }
    } as any);

    // getReportWithOrgCheck → report; then generator selects → empty
    vi.mocked(db.select).mockImplementation(() =>
      selectChain([{ id: 'rep-1', orgId: ORG_ID, type: 'device_inventory', name: 'Inv', config: {}, format: 'csv' }])
    );
    vi.mocked(db.insert).mockReturnValue({
      values: () => ({ returning: () => Promise.resolve([{ id: 'run-1', status: 'pending' }]) })
    } as any);

    const res = await app.request('/reports/rep-1/generate', { method: 'POST' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('completed');
    const completedSet = setArgs.find((a) => a.status === 'completed');
    expect(completedSet).toBeDefined();
    expect(completedSet.result).toBeDefined();
    expect(completedSet.outputUrl).toBe('/api/reports/runs/run-1/download');
  });
});

describe('generateReport dispatch — security_compliance_posture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes to the posture generator', async () => {
    const executionAuthority = {
      scope: { version: 1 as const, kind: 'unrestricted' as const, orgId: 'org-1' },
      principalUserId: 'user-1',
      capturedAt: new Date('2026-07-25T12:00:00.000Z'),
      fingerprint: 'f'.repeat(64),
    };
    await generateReport(
      'security_compliance_posture',
      'org-1',
      {},
      executionAuthority,
    );

    expect(generateSecurityCompliancePostureReport).toHaveBeenCalledWith(
      'org-1',
      {},
      executionAuthority,
    );
  });
});

describe('report definition scope enforcement', () => {
  const USER_ID = '44444444-4444-4444-8444-444444444444';
  const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const REPORT_ID = '77777777-7777-4777-8777-777777777777';
  const MISSING_ID = '88888888-8888-4888-8888-888888888888';
  const CAPTURED_AT = new Date('2026-07-25T12:00:00.000Z');

  function authority(kind: 'unrestricted' | 'restricted', siteIds?: string[]) {
    return {
      ok: true,
      authority: {
        scope: kind === 'restricted'
          ? { version: 1, kind, orgId: ORG_ID, siteIds: siteIds ?? [] }
          : { version: 1, kind, orgId: ORG_ID },
        principalUserId: USER_ID,
        capturedAt: CAPTURED_AT,
        fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64)
      }
    };
  }

  function definitionMetadata(overrides: Record<string, unknown> = {}) {
    return {
      id: REPORT_ID,
      orgId: ORG_ID,
      executionScopeVersion: 1,
      executionScopeKind: 'unrestricted',
      executionScopeSiteIds: null,
      executionScopeUserId: USER_ID,
      executionScopeFingerprint: 'f'.repeat(64),
      executionScopeCapturedAt: CAPTURED_AT,
      ...overrides
    };
  }

  function conditionContainsIdentity(condition: any, target: unknown): boolean {
    if (condition === target) return true;
    if (!condition || !Array.isArray(condition.conditions)) return false;
    return condition.conditions.some((child: unknown) =>
      conditionContainsIdentity(child, target)
    );
  }

  function mockDefinitionPage(
    rows: unknown[],
    total: number,
    capturedConditions: unknown[]
  ) {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn((condition) => {
            capturedConditions.push(condition);
            return Promise.resolve([{ count: total }]);
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn((condition) => {
            capturedConditions.push(condition);
            return {
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockReturnValue({
                  offset: vi.fn().mockResolvedValue(rows)
                })
              })
            };
          })
        })
      } as any);
  }

  function mockPredicateFilteredDefinitionPage(
    sourceRows: Array<{ id: string }>,
    visibleIds: readonly string[],
    expectedPredicate: unknown,
    capturedConditions: unknown[],
  ) {
    const visibleIdSet = new Set(visibleIds);
    const rowsFor = (condition: unknown) =>
      conditionContainsIdentity(condition, expectedPredicate)
        ? sourceRows.filter((row) => visibleIdSet.has(row.id))
        : sourceRows;

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn((condition) => {
            capturedConditions.push(condition);
            return Promise.resolve([{ count: rowsFor(condition).length }]);
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn((condition) => {
            capturedConditions.push(condition);
            return {
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn((limit: number) => ({
                  offset: vi.fn((offset: number) =>
                    Promise.resolve(rowsFor(condition).slice(offset, offset + limit))
                  )
                }))
              })
            };
          })
        })
      } as any);
  }

  function app() {
    return new Hono().route('/reports', reportRoutes);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    permissionState.deny = false;
    permissionState.last = null;
    permissionState.permissions = undefined;
    authState.auth = authState.makeDefault();
    siteScopeState.result = authority('unrestricted');
    siteScopeState.mapResult = new Map();
    vi.mocked(db.select).mockReset();
    vi.mocked(db.transaction).mockImplementation(async (callback: any) =>
      callback(db as any)
    );
  });

  it.each([
    {
      name: 'unrestricted',
      resolved: authority('unrestricted'),
      expectedKind: 'unrestricted',
      expectedSiteIds: null
    },
    {
      name: 'restricted with normalized sites',
      resolved: authority('restricted', [SITE_B, SITE_A, SITE_B]),
      expectedKind: 'restricted',
      expectedSiteIds: [SITE_A, SITE_B]
    }
  ])('snapshots $name authority on create', async ({
    resolved,
    expectedKind,
    expectedSiteIds
  }) => {
    siteScopeState.result = resolved;
    let inserted: any;
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn((values) => {
        inserted = values;
        return {
          returning: vi.fn().mockResolvedValue([{
            id: REPORT_ID,
            ...values
          }])
        };
      })
    } as any);

    const response = await app().request('/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Scoped report',
        type: 'device_inventory'
      })
    });

    expect(response.status).toBe(201);
    expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
      authState.auth,
      ORG_ID,
      'write'
    );
    expect(inserted).toMatchObject({
      executionScopeVersion: 1,
      executionScopeKind: expectedKind,
      executionScopeSiteIds: expectedSiteIds,
      executionScopeUserId: USER_ID,
      executionScopeCapturedAt: CAPTURED_AT
    });
  });

  it('rejects restricted-empty creation before insert or audit', async () => {
    siteScopeState.result = {
      ok: false,
      reason: 'empty_scope'
    };

    const response = await app().request('/reports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Blocked report',
        type: 'device_inventory'
      })
    });

    expect(response.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it.each(['', '/templates'])(
    'reuses one exact definition predicate for count and page on %s',
    async (suffix) => {
      const captured: unknown[] = [];
      mockDefinitionPage([{ id: REPORT_ID }], 1, captured);

      const response = await app().request(`/reports${suffix}?page=1&limit=2`);

      expect(response.status).toBe(200);
      expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
        authState.auth,
        ORG_ID,
        'read'
      );
      expect(reportDefinitionScopeSqlPredicate).toHaveBeenCalledTimes(1);
      expect(captured).toHaveLength(2);
      expect(conditionContainsIdentity(captured[0], siteScopeState.exactPredicate)).toBe(true);
      expect(conditionContainsIdentity(captured[1], siteScopeState.exactPredicate)).toBe(true);
      const body = await response.json();
      expect(body.pagination).toEqual({ page: 1, limit: 2, total: 1 });
    }
  );

  it.each(['', '/templates'])(
    'keeps exact visible totals and 2/2/1 page boundaries on %s',
    async (suffix) => {
      const visibleIds = ['visible-1', 'visible-2', 'visible-3', 'visible-4', 'visible-5'];
      const hiddenIds = ['hidden-site-b', 'hidden-unrestricted', 'hidden-legacy', 'hidden-malformed'];
      const sourceRows = [
        { id: visibleIds[0]! },
        { id: hiddenIds[0]! },
        { id: visibleIds[1]! },
        { id: hiddenIds[1]! },
        { id: visibleIds[2]! },
        { id: hiddenIds[2]! },
        { id: visibleIds[3]! },
        { id: hiddenIds[3]! },
        { id: visibleIds[4]! },
      ];
      const expectedPageIds = [
        visibleIds.slice(0, 2),
        visibleIds.slice(2, 4),
        visibleIds.slice(4),
      ];

      for (let index = 0; index < expectedPageIds.length; index += 1) {
        const captured: unknown[] = [];
        mockPredicateFilteredDefinitionPage(
          sourceRows,
          visibleIds,
          siteScopeState.exactPredicate,
          captured,
        );
        const response = await app().request(
          `/reports${suffix}?page=${index + 1}&limit=2`
        );
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.data.map((row: any) => row.id)).toEqual(
          expectedPageIds[index],
        );
        expect(body.pagination.total).toBe(5);
        expect(body.data.map((row: any) => row.id)).not.toEqual(
          expect.arrayContaining(hiddenIds)
        );
        expect(captured).toHaveLength(2);
        expect(captured.every((condition) =>
          conditionContainsIdentity(condition, siteScopeState.exactPredicate)
        )).toBe(true);
      }
    }
  );

  it('uses one partner-composite predicate for a no-org list', async () => {
    const orgB = '99999999-9999-4999-8999-999999999999';
    authState.auth = {
      ...authState.makeDefault(),
      scope: 'partner',
      partnerId: '55555555-5555-4555-8555-555555555555',
      orgId: null,
      accessibleOrgIds: [ORG_ID, orgB],
      canAccessOrg: () => true
    };
    siteScopeState.mapResult = new Map([
      [ORG_ID, authority('unrestricted')],
      [orgB, {
        ok: true,
        authority: {
          ...authority('restricted', [SITE_B]).authority,
          scope: { version: 1, kind: 'restricted', orgId: orgB, siteIds: [SITE_B] }
        }
      }]
    ]);
    const captured: unknown[] = [];
    mockDefinitionPage([{ id: 'org-a' }, { id: 'org-b1' }], 5, captured);

    const response = await app().request('/reports?page=1&limit=2');

    expect(response.status).toBe(200);
    expect(resolveRequestReportAuthorityMap).toHaveBeenCalledWith(
      authState.auth,
      [ORG_ID, orgB],
      'read'
    );
    expect(reportDefinitionMultiOrgScopeSqlPredicate).toHaveBeenCalledTimes(1);
    expect(captured.every((condition) =>
      conditionContainsIdentity(condition, siteScopeState.compositePredicate)
    )).toBe(true);
    expect(reportDefinitionScopeSqlPredicate).not.toHaveBeenCalled();
  });

  it.each(['', '/templates'])(
    'keeps partner-composite visible totals and 2/2/1 page boundaries on %s',
    async (suffix) => {
      const orgB = '99999999-9999-4999-8999-999999999999';
      authState.auth = {
        ...authState.makeDefault(),
        scope: 'partner',
        partnerId: '55555555-5555-4555-8555-555555555555',
        orgId: null,
        accessibleOrgIds: [ORG_ID, orgB],
        canAccessOrg: () => true
      };
      const orgBResult: any = {
        ok: true,
        authority: {
          ...authority('restricted', [SITE_B]).authority,
          scope: {
            version: 1,
            kind: 'restricted',
            orgId: orgB,
            siteIds: [SITE_B]
          }
        }
      };
      siteScopeState.mapResult = new Map([
        [ORG_ID, authority('unrestricted')],
        [orgB, orgBResult]
      ]);
      const visibleIds = [
        'org-a-1',
        'org-b-site-b1-1',
        'org-a-2',
        'org-b-site-b1-2',
        'org-a-3'
      ];
      const hiddenIds = [
        'org-b-unrestricted',
        'org-b-site-b2',
        'legacy',
        'malformed',
        'denied-org',
        'inaccessible-org'
      ];
      const sourceRows = [
        { id: visibleIds[0]! },
        { id: hiddenIds[0]! },
        { id: visibleIds[1]! },
        { id: hiddenIds[1]! },
        { id: visibleIds[2]! },
        { id: hiddenIds[2]! },
        { id: visibleIds[3]! },
        { id: hiddenIds[3]! },
        { id: hiddenIds[4]! },
        { id: visibleIds[4]! },
        { id: hiddenIds[5]! }
      ];
      const expectedPages = [
        visibleIds.slice(0, 2),
        visibleIds.slice(2, 4),
        visibleIds.slice(4)
      ];

      for (let index = 0; index < expectedPages.length; index += 1) {
        const captured: unknown[] = [];
        mockPredicateFilteredDefinitionPage(
          sourceRows,
          visibleIds,
          siteScopeState.compositePredicate,
          captured,
        );
        const response = await app().request(
          `/reports${suffix}?page=${index + 1}&limit=2`,
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.map((row: any) => row.id)).toEqual(
          expectedPages[index],
        );
        expect(body.pagination.total).toBe(5);
        expect(body.data.map((row: any) => row.id)).not.toEqual(
          expect.arrayContaining(hiddenIds),
        );
        expect(captured.every((condition) =>
          conditionContainsIdentity(
            condition,
            siteScopeState.compositePredicate,
          )
        )).toBe(true);
      }

      expect(reportDefinitionMultiOrgScopeSqlPredicate).toHaveBeenCalledWith(
        'reports.orgId',
        expect.anything(),
        [
          authority('unrestricted').authority.scope,
          orgBResult.authority.scope
        ],
      );
    }
  );

  it('uses the unrestricted provenance predicate for a system no-org list', async () => {
    authState.auth = {
      ...authState.makeDefault(),
      scope: 'system',
      orgId: null,
      accessibleOrgIds: null as any,
      canAccessOrg: () => true
    };
    const captured: unknown[] = [];
    mockDefinitionPage([{ id: 'system-visible' }], 5, captured);

    const response = await app().request('/reports/templates?page=1&limit=2');

    expect(response.status).toBe(200);
    expect(unrestrictedReportDefinitionScopeSqlPredicate).toHaveBeenCalledTimes(1);
    expect(captured.every((condition) =>
      conditionContainsIdentity(condition, siteScopeState.systemPredicate)
    )).toBe(true);
    expect(resolveRequestReportAuthorityMap).not.toHaveBeenCalled();
  });

  it.each(['', '/templates'])(
    'keeps system visible totals and 2/2/1 page boundaries on %s',
    async (suffix) => {
      authState.auth = {
        ...authState.makeDefault(),
        scope: 'system',
        orgId: null,
        accessibleOrgIds: null as any,
        canAccessOrg: () => true
      };
      const visibleIds = [
        'system-org-a-1',
        'system-org-b-1',
        'system-org-a-2',
        'system-org-c-1',
        'system-org-b-2'
      ];
      const hiddenIds = ['system-malformed-1', 'system-malformed-2'];
      const sourceRows = [
        { id: visibleIds[0]! },
        { id: hiddenIds[0]! },
        { id: visibleIds[1]! },
        { id: visibleIds[2]! },
        { id: hiddenIds[1]! },
        { id: visibleIds[3]! },
        { id: visibleIds[4]! }
      ];
      const expectedPages = [
        visibleIds.slice(0, 2),
        visibleIds.slice(2, 4),
        visibleIds.slice(4)
      ];

      for (let index = 0; index < expectedPages.length; index += 1) {
        const captured: unknown[] = [];
        mockPredicateFilteredDefinitionPage(
          sourceRows,
          visibleIds,
          siteScopeState.systemPredicate,
          captured,
        );
        const response = await app().request(
          `/reports${suffix}?page=${index + 1}&limit=2`,
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.data.map((row: any) => row.id)).toEqual(
          expectedPages[index],
        );
        expect(body.pagination.total).toBe(5);
        expect(body.data.map((row: any) => row.id)).not.toEqual(
          expect.arrayContaining(hiddenIds),
        );
        expect(captured.every((condition) =>
          conditionContainsIdentity(condition, siteScopeState.systemPredicate)
        )).toBe(true);
      }
    }
  );

  it('performs a metadata-only lookup before a predicate-guarded known-ID read', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([definitionMetadata()]))
      .mockReturnValueOnce(selectChain([{
        ...definitionMetadata(),
        name: 'Visible report',
        type: 'device_inventory',
        config: {}
      }]))
      .mockReturnValueOnce(selectChain([]));

    const response = await app().request(`/reports/${REPORT_ID}`);

    expect(response.status).toBe(200);
    const metadataProjection = vi.mocked(db.select).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(metadataProjection)).toEqual([
      'id',
      'orgId',
      'executionScopeVersion',
      'executionScopeKind',
      'executionScopeSiteIds',
      'executionScopeUserId',
      'executionScopeFingerprint',
      'executionScopeCapturedAt'
    ]);
    expect(metadataProjection).not.toHaveProperty('config');
    expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
      authState.auth,
      ORG_ID,
      'read'
    );
  });

  it('hides a known ID when metadata is not a subset of current authority', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([definitionMetadata()]));
    vi.mocked(isSiteScopeSubset).mockReturnValueOnce(false);

    const response = await app().request(`/reports/${REPORT_ID}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Report not found' });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('hides a known ID when the predicate-guarded second lookup loses the row', async () => {
    let guardedCondition: unknown;
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([definitionMetadata()]))
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn((condition) => {
            guardedCondition = condition;
            return { limit: vi.fn().mockResolvedValue([]) };
          })
        })
      } as any);

    const response = await app().request(`/reports/${REPORT_ID}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Report not found' });
    expect(conditionContainsIdentity(
      guardedCondition,
      siteScopeState.exactPredicate,
    )).toBe(true);
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'GET', suffix: '', body: undefined, action: 'read' },
    { method: 'PUT', suffix: '', body: { name: 'Nope' }, action: 'write' },
    { method: 'DELETE', suffix: '', body: undefined, action: 'delete' },
    { method: 'POST', suffix: '/reauthorize', body: undefined, action: 'write' }
  ])(
    'makes a hidden $method $suffix definition indistinguishable from nonexistent',
    async ({ method, suffix, body, action }) => {
      siteScopeState.result = { ok: false, reason: 'permission_removed' };
      vi.mocked(db.select).mockReturnValueOnce(selectChain([definitionMetadata()]));

      const hiddenResponse = await app().request(`/reports/${REPORT_ID}${suffix}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const hiddenPayload = await hiddenResponse.text();

      vi.mocked(db.select).mockReset();
      vi.mocked(db.select).mockReturnValueOnce(selectChain([]));
      const missingResponse = await app().request(`/reports/${MISSING_ID}${suffix}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });

      expect(hiddenResponse.status).toBe(404);
      expect(missingResponse.status).toBe(hiddenResponse.status);
      expect(await missingResponse.text()).toBe(hiddenPayload);
      expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
        authState.auth,
        ORG_ID,
        action
      );
      expect(db.update).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    }
  );

  it.each([
    { method: 'PUT', suffix: '', body: { name: 'Nope' }, action: 'write' },
    { method: 'DELETE', suffix: '', body: undefined, action: 'delete' },
    { method: 'POST', suffix: '/reauthorize', body: undefined, action: 'write' }
  ])(
    'does not mutate when the guarded $method $suffix lock lookup loses the row',
    async ({ method, suffix, body, action }) => {
      vi.mocked(db.select)
        .mockReturnValueOnce(selectChain([definitionMetadata()]))
        .mockReturnValueOnce(selectChain([]));

      const response = await app().request(`/reports/${REPORT_ID}${suffix}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Report not found' });
      expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
        authState.auth,
        ORG_ID,
        action,
      );
      expect(reportDefinitionScopeSqlPredicate).toHaveBeenCalledTimes(1);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
    }
  );

  it('returns SCOPE_CHANGED without mutation when metadata changes before reauthorization lock', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([definitionMetadata()]))
      .mockReturnValueOnce(selectChain([
        definitionMetadata({ executionScopeFingerprint: 'b'.repeat(64) })
      ]));

    const response = await app().request(`/reports/${REPORT_ID}/reauthorize`, {
      method: 'POST'
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Report scope changed',
      code: 'SCOPE_CHANGED'
    });
    expect(db.update).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('rolls back run deletion when the guarded definition delete loses its row', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([definitionMetadata()]))
      .mockReturnValueOnce(selectChain([definitionMetadata()]));
    let rolledBack = false;
    vi.mocked(db.transaction).mockImplementation(async (callback: any) => {
      try {
        return await callback(db as any);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    let guardedDeleteCondition: unknown;
    vi.mocked(db.delete)
      .mockReturnValueOnce({
        where: vi.fn().mockResolvedValue(undefined)
      } as any)
      .mockReturnValueOnce({
        where: vi.fn((condition) => {
          guardedDeleteCondition = condition;
          return { returning: vi.fn().mockResolvedValue([]) };
        })
      } as any);

    const response = await app().request(`/reports/${REPORT_ID}`, {
      method: 'DELETE'
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Report not found' });
    expect(db.delete).toHaveBeenCalledTimes(2);
    expect(conditionContainsIdentity(
      guardedDeleteCondition,
      siteScopeState.exactPredicate,
    )).toBe(true);
    expect(rolledBack).toBe(true);
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('reauthorizes with a fresh complete authority snapshot atomically', async () => {
    const metadata = definitionMetadata({
      executionScopeKind: 'legacy_unscoped',
      executionScopeUserId: null
    });
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([metadata]))
      .mockReturnValueOnce(selectChain([metadata]));
    let updatedValues: any;
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn((values) => {
        updatedValues = values;
        return {
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{
              ...definitionMetadata(),
              ...values
            }])
          })
        };
      })
    } as any);

    const response = await app().request(`/reports/${REPORT_ID}/reauthorize`, {
      method: 'POST'
    });

    expect(response.status).toBe(200);
    expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
      authState.auth,
      ORG_ID,
      'write'
    );
    expect(updatedValues).toMatchObject({
      executionScopeVersion: 1,
      executionScopeKind: 'unrestricted',
      executionScopeSiteIds: null,
      executionScopeUserId: USER_ID,
      executionScopeFingerprint: 'f'.repeat(64),
      executionScopeCapturedAt: CAPTURED_AT
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('reports routes', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    permissionState.deny = false;
    permissionState.last = null;
    permissionState.permissions = undefined;
    authState.auth = authState.makeDefault();
    siteScopeState.result = {
      ok: true,
      authority: {
        scope: { version: 1, kind: 'unrestricted', orgId: ORG_ID },
        principalUserId: '44444444-4444-4444-8444-444444444444',
        capturedAt: new Date('2026-07-25T12:00:00.000Z'),
        fingerprint: 'f'.repeat(64)
      }
    };
    siteScopeState.mapResult = new Map();
    const { reportRoutes } = await import('./reports');
    app = new Hono();
    app.route('/reports', reportRoutes);
    vi.mocked(db.transaction).mockImplementation(async (callback: any) =>
      callback(db as any)
    );
  });

  it('requires reports:export for report data routes', async () => {
    permissionState.deny = true;

    const res = await app.request('/reports/data/device-inventory', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(403);
    expect(permissionState.last).toEqual({ resource: 'reports', action: 'export' });
  });

  it('requires reports:export for ad-hoc report generation', async () => {
    permissionState.deny = true;

    const res = await app.request('/reports/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({ type: 'device_inventory', format: 'csv' })
    });

    expect(res.status).toBe(403);
    expect(permissionState.last).toEqual({ resource: 'reports', action: 'export' });
  });

  it('requires reports:delete for deleting report definitions', async () => {
    permissionState.deny = true;

    const res = await app.request('/reports/report-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(403);
    expect(permissionState.last).toEqual({ resource: 'reports', action: 'delete' });
  });

  describe('GET /reports/templates', () => {
    const OTHER_ORG = '99999999-9999-9999-9999-999999999999';

    /** Records the WHERE condition the handler builds so tests can assert scoping. */
    function captureTemplatesSelect(rows: any) {
      let captured: any;
      vi.mocked(db.select)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: rows.length }])
          })
        } as any)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn((condition) => {
              captured = condition;
              return {
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi.fn().mockResolvedValue(rows)
                  })
                })
              };
            })
          })
        } as any);
      return () => captured;
    }

    it('returns the org saved reports and scopes the query to the org (not a /:id mis-route)', async () => {
      const getCondition = captureTemplatesSelect([
        {
          id: 'report-1',
          orgId: ORG_ID,
          name: 'My Saved Template',
          type: 'performance',
          config: { dateRange: { preset: 'last_30_days' }, filters: {} },
          schedule: 'monthly',
          format: 'pdf'
        }
      ]);

      const res = await app.request('/reports/templates', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // Distinguishes the templates handler ({ data: [...] }) from the /:id
      // handler ({ ...report, recentRuns }) — a mis-route would leave data undefined.
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('report-1');
      // Tenant isolation: the query MUST be filtered to the caller's org. Without
      // this assertion the test would pass even if the org filter were dropped.
      expect(conditionHas(getCondition(), 'eq', 'reports.orgId', (v) => v === ORG_ID)).toBe(true);
    });

    it('denies a partner caller who requests an org they cannot access (403, no DB read)', async () => {
      authState.auth = {
        ...authState.makeDefault(),
        scope: 'partner',
        partnerId: 'partner-1',
        orgId: null,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID
      };
      siteScopeState.result = {
        ok: false,
        reason: 'organization_inaccessible'
      };

      const res = await app.request(`/reports/templates?orgId=${OTHER_ORG}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(403);
      // Access is rejected before any query runs.
      expect(db.select).not.toHaveBeenCalled();
    });

    it('scopes a partner caller to a requested org they CAN access', async () => {
      authState.auth = {
        ...authState.makeDefault(),
        scope: 'partner',
        partnerId: 'partner-1',
        orgId: null,
        accessibleOrgIds: [ORG_ID, OTHER_ORG],
        canAccessOrg: (orgId: string) => orgId === ORG_ID || orgId === OTHER_ORG
      };
      const getCondition = captureTemplatesSelect([]);

      const res = await app.request(`/reports/templates?orgId=${OTHER_ORG}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(200);
      expect(conditionHas(getCondition(), 'eq', 'reports.orgId', (v) => v === OTHER_ORG)).toBe(true);
    });

    it('filters a partner caller (no org selected) to their accessible orgs', async () => {
      authState.auth = {
        ...authState.makeDefault(),
        scope: 'partner',
        partnerId: 'partner-1',
        orgId: null,
        accessibleOrgIds: [ORG_ID, OTHER_ORG],
        canAccessOrg: (orgId: string) => orgId === ORG_ID || orgId === OTHER_ORG
      };
      const getCondition = captureTemplatesSelect([]);

      const res = await app.request('/reports/templates', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(200);
      expect(
        conditionHas(
          getCondition(),
          'inArray',
          'reports.orgId',
          (values) => Array.isArray(values) && values.includes(ORG_ID) && values.includes(OTHER_ORG)
        )
      ).toBe(true);
    });

    it('returns an exact zero page for a partner caller with no accessible orgs', async () => {
      authState.auth = {
        ...authState.makeDefault(),
        scope: 'partner',
        partnerId: 'partner-1',
        orgId: null,
        accessibleOrgIds: [],
        canAccessOrg: () => false
      };
      siteScopeState.mapResult = new Map();
      captureTemplatesSelect([]);

      const res = await app.request('/reports/templates', {
        method: 'GET',
        headers: { Authorization: 'Bearer valid-token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.pagination.total).toBe(0);
      expect(reportDefinitionMultiOrgScopeSqlPredicate).toHaveBeenCalledWith(
        'reports.orgId',
        expect.anything(),
        []
      );
    });
  });

  it('should generate a saved report run', async () => {
    const report = {
      id: 'report-1',
      orgId: ORG_ID,
      name: 'Device Inventory',
      type: 'device_inventory',
      config: {},
      schedule: 'daily',
      format: 'csv'
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([report])) // metadata lookup
      .mockReturnValueOnce(selectChain([report])) // predicate-guarded definition lookup
      .mockReturnValueOnce(selectChain([])) // generator query (device_inventory rows)
      .mockReturnValueOnce(selectChain([])); // previousBaselineFor: no prior completed run

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: 'run-1',
          reportId: 'report-1',
          status: 'pending'
        }])
      })
    } as any);

    const res = await app.request('/reports/report-1/generate', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe('run-1');
    expect(body.status).toBe('completed');
  });

  it('stores the previous baseline on the run when previousBaselineFor finds a prior completed run', async () => {
    const setArgs: any[] = [];
    vi.mocked(db.update).mockReturnValue({
      set: (v: any) => { setArgs.push(v); return { where: () => Promise.resolve() }; }
    } as any);

    const report = {
      id: 'report-1',
      orgId: ORG_ID,
      name: 'Device Inventory',
      type: 'device_inventory',
      config: {},
      schedule: 'daily',
      format: 'csv'
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([report])) // metadata lookup
      .mockReturnValueOnce(selectChain([report])) // predicate-guarded definition lookup
      .mockReturnValueOnce(selectChain([])) // generator query (device_inventory rows)
      .mockReturnValueOnce(selectChain([{
        summary: { postureScore: 74 },
        generatedAt: '2026-06-01T09:00:00.000Z',
        completedAt: new Date('2026-06-01T09:00:00Z')
      }])); // previousBaselineFor: prior completed run

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: 'run-1',
          reportId: 'report-1',
          status: 'pending'
        }])
      })
    } as any);

    const res = await app.request('/reports/report-1/generate', {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runId).toBe('run-1');
    expect(body.status).toBe('completed');

    const completedSet = setArgs.find((a) => a.status === 'completed');
    expect(completedSet).toBeDefined();
    expect(completedSet.result.previous).toEqual({
      generatedAt: '2026-06-01T09:00:00.000Z',
      summary: { postureScore: 74 }
    });
  });

  it('should update a report schedule', async () => {
    const metadata = {
      id: 'report-1',
      orgId: ORG_ID,
      executionScopeVersion: 1,
      executionScopeKind: 'unrestricted',
      executionScopeSiteIds: null,
      executionScopeUserId: '44444444-4444-4444-8444-444444444444',
      executionScopeFingerprint: 'f'.repeat(64),
      executionScopeCapturedAt: new Date('2026-07-25T12:00:00.000Z')
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([metadata]))
      .mockReturnValueOnce(selectChain([metadata]));

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'report-1',
            orgId: ORG_ID,
            name: 'Ops Summary',
            schedule: 'weekly'
          }])
        })
      })
    } as any);

    const res = await app.request('/reports/report-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
      body: JSON.stringify({ schedule: 'weekly' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schedule).toBe('weekly');
  });

  it('should return run details with export URL', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([scopedRunRow({ reportId: 'report-1' })]))
      .mockReturnValueOnce(selectChain([scopedRunRow({
        reportId: 'report-1',
        startedAt: new Date('2024-01-01T00:00:00Z'),
        completedAt: new Date('2024-01-01T00:01:00Z'),
        outputUrl: '/api/reports/runs/run-1/download',
        errorMessage: null,
        rowCount: 12,
        createdAt: new Date('2024-01-01T00:00:00Z'),
        reportName: 'Device Inventory',
        reportType: 'device_inventory',
        reportFormat: 'csv',
      })]));

    const res = await app.request('/reports/runs/run-1', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outputUrl).toBe('/api/reports/runs/run-1/download');
    expect(body.report?.id).toBe('report-1');
  });

  describe('GET /reports/data/device-inventory site scope', () => {
    const rows = [
      { id: DEVICE_ALLOWED, siteId: SITE_ALLOWED, hostname: 'allowed-device' },
      { id: DEVICE_DENIED, siteId: SITE_DENIED, hostname: 'denied-device' }
    ];

    it('returns 403 when a site-restricted caller requests an out-of-scope siteId', async () => {
      permissionState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
      mockDeviceInventoryQueries(rows);

      const res = await app.request(`/reports/data/device-inventory?siteId=${SITE_DENIED}`);

      expect(res.status).toBe(403);
    });

    it('narrows the device list to the caller allowed sites', async () => {
      permissionState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
      mockDeviceInventoryQueries(rows);

      const res = await app.request('/reports/data/device-inventory');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(DEVICE_ALLOWED);
      expect(body.total).toBe(1);
    });

    it('does not narrow for an unrestricted caller', async () => {
      mockDeviceInventoryQueries(rows);

      const res = await app.request('/reports/data/device-inventory');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.total).toBe(2);
    });
  });

  describe('GET /reports/data/software-inventory site scope', () => {
    const rows = [
      { id: 'software-1', deviceId: DEVICE_ALLOWED, siteId: SITE_ALLOWED, name: 'Allowed App' },
      { id: 'software-2', deviceId: DEVICE_DENIED, siteId: SITE_DENIED, name: 'Denied App' }
    ];

    it('returns 403 when a site-restricted caller requests an out-of-scope siteId', async () => {
      permissionState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
      mockSoftwareInventoryQueries(rows);

      const res = await app.request(`/reports/data/software-inventory?siteId=${SITE_DENIED}`);

      expect(res.status).toBe(403);
    });

    it('narrows the software list, count, and summary to the caller allowed sites', async () => {
      permissionState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
      mockSoftwareInventoryQueries(rows);

      const res = await app.request('/reports/data/software-inventory');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].deviceId).toBe(DEVICE_ALLOWED);
      expect(body.summary).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it('does not narrow for an unrestricted caller', async () => {
      mockSoftwareInventoryQueries(rows);

      const res = await app.request('/reports/data/software-inventory');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toHaveLength(2);
      expect(body.summary).toHaveLength(2);
      expect(body.total).toBe(2);
    });
  });

  describe('GET /reports/data/metrics site scope', () => {
    const deviceRows = [
      { id: DEVICE_ALLOWED, siteId: SITE_ALLOWED },
      { id: DEVICE_DENIED, siteId: SITE_DENIED }
    ];
    const metricRows = [
      { deviceId: DEVICE_ALLOWED, hostname: 'allowed-device', cpuPercent: 20, ramPercent: 30, diskPercent: 40, timestamp: new Date() },
      { deviceId: DEVICE_DENIED, hostname: 'denied-device', cpuPercent: 90, ramPercent: 80, diskPercent: 70, timestamp: new Date() }
    ];

    it('returns 403 when a site-restricted caller requests an out-of-scope siteId', async () => {
      permissionState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
      mockMetricsQueries(deviceRows, metricRows);

      const res = await app.request(`/reports/data/metrics?siteId=${SITE_DENIED}`);

      expect(res.status).toBe(403);
    });

    it('narrows metrics to devices in caller allowed sites', async () => {
      permissionState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
      mockMetricsQueries(deviceRows, metricRows);

      const res = await app.request('/reports/data/metrics');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.topCpu).toHaveLength(1);
      expect(body.data.topCpu[0].deviceId).toBe(DEVICE_ALLOWED);
    });

    it('does not narrow for an unrestricted caller', async () => {
      mockMetricsQueries(deviceRows, metricRows);

      const res = await app.request('/reports/data/metrics');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.topCpu).toHaveLength(2);
    });
  });

  describe('GET /reports/data/alerts-summary site scope', () => {
    const ORG_B = '66666666-6666-4666-8666-666666666666';
    const ORG_C = '77777777-7777-4777-8777-777777777777';
    const SITE_B1 = '88888888-8888-4888-8888-888888888888';
    const SITE_B2 = '99999999-9999-4999-8999-999999999999';
    const SITE_C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const USER_ID = '44444444-4444-4444-8444-444444444444';
    const CAPTURED_AT = new Date('2026-07-25T12:00:00.000Z');
    const EMPTY_SUMMARY = {
      data: { bySeverity: {}, byStatus: {}, byDay: [], topRules: [] },
      total: 0
    };

    const orgAlerts: SummaryAlert[] = [
      { orgId: ORG_ID, siteId: SITE_ALLOWED, severity: 'critical', status: 'open', day: '2026-07-01', ruleId: 'rule-1', ruleName: 'Rule One' },
      { orgId: ORG_ID, siteId: SITE_ALLOWED, severity: 'warning', status: 'open', day: '2026-07-02', ruleId: 'rule-1', ruleName: 'Rule One' },
      { orgId: ORG_ID, siteId: SITE_DENIED, severity: 'critical', status: 'resolved', day: '2026-07-01', ruleId: 'rule-2', ruleName: 'Rule Two' },
      { orgId: ORG_ID, siteId: null, severity: 'info', status: 'open', day: '2026-07-03', ruleId: 'rule-3', ruleName: 'Rule Three' }
    ];

    const multiOrgAlerts: SummaryAlert[] = [
      { orgId: ORG_ID, siteId: SITE_ALLOWED, severity: 'critical', status: 'open', day: '2026-07-01', ruleId: 'rule-a', ruleName: 'Rule A' },
      { orgId: ORG_ID, siteId: null, severity: 'warning', status: 'open', day: '2026-07-02', ruleId: 'rule-a', ruleName: 'Rule A' },
      { orgId: ORG_B, siteId: SITE_B1, severity: 'critical', status: 'resolved', day: '2026-07-02', ruleId: 'rule-b1', ruleName: 'Rule B1' },
      { orgId: ORG_B, siteId: SITE_B2, severity: 'info', status: 'open', day: '2026-07-03', ruleId: 'rule-b2', ruleName: 'Rule B2' },
      { orgId: ORG_B, siteId: null, severity: 'info', status: 'open', day: '2026-07-03', ruleId: 'rule-b3', ruleName: 'Rule B3' },
      { orgId: ORG_C, siteId: SITE_C, severity: 'critical', status: 'open', day: '2026-07-04', ruleId: 'rule-c', ruleName: 'Rule C' }
    ];

    function restrictedAuthority(orgId: string, siteIds: string[]) {
      return {
        ok: true,
        authority: {
          scope: { version: 1, kind: 'restricted', orgId, siteIds },
          principalUserId: USER_ID,
          capturedAt: CAPTURED_AT,
          fingerprint: 'a'.repeat(64)
        }
      };
    }

    function unrestrictedAuthority(orgId: string) {
      return {
        ok: true,
        authority: {
          scope: { version: 1, kind: 'unrestricted', orgId },
          principalUserId: USER_ID,
          capturedAt: CAPTURED_AT,
          fingerprint: 'f'.repeat(64)
        }
      };
    }

    function usePartnerAuth(orgIds: string[]) {
      authState.auth = {
        ...authState.makeDefault(),
        scope: 'partner',
        partnerId: 'partner-1',
        orgId: null,
        accessibleOrgIds: orgIds,
        canAccessOrg: (orgId: string) => orgIds.includes(orgId)
      };
    }

    it('returns only Site A values in every aggregate component for a restricted caller', async () => {
      siteScopeState.result = restrictedAuthority(ORG_ID, [SITE_ALLOWED]);
      const { captured, joins } = mockAlertsSummaryQueries(orgAlerts);

      const res = await app.request('/reports/data/alerts-summary');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.bySeverity).toEqual({ critical: 1, warning: 1 });
      expect(body.data.byStatus).toEqual({ open: 2 });
      expect(body.data.byDay).toEqual([
        { date: '2026-07-01', count: 1 },
        { date: '2026-07-02', count: 1 }
      ]);
      expect(body.data.topRules).toEqual([
        { ruleId: 'rule-1', ruleName: 'Rule One', count: 2 }
      ]);
      expect(body.total).toBe(2);

      expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
        authState.auth,
        ORG_ID,
        'export'
      );

      // All five aggregates join alerts to devices and reuse one predicate.
      expect(captured).toHaveLength(5);
      expect(joins).toHaveLength(5);
      for (const queryJoins of joins) {
        expect(queryJoins).toContainEqual({
          op: 'eq',
          column: 'alerts.deviceId',
          value: 'devices.id'
        });
      }
      const scopeNodes = captured.map(findDeviceScopeNode);
      for (const node of scopeNodes) {
        expect(node).toEqual({
          op: 'inArray',
          column: 'devices.siteId',
          values: [SITE_ALLOWED]
        });
        expect(node).toBe(scopeNodes[0]);
      }
    });

    it('returns 403 for a denied siteId before any query', async () => {
      siteScopeState.result = restrictedAuthority(ORG_ID, [SITE_ALLOWED]);
      mockAlertsSummaryQueries(orgAlerts);

      const res = await app.request(`/reports/data/alerts-summary?siteId=${SITE_DENIED}`);

      expect(res.status).toBe(403);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('returns the zero-safe shape with zero queries for a restricted-empty caller', async () => {
      siteScopeState.result = { ok: false, reason: 'empty_scope' };
      mockAlertsSummaryQueries(orgAlerts);

      const res = await app.request('/reports/data/alerts-summary');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(EMPTY_SUMMARY);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('leaves an unrestricted caller unchanged', async () => {
      const { captured } = mockAlertsSummaryQueries(orgAlerts);

      const res = await app.request('/reports/data/alerts-summary');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.bySeverity).toEqual({ critical: 2, warning: 1, info: 1 });
      expect(body.data.byStatus).toEqual({ open: 3, resolved: 1 });
      expect(body.data.byDay).toHaveLength(3);
      expect(body.data.topRules).toHaveLength(3);
      expect(body.total).toBe(4);
      for (const condition of captured) {
        expect(findDeviceScopeNode(condition)).toBeUndefined();
      }
    });

    it('derives one exact-organization scope from an explicit orgId even for a broader partner', async () => {
      usePartnerAuth([ORG_ID, ORG_B]);
      siteScopeState.result = restrictedAuthority(ORG_B, [SITE_B1]);
      const { captured } = mockAlertsSummaryQueries(multiOrgAlerts);

      const res = await app.request(`/reports/data/alerts-summary?orgId=${ORG_B}`);

      expect(res.status).toBe(200);
      expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
        authState.auth,
        ORG_B,
        'export'
      );
      expect(resolveRequestReportAuthorityMap).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.data.bySeverity).toEqual({ critical: 1 });
      expect(body.data.byStatus).toEqual({ resolved: 1 });
      expect(body.data.topRules).toEqual([
        { ruleId: 'rule-b1', ruleName: 'Rule B1', count: 1 }
      ]);
      expect(body.total).toBe(1);
      for (const condition of captured) {
        expect(findDeviceScopeNode(condition)).toEqual({
          op: 'inArray',
          column: 'devices.siteId',
          values: [SITE_B1]
        });
      }
    });

    it('builds one per-organization composite predicate for a partner without orgId', async () => {
      usePartnerAuth([ORG_ID, ORG_B, ORG_C]);
      siteScopeState.mapResult = new Map<string, any>([
        [ORG_ID, unrestrictedAuthority(ORG_ID)],
        [ORG_B, restrictedAuthority(ORG_B, [SITE_B1])],
        [ORG_C, { ok: false, reason: 'permission_removed' }]
      ]);
      const { captured } = mockAlertsSummaryQueries(multiOrgAlerts);

      const res = await app.request('/reports/data/alerts-summary');

      expect(res.status).toBe(200);
      expect(resolveRequestReportAuthorityMap).toHaveBeenCalledWith(
        authState.auth,
        [ORG_ID, ORG_B, ORG_C],
        'export'
      );
      const body = await res.json();
      // Organization A is unrestricted through partner fallback; Organization B
      // contributes only its Site B1 row; Organization C is denied entirely.
      expect(body.data.bySeverity).toEqual({ critical: 2, warning: 1 });
      expect(body.data.byStatus).toEqual({ open: 2, resolved: 1 });
      expect(body.data.byDay).toEqual([
        { date: '2026-07-01', count: 1 },
        { date: '2026-07-02', count: 2 }
      ]);
      expect(body.data.topRules).toEqual([
        { ruleId: 'rule-a', ruleName: 'Rule A', count: 2 },
        { ruleId: 'rule-b1', ruleName: 'Rule B1', count: 1 }
      ]);
      expect(body.total).toBe(3);

      const scopeNodes = captured.map(findDeviceScopeNode);
      expect(scopeNodes[0]).toEqual({
        op: 'or',
        conditions: [
          { op: 'eq', column: 'devices.orgId', value: ORG_ID },
          {
            op: 'and',
            conditions: [
              { op: 'eq', column: 'devices.orgId', value: ORG_B },
              { op: 'inArray', column: 'devices.siteId', values: [SITE_B1] }
            ]
          }
        ]
      });
      for (const node of scopeNodes) {
        expect(node).toBe(scopeNodes[0]);
      }
    });

    it('returns the zero-safe shape with zero queries when no organization branch is authorized', async () => {
      usePartnerAuth([ORG_ID, ORG_B]);
      siteScopeState.mapResult = new Map<string, any>([
        [ORG_ID, { ok: false, reason: 'permission_removed' }],
        [ORG_B, { ok: false, reason: 'empty_scope' }]
      ]);
      mockAlertsSummaryQueries(multiOrgAlerts);

      const res = await app.request('/reports/data/alerts-summary');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(EMPTY_SUMMARY);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('is unrestricted per row for a system caller without orgId', async () => {
      authState.auth = {
        ...authState.makeDefault(),
        scope: 'system',
        orgId: null,
        accessibleOrgIds: [],
        canAccessOrg: () => true
      };
      const { captured } = mockAlertsSummaryQueries(multiOrgAlerts);

      const res = await app.request('/reports/data/alerts-summary');

      expect(res.status).toBe(200);
      expect(resolveRequestReportAuthority).not.toHaveBeenCalled();
      expect(resolveRequestReportAuthorityMap).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.total).toBe(6);
      for (const condition of captured) {
        expect(findDeviceScopeNode(condition)).toBeUndefined();
      }
    });
  });

  describe('POST /reports/generate site scope', () => {
    const rows = [
      { hostname: 'allowed-device', siteId: SITE_ALLOWED },
      { hostname: 'denied-device', siteId: SITE_DENIED }
    ];

    it('returns 403 when a site-restricted caller filters to an out-of-scope siteId', async () => {
      permissionState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
      siteScopeState.result = {
        ok: true,
        authority: {
          scope: { version: 1, kind: 'restricted', orgId: ORG_ID, siteIds: [SITE_ALLOWED] },
          principalUserId: 'user-123',
          capturedAt: new Date('2026-07-25T12:00:00.000Z'),
          fingerprint: 'a'.repeat(64),
        },
      };
      mockGenerateDeviceInventoryQuery(rows);

      const res = await app.request('/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          type: 'device_inventory',
          format: 'csv',
          config: { filters: { siteIds: [SITE_DENIED] } }
        })
      });

      expect(res.status).toBe(403);
    });

    it('narrows generated device inventory rows to caller allowed sites', async () => {
      permissionState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
      siteScopeState.result = {
        ok: true,
        authority: {
          scope: { version: 1, kind: 'restricted', orgId: ORG_ID, siteIds: [SITE_ALLOWED] },
          principalUserId: 'user-123',
          capturedAt: new Date('2026-07-25T12:00:00.000Z'),
          fingerprint: 'a'.repeat(64),
        },
      };
      mockGenerateDeviceInventoryQuery(rows);

      const res = await app.request('/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ type: 'device_inventory', format: 'csv' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.rows).toHaveLength(1);
      expect(body.data.rows[0].hostname).toBe('allowed-device');
      expect(body.data.rowCount).toBe(1);
    });

    it('does not narrow generated reports for an unrestricted caller', async () => {
      mockGenerateDeviceInventoryQuery(rows);

      const res = await app.request('/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ type: 'device_inventory', format: 'csv' })
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.rows).toHaveLength(2);
      expect(body.data.rowCount).toBe(2);
    });
  });
});

describe('report run immutable scope enforcement', () => {
  const USER_ID = '44444444-4444-4444-8444-444444444444';
  const ORG_A = ORG_ID;
  const ORG_B = '66666666-6666-4666-8666-666666666666';
  const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const REPORT_ID = '77777777-7777-4777-8777-777777777777';
  const RUN_ID = '88888888-8888-4888-8888-888888888888';
  const MISSING_RUN_ID = '99999999-9999-4999-8999-999999999999';
  const CAPTURED_AT = new Date('2026-07-25T12:00:00.000Z');

  function authority(
    kind: 'unrestricted' | 'restricted',
    siteIds: string[] = [],
    orgId = ORG_A,
  ) {
    return {
      ok: true,
      authority: {
        scope: kind === 'restricted'
          ? { version: 1, kind, orgId, siteIds }
          : { version: 1, kind, orgId },
        principalUserId: USER_ID,
        capturedAt: CAPTURED_AT,
        fingerprint: kind === 'restricted'
          ? 'a'.repeat(64)
          : 'f'.repeat(64),
      },
    };
  }

  function definitionMetadata(overrides: Record<string, unknown> = {}) {
    return {
      id: REPORT_ID,
      orgId: ORG_A,
      executionScopeVersion: 1,
      executionScopeKind: 'restricted',
      executionScopeSiteIds: [SITE_A],
      executionScopeUserId: USER_ID,
      executionScopeFingerprint: 'a'.repeat(64),
      executionScopeCapturedAt: CAPTURED_AT,
      ...overrides,
    };
  }

  function definition(overrides: Record<string, unknown> = {}) {
    return {
      ...definitionMetadata(),
      name: 'Scoped Inventory',
      type: 'device_inventory',
      config: {},
      schedule: 'one_time',
      format: 'csv',
      ...overrides,
    };
  }

  function runMetadata(overrides: Record<string, unknown> = {}) {
    return {
      id: RUN_ID,
      reportId: REPORT_ID,
      orgId: ORG_A,
      executionScopeVersion: 1,
      executionScopeKind: 'restricted',
      executionScopeSiteIds: [SITE_A],
      executionScopeUserId: USER_ID,
      executionScopeFingerprint: 'a'.repeat(64),
      executionScopeCapturedAt: CAPTURED_AT,
      ...overrides,
    };
  }

  function conditionContainsIdentity(condition: any, target: unknown): boolean {
    if (condition === target) return true;
    if (!condition || !Array.isArray(condition.conditions)) return false;
    return condition.conditions.some((child: unknown) =>
      conditionContainsIdentity(child, target)
    );
  }

  function conditionValues(condition: any, column: string): unknown[] {
    if (!condition) return [];
    if (Array.isArray(condition.conditions)) {
      return condition.conditions.flatMap((child: unknown) =>
        conditionValues(child, column)
      );
    }
    if (condition.column !== column) return [];
    return condition.values ?? [condition.value];
  }

  function capturedSelectChain(rows: unknown[], captured: unknown[]) {
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      leftJoin: vi.fn(() => chain),
      where: vi.fn((condition: unknown) => {
        captured.push(condition);
        return chain;
      }),
      orderBy: vi.fn(() => chain),
      groupBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      offset: vi.fn(() => chain),
      for: vi.fn(() => chain),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  }

  function conditionalRecentRunsChain(
    authorizedRows: unknown[],
    hiddenRows: unknown[],
    capturedConditions: unknown[],
    capturedProjections: unknown[],
  ) {
    let condition: unknown;
    let limit = Number.POSITIVE_INFINITY;
    const chain: any = {
      from: vi.fn(() => chain),
      innerJoin: vi.fn(() => chain),
      where: vi.fn((value: unknown) => {
        condition = value;
        capturedConditions.push(value);
        return chain;
      }),
      orderBy: vi.fn(() => chain),
      limit: vi.fn((value: number) => {
        limit = value;
        return chain;
      }),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => {
        capturedProjections.push(condition);
        const rows = conditionContainsIdentity(
          condition,
          siteScopeState.exactRunPredicate,
        )
          ? authorizedRows
          : hiddenRows;
        return Promise.resolve(rows.slice(0, limit)).then(resolve, reject);
      },
    };
    return chain;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    authState.auth = authState.makeDefault();
    permissionState.deny = false;
    permissionState.permissions = undefined;
    siteScopeState.result = authority('unrestricted') as any;
    siteScopeState.mapResult = new Map();
    vi.mocked(isSiteScopeSubset).mockReturnValue(true);
    vi.mocked(intersectSiteScopes).mockImplementation(
      (persisted: any) => persisted,
    );
    vi.mocked(generateReport).mockResolvedValue({
      rows: [{ hostname: 'site-a-device' }],
      rowCount: 1,
    });
  });

  it('intersects definition/current scope, persists one immutable run snapshot, and passes that exact authority into generation', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);
    siteScopeState.result = authority('restricted', [SITE_A]) as any;
    const narrowedScope = {
      version: 1 as const,
      kind: 'restricted' as const,
      orgId: ORG_A,
      siteIds: [SITE_A],
    };
    vi.mocked(intersectSiteScopes).mockReturnValue(narrowedScope);
    const insertedValues: any[] = [];

    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([definitionMetadata()]))
      .mockReturnValueOnce(selectChain([definition()]));
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn((values: unknown) => {
        insertedValues.push(values);
        return {
          returning: vi.fn().mockResolvedValue([{
            id: RUN_ID,
            reportId: REPORT_ID,
            status: 'pending',
          }]),
        };
      }),
    } as any);

    const res = await app.request(`/reports/${REPORT_ID}/generate`, {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
      expect.anything(),
      ORG_A,
      'read',
    );
    expect(intersectSiteScopes).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        kind: 'restricted',
        orgId: ORG_A,
        siteIds: [SITE_A],
      }),
      expect.objectContaining(narrowedScope),
    );
    expect(insertedValues).toEqual([
      expect.objectContaining({
        reportId: REPORT_ID,
        status: 'pending',
        executionScopeVersion: 1,
        executionScopeKind: 'restricted',
        executionScopeSiteIds: [SITE_A],
        executionScopeUserId: USER_ID,
        executionScopeFingerprint: 'a'.repeat(64),
        executionScopeCapturedAt: CAPTURED_AT,
      }),
    ]);
    expect(generateReport).toHaveBeenCalledWith(
      'device_inventory',
      ORG_A,
      {},
      expect.objectContaining({
        scope: narrowedScope,
        principalUserId: USER_ID,
        capturedAt: CAPTURED_AT,
        fingerprint: 'a'.repeat(64),
      }),
    );
  });

  it('rejects restricted-empty live authority before insert, generation, baseline, mutation, or success audit', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);
    siteScopeState.result = { ok: false, reason: 'empty_scope' } as any;
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([definitionMetadata()]),
    );

    const res = await app.request(`/reports/${REPORT_ID}/generate`, {
      method: 'POST',
    });

    expect([403, 404]).toContain(res.status);
    expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
      expect.anything(),
      ORG_A,
      'read',
    );
    expect(db.insert).not.toHaveBeenCalled();
    expect(generateReport).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('rejects a saved config outside the immutable authority before insert, audit, or mutation', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);
    siteScopeState.result = authority('restricted', [SITE_A]) as any;
    const narrowedScope = {
      version: 1 as const,
      kind: 'restricted' as const,
      orgId: ORG_A,
      siteIds: [SITE_A],
    };
    vi.mocked(intersectSiteScopes).mockReturnValue(narrowedScope);
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([definitionMetadata()]))
      .mockReturnValueOnce(selectChain([definition({
        config: { filters: { siteIds: [SITE_B] } },
      })]));

    const res = await app.request(`/reports/${REPORT_ID}/generate`, {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
    expect(generateReport).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it.each([
    {
      mode: 'organization exact scope',
      configure: () => {
        authState.auth = authState.makeDefault();
        siteScopeState.result = authority('restricted', [SITE_A]) as any;
      },
      predicate: () => siteScopeState.exactRunPredicate,
      resolver: () => resolveRequestReportAuthority,
    },
    {
      mode: 'partner per-organization composite scope',
      configure: () => {
        authState.auth = {
          ...authState.makeDefault(),
          scope: 'partner',
          partnerId: 'partner-a',
          orgId: null,
          accessibleOrgIds: [ORG_A, ORG_B],
          canAccessOrg: (orgId: string) =>
            orgId === ORG_A || orgId === ORG_B,
        };
        siteScopeState.mapResult = new Map([
          [ORG_A, authority('unrestricted', [], ORG_A)],
          [ORG_B, authority('restricted', [SITE_B], ORG_B)],
        ]) as any;
      },
      predicate: () => siteScopeState.compositeRunPredicate,
      resolver: () => resolveRequestReportAuthorityMap,
    },
    {
      mode: 'system unrestricted provenance scope',
      configure: () => {
        authState.auth = {
          ...authState.makeDefault(),
          scope: 'system',
          partnerId: null,
          orgId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => true,
        };
      },
      predicate: () => siteScopeState.systemRunPredicate,
      resolver: () => unrestrictedReportRunScopeSqlPredicate,
    },
  ])(
    'uses one $mode predicate for count/page and exact 2/2/1 pagination',
    async ({ configure, predicate, resolver }) => {
      configure();
      const visiblePages = [
        [{ id: 'visible-1' }, { id: 'visible-2' }],
        [{ id: 'visible-3' }, { id: 'visible-4' }],
        [{ id: 'visible-5' }],
      ];
      const capturedConditions: unknown[] = [];

      for (let index = 0; index < visiblePages.length; index += 1) {
        vi.mocked(db.select)
          .mockReturnValueOnce(
            capturedSelectChain([{ count: 5 }], capturedConditions),
          )
          .mockReturnValueOnce(
            capturedSelectChain(visiblePages[index]!, capturedConditions),
          );
        const app = new Hono();
        app.route('/reports', reportRoutes);
        const res = await app.request(
          `/reports/runs?page=${index + 1}&limit=2`,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data).toEqual(visiblePages[index]);
        expect(body.pagination).toEqual({
          page: index + 1,
          limit: 2,
          total: 5,
        });
      }

      expect(resolver()).toHaveBeenCalled();
      expect(capturedConditions).toHaveLength(6);
      for (const condition of capturedConditions) {
        expect(
          conditionContainsIdentity(condition, predicate()),
        ).toBe(true);
      }
      expect(capturedConditions[0]).toBe(capturedConditions[1]);
      expect(capturedConditions[2]).toBe(capturedConditions[3]);
      expect(capturedConditions[4]).toBe(capturedConditions[5]);
    },
  );

  it('omits denied and restricted-empty partner organizations from the run composite', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);
    authState.auth = {
      ...authState.makeDefault(),
      scope: 'partner',
      partnerId: 'partner-a',
      orgId: null,
      accessibleOrgIds: [ORG_A, ORG_B],
      canAccessOrg: (orgId: string) =>
        orgId === ORG_A || orgId === ORG_B,
    };
    siteScopeState.mapResult = new Map([
      [ORG_A, { ok: false, reason: 'permission_removed' }],
      [ORG_B, { ok: false, reason: 'empty_scope' }],
    ]) as any;
    const capturedConditions: unknown[] = [];
    vi.mocked(db.select)
      .mockReturnValueOnce(
        capturedSelectChain([{ count: 0 }], capturedConditions),
      )
      .mockReturnValueOnce(capturedSelectChain([], capturedConditions));

    const res = await app.request('/reports/runs?limit=2');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: [],
      pagination: { total: 0 },
    });
    expect(reportRunMultiOrgScopeSqlPredicate).toHaveBeenCalledWith(
      'reports.orgId',
      expect.anything(),
      [],
    );
  });

  it('filters recentRuns in SQL before limiting and never materializes hidden result payloads', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);
    siteScopeState.result = authority('restricted', [SITE_A]) as any;
    const authorizedRows = [1, 2, 3, 4, 5].map((value) => ({
      id: `site-a-${value}`,
      reportId: REPORT_ID,
      status: 'completed',
      rowCount: value,
      createdAt: new Date(`2026-07-2${value}T00:00:00.000Z`),
    }));
    const hiddenRows = [
      {
        id: 'site-b-hidden',
        reportId: REPORT_ID,
        status: 'completed',
        result: { rows: [{ secret: 'site-b' }] },
        createdAt: new Date('2026-07-31T00:00:00.000Z'),
      },
      ...authorizedRows,
    ];
    const capturedConditions: unknown[] = [];
    const observedConditions: unknown[] = [];
    const projections: unknown[] = [];
    vi.mocked(db.select).mockImplementation((projection?: unknown) => {
      projections.push(projection);
      if (projections.length === 1) {
        return selectChain([definitionMetadata()]) as any;
      }
      if (projections.length === 2) {
        return selectChain([definition()]) as any;
      }
      return conditionalRecentRunsChain(
        authorizedRows,
        hiddenRows,
        capturedConditions,
        observedConditions,
      ) as any;
    });

    const res = await app.request(`/reports/${REPORT_ID}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recentRuns).toHaveLength(5);
    expect(body.recentRuns.map((run: any) => run.id)).toEqual(
      authorizedRows.map((run) => run.id),
    );
    expect(JSON.stringify(body.recentRuns)).not.toContain('site-b');
    expect(reportRunScopeSqlPredicate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        kind: 'restricted',
        siteIds: [SITE_A],
      }),
    );
    expect(
      conditionContainsIdentity(
        capturedConditions[0],
        siteScopeState.exactRunPredicate,
      ),
    ).toBe(true);
    expect(projections[2]).toBeDefined();
    expect(Object.values(projections[2] as Record<string, unknown>))
      .not.toContain('reportRuns.result');
  });

  it.each([
    {
      route: (id: string) => `/reports/runs/${id}`,
      action: 'read',
    },
    {
      route: (id: string) => `/reports/runs/${id}/download?format=json`,
      action: 'export',
    },
  ])(
    'uses metadata-only exact-row rebinding and a predicate-guarded payload lookup for $action',
    async ({ route, action }) => {
      const app = new Hono();
      app.route('/reports', reportRoutes);
      siteScopeState.result = authority('restricted', [SITE_A]) as any;
      const projections: unknown[] = [];
      const conditions: unknown[] = [];
      vi.mocked(db.select).mockImplementation((projection?: unknown) => {
        projections.push(projection);
        if (projections.length === 1) {
          return capturedSelectChain([{
            ...runMetadata(),
            status: 'completed',
            createdAt: CAPTURED_AT,
          }], conditions) as any;
        }
        return capturedSelectChain([{
          ...runMetadata(),
          status: 'completed',
          createdAt: CAPTURED_AT,
          reportName: 'Scoped Inventory',
          reportType: 'device_inventory',
          reportFormat: 'json',
          result: { rows: [{ hostname: 'site-a-device' }] },
        }], conditions) as any;
      });

      const res = await app.request(route(RUN_ID));

      expect(res.status).toBe(200);
      expect(Object.values(projections[0] as Record<string, unknown>))
        .not.toContain('reportRuns.result');
      expect(Object.keys(projections[0] as Record<string, unknown>).sort())
        .toEqual([
          'executionScopeCapturedAt',
          'executionScopeFingerprint',
          'executionScopeKind',
          'executionScopeSiteIds',
          'executionScopeUserId',
          'executionScopeVersion',
          'id',
          'orgId',
          'reportId',
        ]);
      expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
        expect.anything(),
        ORG_A,
        action,
      );
      expect(decodeSiteScope).toHaveBeenCalledWith(
        expect.objectContaining({ id: RUN_ID }),
        ORG_A,
      );
      expect(isSiteScopeSubset).toHaveBeenCalled();
      expect(reportRunScopeSqlPredicate).toHaveBeenCalled();
      expect(
        conditionContainsIdentity(
          conditions[1],
          siteScopeState.exactRunPredicate,
        ),
      ).toBe(true);
    },
  );

  it.each([
    {
      mode: 'partner',
      configure: () => {
        authState.auth = {
          ...authState.makeDefault(),
          scope: 'partner',
          partnerId: 'partner-a',
          orgId: null,
          accessibleOrgIds: [ORG_A, ORG_B],
          canAccessOrg: (orgId: string) =>
            orgId === ORG_A || orgId === ORG_B,
        };
      },
    },
    {
      mode: 'system',
      configure: () => {
        authState.auth = {
          ...authState.makeDefault(),
          scope: 'system',
          partnerId: null,
          orgId: null,
          accessibleOrgIds: [],
          canAccessOrg: () => true,
        };
      },
    },
  ])(
    '$mode known-ID access rebinds to the target organization instead of reusing list scope',
    async ({ configure }) => {
      configure();
      const app = new Hono();
      app.route('/reports', reportRoutes);
      siteScopeState.result = authority(
        'restricted',
        [SITE_B],
        ORG_B,
      ) as any;
      vi.mocked(db.select)
        .mockReturnValueOnce(capturedSelectChain([{
          ...runMetadata({ orgId: ORG_B, executionScopeSiteIds: [SITE_B] }),
          status: 'completed',
        }], []))
        .mockReturnValueOnce(capturedSelectChain([{
          ...runMetadata({ orgId: ORG_B, executionScopeSiteIds: [SITE_B] }),
          status: 'completed',
          reportName: 'B1 inventory',
          reportType: 'device_inventory',
          reportFormat: 'json',
        }], []));

      const res = await app.request(`/reports/runs/${RUN_ID}`);

      expect(res.status).toBe(200);
      expect(resolveRequestReportAuthority).toHaveBeenCalledWith(
        expect.anything(),
        ORG_B,
        'read',
      );
      expect(resolveRequestReportAuthorityMap).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      route: (id: string) => `/reports/runs/${id}`,
      action: 'read',
    },
    {
      route: (id: string) => `/reports/runs/${id}/download?format=json`,
      action: 'export',
    },
  ])(
    'makes a known Site B $action response identical to a nonexistent run and selects no hidden payload',
    async ({ route }) => {
      const app = new Hono();
      app.route('/reports', reportRoutes);
      siteScopeState.result = authority('restricted', [SITE_A]) as any;
      vi.mocked(isSiteScopeSubset).mockReturnValue(false);
      const projections: unknown[] = [];
      vi.mocked(db.select).mockImplementation((projection?: unknown) => {
        projections.push(projection);
        if (projections.length === 1) {
          return selectChain([{
            ...runMetadata({
              executionScopeSiteIds: [SITE_B],
              executionScopeFingerprint: 'b'.repeat(64),
            }),
            status: 'completed',
          }]) as any;
        }
        return selectChain([{
          ...runMetadata({
            executionScopeSiteIds: [SITE_B],
            executionScopeFingerprint: 'b'.repeat(64),
          }),
          status: 'completed',
          result: { rows: [{ secret: 'site-b' }] },
          reportType: 'device_inventory',
          reportName: 'Hidden',
          reportFormat: 'json',
        }]) as any;
      });

      const hidden = await app.request(route(RUN_ID));
      const hiddenBody = await hidden.text();

      projections.length = 0;
      vi.mocked(db.select).mockReset();
      vi.mocked(db.select).mockReturnValueOnce(selectChain([]));
      const missing = await app.request(route(MISSING_RUN_ID));
      const missingBody = await missing.text();

      expect(hidden.status).toBe(missing.status);
      expect(hiddenBody).toBe(missingBody);
      expect(hidden.status).toBe(404);
      expect(projections).toHaveLength(0);
    },
  );

  it('binds report/status filters alongside the same immutable run predicate', async () => {
    const app = new Hono();
    app.route('/reports', reportRoutes);
    const capturedConditions: unknown[] = [];
    vi.mocked(db.select)
      .mockReturnValueOnce(
        capturedSelectChain([{ count: 1 }], capturedConditions),
      )
      .mockReturnValueOnce(
        capturedSelectChain([{ id: RUN_ID }], capturedConditions),
      );

    const res = await app.request(
      `/reports/runs?reportId=${REPORT_ID}&status=completed`,
    );

    expect(res.status).toBe(200);
    for (const condition of capturedConditions) {
      expect(
        conditionContainsIdentity(
          condition,
          siteScopeState.exactRunPredicate,
        ),
      ).toBe(true);
      expect(conditionValues(condition, 'reportRuns.reportId'))
        .toContain(REPORT_ID);
      expect(conditionValues(condition, 'reportRuns.status'))
        .toContain('completed');
    }
  });
});
