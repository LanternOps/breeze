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
    status: 'devices.status',
    isEphemeral: 'devices.isEphemeral',
    hostname: 'devices.hostname',
    osType: 'devices.osType',
    lastSeenAt: 'devices.lastSeenAt',
    displayName: 'devices.displayName',
    pendingReboot: 'devices.pendingReboot',
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
// The ring path reads approvals on the request connection; no DB context here.
vi.mock('../../db/partnerAxisRead', () => ({
  readOwnPartnerAxisRows: (_partnerId: string, fn: () => Promise<unknown>) => fn(),
}));
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

// W06 image term — the real SQL is covered by
// services/workloads/imageCompliance.integration.test.ts. Default: no device
// has workload rows, so every response must be exactly what it was before.
const imageTermsMock = vi.hoisted(() => vi.fn(async () => new Map()));
vi.mock('../../services/workloads/imageCompliance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/workloads/imageCompliance')>()),
  containerImageComplianceTerms: imageTermsMock,
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

  // #9611: the dashboard card read "80 of 98 devices fully patched" next to a
  // Total Devices tile of 94 — decommissioned devices were in the compliance
  // population but not in the device KPIs. Both now share one predicate.
  it('excludes decommissioned devices from the compliance population', async () => {
    const getDeviceWhere = mockComplianceQueries([DEVICE_ID]);

    const res = await mountApp().request('/patches/compliance', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const where = conditionText(getDeviceWhere());
    expect(where).toContain('devices.status');
    expect(where).toContain("!= 'decommissioned'");
    expect(where).toContain('devices.isEphemeral');
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


describe('patch compliance container image term (W06)', () => {
  const breakdownRow = (over: Record<string, unknown> = {}) => ({
    deviceId: DEVICE_ID, hostname: 'h1', osType: 'linux', lastSeenAt: null,
    missingCount: 2, approvedMissing: 0, unapprovedMissing: 2, failedMissing: 0,
    criticalCount: 0, importantCount: 0, osMissing: 2, thirdPartyMissing: 0,
    lastInstalledAt: null, pendingReboot: false, lastScannedAt: null, ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    loadFailedInstallPairsMock.mockResolvedValue([]);
    permissionsState = undefined;
    vi.mocked(db.select).mockReset();
    imageTermsMock.mockResolvedValue(new Map());
  });

  function mockQueries(opts: {
    statusRows: Array<{ status: string; count: number }>;
    breakdown: unknown[];
    deviceRows?: unknown[];
  }) {
    const chain = vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(opts.deviceRows ?? [{ id: DEVICE_ID }, { id: OTHER_DEVICE_ID }]),
        }),
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ groupBy: vi.fn().mockResolvedValue(opts.statusRows) }),
          }),
        }),
      } as never)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                groupBy: vi.fn().mockReturnValue({
                  having: vi.fn().mockReturnValue({ orderBy: vi.fn().mockResolvedValue(opts.breakdown) }),
                }),
              }),
            }),
          }),
        }),
      } as never);
    // severity counts (stale-image-only devices come from the population rows,
    // with no second device query)
    chain.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ groupBy: vi.fn().mockResolvedValue([]) }),
        }),
      }),
    } as never);
  }

  const get = async (qs = '') => {
    const res = await mountApp().request(`/patches/compliance${qs}`, { method: 'GET', headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
    return (await res.json()).data;
  };

  it('is byte-identical to the pre-W06 response when no device has workload rows', async () => {
    mockQueries({ statusRows: [{ status: 'installed', count: 3 }, { status: 'pending', count: 1 }], breakdown: [breakdownRow()] });
    const data = await get();
    expect(imageTermsMock).toHaveBeenCalledWith({ deviceIds: [DEVICE_ID, OTHER_DEVICE_ID] });
    expect(data.compliancePercent).toBe(75);
    expect(data.compliantDevices).toBe(1);
    // #9791 C appends the device-level fields; every pre-existing key keeps its place.
    expect(Object.keys(data)).toEqual([
      'summary', 'compliancePercent', 'totalDevices', 'compliantDevices', 'criticalSummary',
      'importantSummary', 'unratedSummary', 'devicesNeedingPatches', 'filters',
      'devicePercent', 'failedDevices', 'deviceCounts', 'outstandingTotals', 'devices', 'devicesPage',
    ]);
    expect(Object.keys(data.devicesNeedingPatches[0])).not.toContain('staleImages');
  });

  it('folds summed image terms into the org %, and a stale-image-only device is not compliant', async () => {
    imageTermsMock.mockResolvedValue(new Map([
      [DEVICE_ID, { stale: 1, current: 0, unknown: 2 }],
      [OTHER_DEVICE_ID, { stale: 1, current: 2, unknown: 0 }],
    ]));
    mockQueries({
      statusRows: [{ status: 'installed', count: 3 }, { status: 'pending', count: 1 }],
      breakdown: [breakdownRow()],
      deviceRows: [
        { id: DEVICE_ID, hostname: 'h1', osType: 'linux', lastSeenAt: null },
        { id: OTHER_DEVICE_ID, hostname: 'h2', osType: 'linux', lastSeenAt: null },
      ],
    });
    const data = await get();
    // (3 installed + 2 current) / (4 OS items + 2 stale + 2 current)
    expect(data.compliancePercent).toBe(63);
    expect(data.containerImages).toEqual({ stale: 2, current: 2, unknown: 2 });
    expect(data.compliantDevices).toBe(0);
    expect(data.totalDevices - data.compliantDevices).toBe(data.devicesNeedingPatches.length);
    expect(data.devicesNeedingPatches[0]).toMatchObject({ id: DEVICE_ID, missingCount: 2, staleImages: 1, unknownImages: 2 });
    expect(data.devicesNeedingPatches[1]).toMatchObject({
      id: OTHER_DEVICE_ID, name: 'h2', missingCount: 0, approvedMissing: 0, staleImages: 1, unknownImages: 0,
    });
    // summary stays an OS-patch status count
    expect(data.summary).toMatchObject({ installed: 3, pending: 1 });
  });

  it('unknown images alone change nothing but the coverage count', async () => {
    imageTermsMock.mockResolvedValue(new Map([[OTHER_DEVICE_ID, { stale: 0, current: 0, unknown: 4 }]]));
    mockQueries({ statusRows: [{ status: 'installed', count: 0 }, { status: 'pending', count: 2 }], breakdown: [breakdownRow()] });
    const data = await get();
    expect(data.compliancePercent).toBe(0);
    expect(data.compliantDevices).toBe(1);
    expect(data.containerImages).toEqual({ stale: 0, current: 0, unknown: 4 });
    expect(data.devicesNeedingPatches).toHaveLength(1);
  });

  it.each([['severity', '?severity=critical'], ['source', '?source=microsoft']])(
    'a %s-filtered view excludes the term entirely',
    async (_name, qs) => {
      imageTermsMock.mockResolvedValue(new Map([[OTHER_DEVICE_ID, { stale: 5, current: 0, unknown: 0 }]]));
      mockQueries({ statusRows: [{ status: 'installed', count: 1 }], breakdown: [] });
      const data = await get(qs);
      expect(imageTermsMock).not.toHaveBeenCalled();
      expect(data.compliancePercent).toBe(100);
      expect(data.compliantDevices).toBe(2);
      expect(data).not.toHaveProperty('containerImages');
    },
  );
});

// #9791 C: the device percentage and the paginated device list that the
// Patches page and the dashboard both read (item % stays in compliancePercent).
describe('patch compliance device percent + device list (#9791 C)', () => {
  const PARTNER_ORG_B = '55555555-5555-4555-8555-555555555555';
  const detailRow = (id: string, over: Record<string, unknown> = {}) => ({
    id, hostname: `host-${id.slice(0, 4)}`, displayName: null, osType: 'windows',
    lastSeenAt: null, status: 'online', orgId: ORG_ID, pendingReboot: false, ...over,
  });
  const breakdownRow = (deviceId: string, over: Record<string, unknown> = {}) => ({
    deviceId, hostname: `host-${deviceId.slice(0, 4)}`, osType: 'windows', lastSeenAt: null,
    missingCount: 1, approvedMissing: 1, unapprovedMissing: 0, failedMissing: 0,
    criticalCount: 0, importantCount: 0, osMissing: 1, thirdPartyMissing: 0,
    lastInstalledAt: null, pendingReboot: false, lastScannedAt: null, ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    loadFailedInstallPairsMock.mockResolvedValue([]);
    imageTermsMock.mockResolvedValue(new Map());
    permissionsState = undefined;
  });

  function mockQueries(opts: {
    details: unknown[];
    statusRows?: Array<{ status: string; count: number }>;
    breakdown?: unknown[];
  }) {
    let deviceWhere: unknown;
    const chain = vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn((condition: unknown) => {
          deviceWhere = condition;
          return Promise.resolve(opts.details);
        }),
      }),
    } as never);
    if (opts.details.length > 0) {
      chain
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({ groupBy: vi.fn().mockResolvedValue(opts.statusRows ?? []) }),
            }),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  groupBy: vi.fn().mockReturnValue({
                    having: vi.fn().mockReturnValue({ orderBy: vi.fn().mockResolvedValue(opts.breakdown ?? []) }),
                  }),
                }),
              }),
            }),
          }),
        } as never)
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({ groupBy: vi.fn().mockResolvedValue([]) }),
            }),
          }),
        } as never);
    }
    return () => deviceWhere;
  }

  function mountFleetApp() {
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as any).set('auth', {
        user: { id: 'user-1' },
        scope: 'partner',
        orgId: null,
        partnerId: 'partner-1',
        accessibleOrgIds: [ORG_ID, PARTNER_ORG_B],
        canAccessOrg: (orgId: string) => orgId === ORG_ID || orgId === PARTNER_ORG_B,
        orgCondition: (column: unknown) => ({ orgCondition: column, orgIds: [ORG_ID, PARTNER_ORG_B] }),
      });
      await next();
    });
    app.route('/patches', complianceRoutes);
    return app;
  }

  const get = async (qs = '', app = mountApp()) => {
    const res = await app.request(`/patches/compliance${qs}`, { method: 'GET', headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(200);
    return (await res.json()).data;
  };

  it('an empty fleet reads devicePercent 0, never NaN, with an empty device list', async () => {
    mockQueries({ details: [] });
    const data = await get();
    expect(data.totalDevices).toBe(0);
    expect(data.devicePercent).toBe(0);
    expect(data.failedDevices).toBe(0);
    expect(data.devices).toEqual([]);
    expect(data.devicesPage).toMatchObject({ status: 'all', total: 0 });
    // the item % keeps its historical empty value
    expect(data.compliancePercent).toBe(100);
  });

  it('a site-scoped viewer with an empty allowlist gets the same empty shape', async () => {
    permissionsState = { allowedSiteIds: [] };
    const data = await get();
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
    expect(data.devicePercent).toBe(0);
    expect(data.devices).toEqual([]);
  });

  it('devicePercent is the device share while compliancePercent stays the item share', async () => {
    mockQueries({
      details: [detailRow(DEVICE_ID), detailRow(OTHER_DEVICE_ID)],
      statusRows: [{ status: 'installed', count: 9 }, { status: 'pending', count: 1 }],
      breakdown: [breakdownRow(DEVICE_ID, { failedMissing: 1, approvedMissing: 0 })],
    });
    const data = await get();
    expect(data.compliancePercent).toBe(90);
    expect(data.devicePercent).toBe(50);
    expect(data.compliantDevices).toBe(1);
    expect(data.failedDevices).toBe(1);
    expect(data.deviceCounts).toMatchObject({ all: 2, compliant: 1, needsPatches: 1, failed: 1 });
  });

  it('selects the row columns, including orgId, from the counted device set', async () => {
    mockQueries({ details: [detailRow(DEVICE_ID)] });
    await get();
    const selection = vi.mocked(db.select).mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(selection)).toEqual(expect.arrayContaining([
      'id', 'hostname', 'displayName', 'osType', 'lastSeenAt', 'status', 'orgId', 'pendingReboot',
    ]));
  });

  it('status=compliant returns only compliant rows, each carrying orgId', async () => {
    mockQueries({
      details: [detailRow(DEVICE_ID), detailRow(OTHER_DEVICE_ID, { displayName: 'Front Desk' })],
      breakdown: [breakdownRow(DEVICE_ID)],
    });
    const data = await get('?status=compliant');
    expect(data.devices).toHaveLength(1);
    expect(data.devices[0]).toMatchObject({
      id: OTHER_DEVICE_ID, compliant: true, orgId: ORG_ID, displayName: 'Front Desk', pendingPatches: 0,
    });
    expect(data.devicesPage).toMatchObject({ status: 'compliant', total: 1, offset: 0 });
  });

  it('compliant and needs-patches page totals add up to totalDevices', async () => {
    const details = [detailRow(DEVICE_ID), detailRow(OTHER_DEVICE_ID)];
    const breakdown = [breakdownRow(DEVICE_ID)];
    mockQueries({ details, breakdown });
    const compliant = await get('?status=compliant');
    mockQueries({ details, breakdown });
    const needs = await get('?status=needs-patches');
    expect(compliant.devicesPage.total + needs.devicesPage.total).toBe(compliant.totalDevices);
    expect(needs.devices.map((d: { id: string }) => d.id)).toEqual([DEVICE_ID]);
  });

  it('limit/offset page the list and the total stays the filtered count', async () => {
    mockQueries({ details: [detailRow(DEVICE_ID), detailRow(OTHER_DEVICE_ID)] });
    const data = await get('?status=all&limit=1&offset=1');
    expect(data.devices).toHaveLength(1);
    expect(data.devicesPage).toMatchObject({ limit: 1, offset: 1, total: 2 });
  });

  it('search narrows the list, never the summary', async () => {
    mockQueries({ details: [detailRow(DEVICE_ID, { hostname: 'alpha' }), detailRow(OTHER_DEVICE_ID, { hostname: 'beta' })] });
    const data = await get('?search=ALP');
    expect(data.devices.map((d: { id: string }) => d.id)).toEqual([DEVICE_ID]);
    expect(data.devicesPage.total).toBe(1);
    expect(data.totalDevices).toBe(2);
    expect(data.deviceCounts.all).toBe(2);
  });

  it('orgId narrows the counted (and listed) device set', async () => {
    // resolvePartnerIdForOrg runs first; no partner keeps approvals on the SQL path.
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as never);
    const getWhere = mockQueries({ details: [detailRow(DEVICE_ID)] });
    const data = await get(`?orgId=${ORG_ID}`);
    const where = conditionText(getWhere());
    expect(where).toContain('devices.orgId');
    expect(where).toContain(ORG_ID);
    expect(data.devices.map((d: { orgId: string }) => d.orgId)).toEqual([ORG_ID]);
  });

  it('allowedSiteIds narrows the counted (and listed) device set', async () => {
    permissionsState = { allowedSiteIds: [SITE_ALLOWED] };
    const getWhere = mockQueries({ details: [detailRow(DEVICE_ID)] });
    const data = await get('?status=all');
    expect(conditionText(getWhere())).toContain(SITE_ALLOWED);
    expect(data.devicesPage.total).toBe(data.totalDevices);
  });

  it('fleet view (no orgId) lists devices across the accessible orgs', async () => {
    const getWhere = mockQueries({
      details: [detailRow(DEVICE_ID), detailRow(OTHER_DEVICE_ID, { orgId: PARTNER_ORG_B })],
    });
    const data = await get('', mountFleetApp());
    expect(conditionText(getWhere())).toContain(PARTNER_ORG_B);
    expect(data.totalDevices).toBe(2);
    expect(new Set(data.devices.map((d: { orgId: string }) => d.orgId))).toEqual(new Set([ORG_ID, PARTNER_ORG_B]));
  });

  it.each([['?status=bogus'], ['?limit=0'], ['?limit=201'], ['?offset=-1']])('rejects %s', async (qs) => {
    const res = await mountApp().request(`/patches/compliance${qs}`, { method: 'GET', headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(400);
  });

  it('a ring with no approved patches lists every counted device as compliant', async () => {
    const RING_ID = '66666666-6666-4666-8666-666666666666';
    const select = vi.mocked(db.select);
    // ring lookup
    select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ partnerId: 'partner-1' }]) }),
      }),
    } as never);
    // counted devices
    select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([detailRow(DEVICE_ID), detailRow(OTHER_DEVICE_ID, { orgId: PARTNER_ORG_B })]),
      }),
    } as never);
    // ring approvals (none), then candidate patch ids (none)
    for (let i = 0; i < 2; i++) {
      select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
      } as never);
    }

    const data = await get(`?ringId=${RING_ID}`, mountFleetApp());
    expect(data.ringId).toBe(RING_ID);
    expect(data.totalDevices).toBe(2);
    expect(data.compliantDevices).toBe(2);
    expect(data.devicePercent).toBe(100);
    expect(data.deviceCounts).toMatchObject({ all: 2, compliant: 2, needsPatches: 0 });
    expect(data.devices).toHaveLength(2);
    expect(data.devices.every((d: { compliant: boolean }) => d.compliant)).toBe(true);
    expect(new Set(data.devices.map((d: { orgId: string }) => d.orgId))).toEqual(new Set([ORG_ID, PARTNER_ORG_B]));
  });

  it('a device listed only for a stale image is a non-compliant row, from the population rows', async () => {
    imageTermsMock.mockResolvedValue(new Map([[OTHER_DEVICE_ID, { stale: 1, current: 0, unknown: 0 }]]));
    mockQueries({ details: [detailRow(DEVICE_ID), detailRow(OTHER_DEVICE_ID, { hostname: 'stale-box' })] });

    const data = await get('?status=needs-patches');
    expect(data.compliantDevices).toBe(1);
    expect(data.deviceCounts.compliant + data.deviceCounts.needsPatches).toBe(data.totalDevices);
    expect(data.devices).toEqual([
      expect.objectContaining({ id: OTHER_DEVICE_ID, hostname: 'stale-box', compliant: false, pendingPatches: 0, staleImages: 1 }),
    ]);
    // the legacy list carries it too, with no second device query
    expect(data.devicesNeedingPatches).toEqual([expect.objectContaining({ id: OTHER_DEVICE_ID, name: 'stale-box' })]);
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(4);
  });
});
