import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { dashboardRoutes } from './dashboard';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEVICE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OTHER_DEVICE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';

let permissionsState: any;

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'leftJoin', 'orderBy', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  chain.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(resolvedValue).then(onFulfilled, onRejected);
  chain.catch = (onRejected: (reason: unknown) => unknown) =>
    Promise.resolve(resolvedValue).catch(onRejected);
  return chain;
}

const selectMock = vi.fn(() => chainMock([]));
const resolveAllBackupAssignedDevicesMock = vi.fn();

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
  },
}));

vi.mock('../../db/schema', () => ({
  backupConfigs: {
    id: 'backup_configs.id',
    orgId: 'backup_configs.org_id',
    name: 'backup_configs.name',
  },
  backupJobs: {
    id: 'backup_jobs.id',
    orgId: 'backup_jobs.org_id',
    deviceId: 'backup_jobs.device_id',
    configId: 'backup_jobs.config_id',
    status: 'backup_jobs.status',
    type: 'backup_jobs.type',
    startedAt: 'backup_jobs.started_at',
    completedAt: 'backup_jobs.completed_at',
    createdAt: 'backup_jobs.created_at',
    totalSize: 'backup_jobs.total_size',
    errorCount: 'backup_jobs.error_count',
    errorLog: 'backup_jobs.error_log',
  },
  backupSnapshots: {
    orgId: 'backup_snapshots.org_id',
    deviceId: 'backup_snapshots.device_id',
    configId: 'backup_snapshots.config_id',
    size: 'backup_snapshots.size',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.org_id',
    siteId: 'devices.site_id',
    displayName: 'devices.display_name',
    hostname: 'devices.hostname',
  },
}));

vi.mock('../../services/featureConfigResolver', () => ({
  resolveBackupConfigForDevice: vi.fn(),
  resolveAllBackupAssignedDevices: (...args: unknown[]) => resolveAllBackupAssignedDevicesMock(...(args as [])),
}));

vi.mock('../../middleware/auth', () => ({
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  gte: (column: unknown, value: unknown) => ({ op: 'gte', column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  desc: (value: unknown) => ({ op: 'desc', value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
}));

describe('backup dashboard routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    selectMock.mockImplementation(() => chainMock([]));
    permissionsState = undefined;
    app = new Hono();
    app.use('*', async (c: any, next) => {
      c.set('auth', {
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        partnerId: null,
        orgId: ORG_ID,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (candidateOrgId: string) => candidateOrgId === ORG_ID,
        token: { sub: 'user-123' },
      });
      if (permissionsState) {
        c.set('permissions', permissionsState);
      }
      await next();
    });
    app.route('/backup', dashboardRoutes);
  });

  it('narrows dashboard per-device rows to allowed sites for site-restricted users', async () => {
    permissionsState = { allowedSiteIds: [SITE_A] };
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
      { deviceId: DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-1' },
      { deviceId: OTHER_DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-2' },
    ]);
    selectMock
      .mockReturnValueOnce(chainMock([
        { id: DEVICE_ID, siteId: SITE_A },
        { id: OTHER_DEVICE_ID, siteId: SITE_B },
      ]))
      .mockReturnValueOnce(chainMock([{ count: 1 }]))
      .mockReturnValueOnce(chainMock([{ count: 1 }]))
      .mockReturnValueOnce(chainMock([{ count: 1 }]))
      .mockReturnValueOnce(chainMock([{ completed: 1, failed: 0, running: 0, pending: 0 }]))
      .mockReturnValueOnce(chainMock([{ totalBytes: 1024, count: 1 }]))
      .mockReturnValueOnce(chainMock([
        makeRecentJob({ deviceId: DEVICE_ID, deviceName: 'Allowed Device' }),
        makeRecentJob({ id: 'job-out', deviceId: OTHER_DEVICE_ID, deviceName: 'Other Device' }),
      ]));

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals.policies).toBe(1);
    expect(body.data.coverage.protectedDevices).toBe(1);
    expect(body.data.latestJobs.map((job: any) => job.deviceId)).toEqual([DEVICE_ID]);
  });

  it('keeps unrestricted dashboard behavior unchanged', async () => {
    resolveAllBackupAssignedDevicesMock.mockResolvedValueOnce([
      { deviceId: DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-1' },
      { deviceId: OTHER_DEVICE_ID, configId: 'config-1', featureLinkId: 'feature-2' },
    ]);
    selectMock
      .mockReturnValueOnce(chainMock([{ count: 2 }]))
      .mockReturnValueOnce(chainMock([{ count: 2 }]))
      .mockReturnValueOnce(chainMock([{ count: 2 }]))
      .mockReturnValueOnce(chainMock([{ completed: 1, failed: 1, running: 0, pending: 0 }]))
      .mockReturnValueOnce(chainMock([{ totalBytes: 2048, count: 2 }]))
      .mockReturnValueOnce(chainMock([
        makeRecentJob({ deviceId: DEVICE_ID, deviceName: 'Allowed Device' }),
        makeRecentJob({ id: 'job-out', deviceId: OTHER_DEVICE_ID, deviceName: 'Other Device' }),
      ]));

    const res = await app.request('/backup/dashboard');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totals.policies).toBe(2);
    expect(body.data.latestJobs).toHaveLength(2);
    expect(selectMock).toHaveBeenCalledTimes(6);
  });
});

function makeRecentJob(overrides: Record<string, unknown> = {}) {
  const job = {
    id: 'job-in',
    type: 'manual',
    deviceId: DEVICE_ID,
    configId: 'config-1',
    status: 'completed',
    startedAt: null,
    completedAt: null,
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
    totalSize: null,
    errorCount: null,
    errorLog: null,
  };
  return {
    job: { ...job, ...overrides },
    deviceName: overrides.deviceName ?? 'Device',
    deviceHostname: 'device-host',
    configName: 'Primary Backup',
  };
}
