import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { c2cJobsRoutes } from './jobs';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONFIG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'orderBy']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
  },
}));

vi.mock('../../db/schema', () => ({
  c2cBackupJobs: {
    id: 'c2c_backup_jobs.id',
    orgId: 'c2c_backup_jobs.org_id',
    configId: 'c2c_backup_jobs.config_id',
    status: 'c2c_backup_jobs.status',
    createdAt: 'c2c_backup_jobs.created_at',
    updatedAt: 'c2c_backup_jobs.updated_at',
    startedAt: 'c2c_backup_jobs.started_at',
    completedAt: 'c2c_backup_jobs.completed_at',
    itemsProcessed: 'c2c_backup_jobs.items_processed',
    itemsNew: 'c2c_backup_jobs.items_new',
    itemsUpdated: 'c2c_backup_jobs.items_updated',
    itemsDeleted: 'c2c_backup_jobs.items_deleted',
    bytesTransferred: 'c2c_backup_jobs.bytes_transferred',
    errorLog: 'c2c_backup_jobs.error_log',
  },
  c2cBackupConfigs: {
    id: 'c2c_backup_configs.id',
    orgId: 'c2c_backup_configs.org_id',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

const enqueueC2cSyncMock = vi.fn().mockResolvedValue('queue-job-1');
vi.mock('../../jobs/c2cEnqueue', () => ({
  enqueueC2cSync: (...args: unknown[]) => enqueueC2cSyncMock(...(args as [])),
}));

const createC2cSyncJobIfIdleMock = vi.fn();
vi.mock('../../services/c2cJobCreation', () => ({
  createC2cSyncJobIfIdle: (...args: unknown[]) =>
    createC2cSyncJobIfIdleMock(...(args as [])),
}));

let authState = {
  user: { id: 'user-123' },
  scope: 'organization' as const,
  partnerId: null,
  orgId: ORG_ID,
  token: { sub: 'user-123' },
};

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
}));

import { authMiddleware } from '../../middleware/auth';

describe('c2c jobs routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.use('*', authMiddleware);
    app.route('/c2c', c2cJobsRoutes);
  });

  it('returns 409 when a sync job is already active for the config', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: CONFIG_ID, orgId: ORG_ID, name: 'M365 Backup' }]));
    createC2cSyncJobIfIdleMock.mockResolvedValue({
      job: {
        id: 'job-existing',
        configId: CONFIG_ID,
        status: 'running',
        startedAt: null,
        completedAt: null,
        itemsProcessed: 0,
        itemsNew: 0,
        itemsUpdated: 0,
        itemsDeleted: 0,
        bytesTransferred: 0,
        errorLog: null,
        createdAt: new Date('2026-03-31T00:00:00Z'),
        updatedAt: new Date('2026-03-31T00:00:00Z'),
      },
      created: false,
    });

    const res = await app.request(`/c2c/configs/${CONFIG_ID}/run`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'A C2C sync job is already pending or running for this configuration',
      jobId: 'job-existing',
    });
    expect(enqueueC2cSyncMock).not.toHaveBeenCalled();
  });

  it('enqueues a newly created sync job', async () => {
    selectMock.mockReturnValueOnce(chainMock([{ id: CONFIG_ID, orgId: ORG_ID, name: 'M365 Backup' }]));
    createC2cSyncJobIfIdleMock.mockResolvedValue({
      job: {
        id: 'job-1',
        configId: CONFIG_ID,
        status: 'pending',
        startedAt: null,
        completedAt: null,
        itemsProcessed: 0,
        itemsNew: 0,
        itemsUpdated: 0,
        itemsDeleted: 0,
        bytesTransferred: 0,
        errorLog: null,
        createdAt: new Date('2026-03-31T00:00:00Z'),
        updatedAt: new Date('2026-03-31T00:00:00Z'),
      },
      created: true,
    });

    const res = await app.request(`/c2c/configs/${CONFIG_ID}/run`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(201);
    expect(enqueueC2cSyncMock).toHaveBeenCalledWith('job-1', CONFIG_ID, ORG_ID);
  });
});
