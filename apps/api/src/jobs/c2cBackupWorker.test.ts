import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  processorRef: undefined as any,
  closeMock: vi.fn(),
  processC2cMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Worker: class {
    close = shared.closeMock;
    constructor(_name: string, processor: unknown) {
      shared.processorRef = processor;
    }
  },
  Job: class {},
}));

vi.mock('drizzle-orm', () => {
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings, values })) as unknown;

  return {
    and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
    eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
    sql,
  };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
  withSystemDbAccessContext: undefined,
}));

vi.mock('../db/schema', () => ({
  c2cBackupConfigs: {
    id: 'c2cBackupConfigs.id',
    orgId: 'c2cBackupConfigs.orgId',
    isActive: 'c2cBackupConfigs.isActive',
  },
  c2cBackupItems: {
    id: 'c2cBackupItems.id',
    orgId: 'c2cBackupItems.orgId',
    configId: 'c2cBackupItems.configId',
  },
  c2cBackupJobs: {
    id: 'c2cBackupJobs.id',
    orgId: 'c2cBackupJobs.orgId',
    configId: 'c2cBackupJobs.configId',
    status: 'c2cBackupJobs.status',
  },
  c2cConnections: {
    id: 'c2cConnections.id',
    orgId: 'c2cConnections.orgId',
  },
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('./c2cEnqueue', () => ({
  closeC2cQueue: vi.fn(),
  enqueueC2cSync: vi.fn(),
  getC2cQueue: vi.fn(),
}));

vi.mock('../services/c2cJobCreation', () => ({
  createC2cSyncJobIfIdle: vi.fn(),
}));

vi.mock('../services/c2cQueuedAuthorization', () => ({
  authorizeAndFinalizeC2cQueuedWork: (...args: unknown[]) => shared.processC2cMock(...args),
}));

import { db } from '../db';
import { createC2cWorker, processC2cQueuedJob } from './c2cBackupWorker';
import { createC2cSyncJobIfIdle } from '../services/c2cJobCreation';
import { enqueueC2cSync } from './c2cEnqueue';

function createSelectLimitChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function createSelectWhereChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function createUpdateChain(returnedRows: any[] = []) {
  const chain: any = {};
  chain.set = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(returnedRows));
  return chain;
}

describe('c2c backup worker queue validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shared.processorRef = undefined;
    shared.processC2cMock.mockResolvedValue({ synced: false });
  });

  it('exports a direct subject-free C2C processor seam and delegates the exact queue envelope', async () => {
    const data = {
      type: 'run-sync' as const,
      jobId: 'job-1',
      configId: 'config-1',
      orgId: 'org-1',
    };

    await expect(processC2cQueuedJob(data)).resolves.toEqual({ synced: false });
    expect(shared.processC2cMock).toHaveBeenCalledWith(data, undefined);
  });

  it('classifies scheduled sync with the private c2c-sync-scheduler subject', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T12:01:00.000Z'));
    vi.mocked(db.select).mockImplementationOnce(() => createSelectWhereChain([{
      id: 'config-1',
      orgId: 'org-1',
      isActive: true,
      schedule: { frequency: 'hourly' },
    }]) as any);
    vi.mocked(createC2cSyncJobIfIdle).mockResolvedValue({
      job: { id: 'job-1' } as any,
      created: true,
    });

    createC2cWorker();
    await shared.processorRef({ data: { type: 'check-schedules' } });

    expect(createC2cSyncJobIfIdle).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1',
      configId: 'config-1',
      auth: expect.objectContaining({
        principal: { kind: 'system', reason: 'c2c-sync-scheduler' },
      }),
    }));
    expect(enqueueC2cSync).toHaveBeenCalledWith('job-1', 'config-1', 'org-1');
    vi.useRealTimers();
  });

  it.each([
    { type: 'run-sync', jobId: 'job-1', configId: 'config-1', orgId: 'org-1' },
    {
      type: 'process-restore',
      restoreJobId: 'job-1',
      orgId: 'org-1',
      itemIds: ['item-1'],
      targetConnectionId: null,
    },
  ])('passes $type work to the authorization processor unchanged', async (data) => {
    shared.processC2cMock.mockResolvedValueOnce(
      data.type === 'run-sync' ? { synced: false } : { restored: false },
    );
    createC2cWorker();

    await shared.processorRef({ data });

    expect(shared.processC2cMock).toHaveBeenCalledWith(data, undefined);
  });
});
