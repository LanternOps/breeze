import { beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  processorRef: undefined as any,
  closeMock: vi.fn(),
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

import { db } from '../db';
import { createC2cWorker } from './c2cBackupWorker';

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
  });

  it('treats forged or replayed sync jobs as no-ops unless org/config/status match', async () => {
    vi.mocked(db.update).mockImplementationOnce(() => createUpdateChain([]) as any);

    createC2cWorker();
    const result = await shared.processorRef({
      data: {
        type: 'run-sync',
        jobId: 'job-1',
        configId: 'config-1',
        orgId: 'org-1',
      },
    });

    expect(result).toEqual({
      synced: false,
      skipped: true,
      reason: 'Job not pending for queued org/config',
    });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it('does not claim restore jobs when queued item IDs do not match the job org/config', async () => {
    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectLimitChain([{ id: 'job-1', configId: 'config-1' }]) as any)
      .mockImplementationOnce(() => createSelectWhereChain([{ count: 1 }]) as any);

    createC2cWorker();
    const result = await shared.processorRef({
      data: {
        type: 'process-restore',
        restoreJobId: 'job-1',
        orgId: 'org-1',
        itemIds: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
        targetConnectionId: null,
      },
    });

    expect(result).toEqual({
      restored: false,
      skipped: true,
      reason: 'Queued restore items do not match restore job org/config',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('claims restore jobs by pending org and writes processed count from validated unique items', async () => {
    const claimUpdate = createUpdateChain([{ id: 'job-1' }]);
    const finalUpdate = createUpdateChain();

    vi.mocked(db.select)
      .mockImplementationOnce(() => createSelectLimitChain([{ id: 'job-1', configId: 'config-1' }]) as any)
      .mockImplementationOnce(() => createSelectWhereChain([{ count: 2 }]) as any);
    vi.mocked(db.update)
      .mockImplementationOnce(() => claimUpdate as any)
      .mockImplementationOnce(() => finalUpdate as any);

    createC2cWorker();
    const result = await shared.processorRef({
      data: {
        type: 'process-restore',
        restoreJobId: 'job-1',
        orgId: 'org-1',
        itemIds: [
          '11111111-1111-1111-1111-111111111111',
          '11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
        ],
        targetConnectionId: null,
      },
    });

    expect(result).toEqual({ restored: false });
    expect(claimUpdate.returning).toHaveBeenCalledWith({ id: 'c2cBackupJobs.id' });
    expect(claimUpdate.where).toHaveBeenCalledWith({
      op: 'and',
      conditions: [
        { op: 'eq', left: 'c2cBackupJobs.id', right: 'job-1' },
        { op: 'eq', left: 'c2cBackupJobs.orgId', right: 'org-1' },
        { op: 'eq', left: 'c2cBackupJobs.configId', right: 'config-1' },
        { op: 'eq', left: 'c2cBackupJobs.status', right: 'pending' },
      ],
    });
    expect(finalUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ itemsProcessed: 2 }));
    expect(finalUpdate.where).toHaveBeenCalledWith({
      op: 'and',
      conditions: [
        { op: 'eq', left: 'c2cBackupJobs.id', right: 'job-1' },
        { op: 'eq', left: 'c2cBackupJobs.orgId', right: 'org-1' },
        { op: 'eq', left: 'c2cBackupJobs.configId', right: 'config-1' },
        { op: 'eq', left: 'c2cBackupJobs.status', right: 'running' },
      ],
    });
  });

  it('finishes sync jobs only through the claimed org/config/running row', async () => {
    const claimUpdate = createUpdateChain([{ id: 'job-1' }]);
    const finalUpdate = createUpdateChain();

    vi.mocked(db.update)
      .mockImplementationOnce(() => claimUpdate as any)
      .mockImplementationOnce(() => finalUpdate as any);

    createC2cWorker();
    const result = await shared.processorRef({
      data: {
        type: 'run-sync',
        jobId: 'job-1',
        configId: 'config-1',
        orgId: 'org-1',
      },
    });

    expect(result).toEqual({ synced: false });
    expect(finalUpdate.where).toHaveBeenCalledWith({
      op: 'and',
      conditions: [
        { op: 'eq', left: 'c2cBackupJobs.id', right: 'job-1' },
        { op: 'eq', left: 'c2cBackupJobs.orgId', right: 'org-1' },
        { op: 'eq', left: 'c2cBackupJobs.configId', right: 'config-1' },
        { op: 'eq', left: 'c2cBackupJobs.status', right: 'running' },
      ],
    });
  });
});
