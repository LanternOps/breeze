import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { selectMock, updateMock, enqueueBackupDispatchMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  enqueueBackupDispatchMock: vi.fn(),
}));

function makeSelectChain(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'groupBy']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.limit = vi.fn(() => Promise.resolve(resolvedValue));
  chain.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve(resolvedValue).then(onFulfilled, onRejected);
  chain.catch = (onRejected: (reason: unknown) => unknown) =>
    Promise.resolve(resolvedValue).catch(onRejected);
  chain.finally = (onFinally: () => void) =>
    Promise.resolve(resolvedValue).finally(onFinally);
  return chain;
}

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
  },
}));

vi.mock('../../db/schema', () => ({
  backupJobs: {
    id: 'backupJobs.id',
    orgId: 'backupJobs.orgId',
    deviceId: 'backupJobs.deviceId',
    status: 'backupJobs.status',
    completedAt: 'backupJobs.completedAt',
    updatedAt: 'backupJobs.updatedAt',
    errorLog: 'backupJobs.errorLog',
    createdAt: 'backupJobs.createdAt',
  },
  backupConfigs: {
    id: 'backupConfigs.id',
    name: 'backupConfigs.name',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    status: 'devices.status',
    displayName: 'devices.displayName',
    hostname: 'devices.hostname',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
  eq: (column: unknown, value: unknown) => ({ op: 'eq', column, value }),
  desc: (value: unknown) => ({ op: 'desc', value }),
  gte: (column: unknown, value: unknown) => ({ op: 'gte', column, value }),
  lte: (column: unknown, value: unknown) => ({ op: 'lte', column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ op: 'inArray', column, values }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values }),
    { join: (values: unknown[]) => values }
  ),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../services/backupJobCreation', () => ({
  createManualBackupJobIfIdle: vi.fn(),
}));

vi.mock('../../services/featureConfigResolver', () => ({
  resolveBackupConfigForDevice: vi.fn(),
  resolveAllBackupAssignedDevices: vi.fn(),
}));

vi.mock('../../jobs/backupWorker', () => ({
  enqueueBackupDispatch: (...args: unknown[]) => enqueueBackupDispatchMock(...(args as [])),
}));

vi.mock('../../services/backupMetrics', () => ({
  recordBackupDispatchFailure: vi.fn(),
}));

import { createManualBackupJobIfIdle } from '../../services/backupJobCreation';
import { resolveAllBackupAssignedDevices, resolveBackupConfigForDevice } from '../../services/featureConfigResolver';
import { jobsRoutes } from './jobs';

describe('backup jobs routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as any);
    enqueueBackupDispatchMock.mockResolvedValue(undefined);
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', {
        user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: 'org-a',
        partnerId: null,
        accessibleOrgIds: ['org-a'],
        canAccessOrg: (candidateOrgId: string) => candidateOrgId === 'org-a',
        orgCondition: () => undefined,
        token: { sub: 'user-1', scope: 'organization' },
      });
      await next();
    });
    app.route('/', jobsRoutes);
  });

  it('run-all preview only counts online devices without active jobs', async () => {
    vi.mocked(resolveAllBackupAssignedDevices).mockResolvedValueOnce([
      { deviceId: 'device-online', configId: 'config-1', featureLinkId: 'feature-1' } as any,
      { deviceId: 'device-offline', configId: 'config-1', featureLinkId: 'feature-1' } as any,
    ]);
    selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: 'device-online' }]))
      .mockReturnValueOnce(makeSelectChain([]));

    const res = await app.request('/jobs/run-all/preview');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      deviceCount: 1,
      deviceIds: ['device-online'],
      alreadyRunning: 0,
      offline: 1,
    });
  });

  it('returns 409 without creating a job when the target device is offline', async () => {
    selectMock.mockReturnValueOnce(makeSelectChain([{ id: 'device-1', status: 'offline' }]));

    const res = await app.request('/jobs/run/device-1', { method: 'POST' });

    expect(res.status).toBe(409);
    expect(createManualBackupJobIfIdle).not.toHaveBeenCalled();
  });

  it('marks the job failed and returns 502 when dispatch enqueue fails', async () => {
    vi.mocked(resolveBackupConfigForDevice).mockResolvedValueOnce(null);
    selectMock
      .mockReturnValueOnce(makeSelectChain([{ id: 'device-1', status: 'online' }]))
      .mockReturnValueOnce(makeSelectChain([{ id: 'config-1' }]));
    vi.mocked(createManualBackupJobIfIdle).mockResolvedValueOnce({
      created: true,
      job: {
        id: 'job-1',
        orgId: 'org-a',
        configId: 'config-1',
        deviceId: 'device-1',
        featureLinkId: null,
        policyId: null,
        snapshotId: null,
        status: 'pending',
        type: 'manual',
        startedAt: null,
        completedAt: null,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        updatedAt: new Date('2026-04-01T00:00:00Z'),
        totalSize: null,
        fileCount: null,
        errorCount: null,
        errorLog: null,
      } as any,
    } as any);
    enqueueBackupDispatchMock.mockRejectedValueOnce(new Error('Redis unavailable'));

    const res = await app.request('/jobs/run/device-1', { method: 'POST' });

    expect(res.status).toBe(502);
    expect(updateMock).toHaveBeenCalled();
  });

  it('run-all skips offline devices and marks enqueue failures as failed jobs', async () => {
    vi.mocked(resolveAllBackupAssignedDevices).mockResolvedValueOnce([
      { deviceId: 'device-online', configId: 'config-1', featureLinkId: 'feature-1' } as any,
      { deviceId: 'device-failing', configId: 'config-1', featureLinkId: 'feature-1' } as any,
      { deviceId: 'device-offline', configId: 'config-1', featureLinkId: 'feature-1' } as any,
    ]);
    selectMock.mockReturnValueOnce(
      makeSelectChain([{ id: 'device-online' }, { id: 'device-failing' }])
    );
    vi.mocked(createManualBackupJobIfIdle)
      .mockResolvedValueOnce({
        created: true,
        job: {
          id: 'job-online',
          orgId: 'org-a',
          configId: 'config-1',
          deviceId: 'device-online',
          status: 'pending',
          type: 'manual',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          updatedAt: new Date('2026-04-01T00:00:00Z'),
        } as any,
      } as any)
      .mockResolvedValueOnce({
        created: true,
        job: {
          id: 'job-failing',
          orgId: 'org-a',
          configId: 'config-1',
          deviceId: 'device-failing',
          status: 'pending',
          type: 'manual',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          updatedAt: new Date('2026-04-01T00:00:00Z'),
        } as any,
      } as any);
    enqueueBackupDispatchMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Queue unavailable'));

    const res = await app.request('/jobs/run-all', { method: 'POST' });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toEqual({
      created: 1,
      skipped: 1,
      skippedOffline: 1,
      skippedRunning: 0,
      failed: 1,
      jobIds: ['job-online'],
      failedJobIds: ['job-failing'],
    });
  });
});
