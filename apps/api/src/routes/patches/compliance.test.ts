import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  OUTSTANDING_DEVICE_PATCH_STATUSES: ['pending', 'failed'],
  patches: {
    id: 'patches.id',
    source: 'patches.source',
    severity: 'patches.severity',
    requiresReboot: 'patches.requiresReboot',
  },
  devicePatches: {
    deviceId: 'devicePatches.deviceId',
    orgId: 'devicePatches.orgId',
    patchId: 'devicePatches.patchId',
    status: 'devicePatches.status',
    installedAt: 'devicePatches.installedAt',
    lastCheckedAt: 'devicePatches.lastCheckedAt',
  },
  patchApprovals: {
    partnerId: 'patchApprovals.partnerId',
    ringId: 'patchApprovals.ringId',
    patchId: 'patchApprovals.patchId',
    status: 'patchApprovals.status',
  },
  patchPolicies: {
    id: 'patchPolicies.id',
    partnerId: 'patchPolicies.partnerId',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
  },
  patchComplianceReports: {
    id: 'patchComplianceReports.id',
    orgId: 'patchComplianceReports.orgId',
    status: 'patchComplianceReports.status',
    format: 'patchComplianceReports.format',
    source: 'patchComplianceReports.source',
    severity: 'patchComplianceReports.severity',
    summary: 'patchComplianceReports.summary',
    rowCount: 'patchComplianceReports.rowCount',
    errorMessage: 'patchComplianceReports.errorMessage',
    startedAt: 'patchComplianceReports.startedAt',
    completedAt: 'patchComplianceReports.completedAt',
    createdAt: 'patchComplianceReports.createdAt',
    outputPath: 'patchComplianceReports.outputPath',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
    osType: 'devices.osType',
    lastSeenAt: 'devices.lastSeenAt',
  },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  // Mirror prod: requirePermission is the only middleware that populates
  // `permissions`. authMiddleware/requireScope do not. The site-scope block in
  // GET /compliance is dead unless this gate runs, so the test must drive
  // `permissions` through here (not by setting it directly in the app).
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionsState) (c as any).set('permissions', permissionsState);
    return next();
  }),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../jobs/patchComplianceReportWorker', () => ({
  enqueuePatchComplianceReport: vi.fn(),
}));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    REPORTS_READ: { resource: 'reports', action: 'read' },
    REPORTS_EXPORT: { resource: 'reports', action: 'export' },
    DEVICES_READ: { resource: 'devices', action: 'read' },
  },
}));

const loadFailedInstallPairsMock = vi.hoisted(() => vi.fn());
vi.mock('../../services/patchInstallFailures', () => ({
  loadFailedInstallPairs: loadFailedInstallPairsMock,
}));

import { complianceRoutes } from './compliance';
import { db } from '../../db';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ALLOWED = '44444444-4444-4444-8444-444444444444';

let permissionsState: { allowedSiteIds?: string[] } | undefined;

function conditionText(value: unknown): string {
  return JSON.stringify(value, (_key, nested) =>
    typeof nested === 'function' ? '[function]' : nested
  );
}

function mountApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    (c as any).set('auth', {
      user: { id: 'user-1' },
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (orgId: string) => orgId === ORG_ID,
      orgCondition: (column: unknown) => ({ orgCondition: column, orgId: ORG_ID }),
    });
    // permissions is populated by the requirePermission mock (mirrors prod), not here.
    await next();
  });
  app.route('/patches', complianceRoutes);
  return app;
}

function mockComplianceQueries(deviceIds: string[]) {
  let deviceWhere: unknown;
  vi.mocked(db.select)
    // org device IDs
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn((condition: unknown) => {
          deviceWhere = condition;
          return Promise.resolve(deviceIds.map((id) => ({ id })));
        }),
      }),
    } as never)
    // status counts
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as never)
    // device breakdown
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockReturnValue({
                having: vi.fn().mockReturnValue({
                  orderBy: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      }),
    } as never)
    // severity counts
    .mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            groupBy: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as never);

  return () => deviceWhere;
}

describe('patch compliance site scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadFailedInstallPairsMock.mockResolvedValue([]);
    permissionsState = undefined;
  });

  it('narrows the orgDevices set to devices in the caller site allowlist', async () => {
    permissionsState = { allowedSiteIds: [SITE_ALLOWED] };
    const getDeviceWhere = mockComplianceQueries([DEVICE_ID]);

    const res = await mountApp().request('/patches/compliance', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    expect(conditionText(getDeviceWhere())).toContain('devices.siteId');
    expect(conditionText(getDeviceWhere())).toContain(SITE_ALLOWED);
  });

  it('leaves unrestricted compliance reads unchanged', async () => {
    const getDeviceWhere = mockComplianceQueries([DEVICE_ID, OTHER_DEVICE_ID]);

    const res = await mountApp().request('/patches/compliance', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totalDevices).toBe(2);
    expect(conditionText(getDeviceWhere())).not.toContain('devices.siteId');
  });
});

describe('patch compliance unrated summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadFailedInstallPairsMock.mockResolvedValue([]);
    permissionsState = undefined;
  });

  it('includes unratedSummary counting both NULL and \'unknown\' severity as unrated', async () => {
    vi.mocked(db.select)
      // org device IDs
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: DEVICE_ID }]),
        }),
      } as never)
      // status counts
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as never)
      // device breakdown
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                groupBy: vi.fn().mockReturnValue({
                  having: vi.fn().mockReturnValue({
                    orderBy: vi.fn().mockResolvedValue([]),
                  }),
                }),
              }),
            }),
          }),
        }),
      } as never)
      // severity counts: one NULL-severity outstanding row, one 'unknown'-severity
      // row (1 installed + 1 outstanding) — both must coalesce into unratedSummary.
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              groupBy: vi.fn().mockResolvedValue([
                { severity: null, installed: 0, outstanding: 1 },
                { severity: 'unknown', installed: 1, outstanding: 1 },
              ]),
            }),
          }),
        }),
      } as never);

    const res = await mountApp().request('/patches/compliance', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.unratedSummary).toEqual({ total: 3, patched: 1, pending: 2 });
  });
});


// #7214: a pending patch whose latest install attempt failed was bucketed as
// "Pending approval" because deviceBreakdown had no failed-install signal.
describe('patch compliance failed installs', () => {
  const PATCH_ID = '55555555-5555-4555-8555-555555555555';

  beforeEach(() => {
    vi.clearAllMocks();
    loadFailedInstallPairsMock.mockResolvedValue([{ deviceId: DEVICE_ID, patchId: PATCH_ID }]);
  });

  function mockWithBreakdown(rows: unknown[], capture: { fields?: Record<string, unknown> }) {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: DEVICE_ID }]) }),
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ groupBy: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      } as never)
      .mockImplementationOnce(((fields: Record<string, unknown>) => {
        capture.fields = fields;
        return {
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  groupBy: vi.fn().mockReturnValue({
                    having: vi.fn().mockReturnValue({ orderBy: vi.fn().mockResolvedValue(rows) }),
                  }),
                }),
              }),
            }),
          }),
        };
      }) as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ groupBy: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      } as never);
  }

  it('exposes failedMissing per device and keeps failed rows out of the approval buckets', async () => {
    const capture: { fields?: Record<string, unknown> } = {};
    mockWithBreakdown(
      [{
        deviceId: DEVICE_ID, hostname: 'h', osType: 'windows', lastSeenAt: null,
        missingCount: 3, approvedMissing: 1, unapprovedMissing: 1, failedMissing: 1,
        criticalCount: 0, importantCount: 0, osMissing: 3, thirdPartyMissing: 0,
        lastInstalledAt: null, pendingReboot: false, lastScannedAt: null,
      }],
      capture,
    );

    const res = await mountApp().request('/patches/compliance', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.devicesNeedingPatches[0]).toMatchObject({
      missingCount: 3, approvedMissing: 1, unapprovedMissing: 1, failedMissing: 1,
    });
    // The failed (device, patch) pair drives failedMissing and is excluded from
    // both approval buckets, so the three buckets partition missingCount.
    const failedSql = conditionText(capture.fields?.failedMissing);
    expect(failedSql).toContain(DEVICE_ID);
    expect(failedSql).toContain(PATCH_ID);
    expect(conditionText(capture.fields?.approvedMissing)).toContain(PATCH_ID);
    expect(conditionText(capture.fields?.unapprovedMissing)).toContain(PATCH_ID);
  });

  it('reports failedMissing 0 when no install has failed', async () => {
    loadFailedInstallPairsMock.mockResolvedValue([]);
    const capture: { fields?: Record<string, unknown> } = {};
    mockWithBreakdown(
      [{
        deviceId: DEVICE_ID, hostname: 'h', osType: 'windows', lastSeenAt: null,
        missingCount: 1, approvedMissing: 0, unapprovedMissing: 1, failedMissing: 0,
        criticalCount: 0, importantCount: 0, osMissing: 1, thirdPartyMissing: 0,
        lastInstalledAt: null, pendingReboot: false, lastScannedAt: null,
      }],
      capture,
    );
    const res = await mountApp().request('/patches/compliance', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });
    const body = await res.json();
    expect(body.data.devicesNeedingPatches[0].failedMissing).toBe(0);
    expect(loadFailedInstallPairsMock).toHaveBeenCalledWith([DEVICE_ID]);
  });
});
