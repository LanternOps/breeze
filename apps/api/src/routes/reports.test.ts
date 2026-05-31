import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const permissionState = vi.hoisted(() => ({
  deny: false,
  last: null as { resource: string; action: string } | null,
  permissions: undefined as { allowedSiteIds?: string[] } | undefined
}));

vi.mock('../services', () => ({}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: any[]) => ({ op: 'and', conditions }),
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
    }))
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
    lastGeneratedAt: 'reports.lastGeneratedAt'
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
    createdAt: 'reportRuns.createdAt'
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
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com' },
      scope: 'organization',
      partnerId: null,
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
    });
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

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const SITE_ALLOWED = '22222222-2222-2222-2222-222222222222';
const SITE_DENIED = '33333333-3333-3333-3333-333333333333';
const DEVICE_ALLOWED = '44444444-4444-4444-4444-444444444444';
const DEVICE_DENIED = '55555555-5555-5555-5555-555555555555';

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

describe('reports routes', () => {
  let app: Hono;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockReset();
    permissionState.deny = false;
    permissionState.last = null;
    permissionState.permissions = undefined;
    const { reportRoutes } = await import('./reports');
    app = new Hono();
    app.route('/reports', reportRoutes);
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

  it('should generate a saved report run', async () => {
    vi.useFakeTimers();
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'report-1',
            orgId: ORG_ID,
            name: 'Device Inventory',
            type: 'device_inventory',
            schedule: 'daily',
            format: 'csv'
          }])
        })
      })
    } as any);

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
    expect(body.status).toBe('pending');

    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it('should update a report schedule', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'report-1',
            orgId: ORG_ID,
            name: 'Ops Summary',
            schedule: 'monthly'
          }])
        })
      })
    } as any);

    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: 'report-1',
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
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{
                id: 'run-1',
                reportId: 'report-1',
                status: 'completed',
                startedAt: new Date('2024-01-01T00:00:00Z'),
                completedAt: new Date('2024-01-01T00:01:00Z'),
                outputUrl: '/api/reports/runs/run-1/download',
                errorMessage: null,
                rowCount: 12,
                createdAt: new Date('2024-01-01T00:00:00Z'),
                orgId: ORG_ID
              }])
            })
          })
        })
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'report-1',
              name: 'Device Inventory',
              type: 'device_inventory',
              format: 'csv'
            }])
          })
        })
      } as any);

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

  describe('POST /reports/generate site scope', () => {
    const rows = [
      { hostname: 'allowed-device', siteId: SITE_ALLOWED },
      { hostname: 'denied-device', siteId: SITE_DENIED }
    ];

    it('returns 403 when a site-restricted caller filters to an out-of-scope siteId', async () => {
      permissionState.permissions = { allowedSiteIds: [SITE_ALLOWED] };
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
