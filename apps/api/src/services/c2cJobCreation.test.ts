import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    transaction: vi.fn(),
  },

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  c2cBackupJobs: {
    id: 'c2cBackupJobs.id',
    orgId: 'c2cBackupJobs.orgId',
    configId: 'c2cBackupJobs.configId',
    status: 'c2cBackupJobs.status',
    createdAt: 'c2cBackupJobs.createdAt',
    updatedAt: 'c2cBackupJobs.updatedAt',
  },
}));

import { db } from '../db';
import { createC2cSyncJobIfIdle } from './c2cJobCreation';

function buildTx(options?: {
  existingRows?: Array<{ id: string; orgId: string; configId: string; status: string }>;
  insertedRows?: Array<{ id: string; orgId: string; configId: string; status: string }>;
}) {
  const existingRows = options?.existingRows ?? [];
  const insertedRows = options?.insertedRows ?? [{
    id: 'job-1',
    orgId: 'org-1',
    configId: 'cfg-1',
    status: 'pending',
  }];

  return {
    execute: vi.fn().mockResolvedValue([]),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(existingRows),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(insertedRows),
      }),
    }),
  };
}

describe('c2c job creation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('creates a sync job when no active job exists for the config', async () => {
    const tx = buildTx();
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const result = await createC2cSyncJobIfIdle({
      orgId: 'org-1',
      configId: 'cfg-1',
    });

    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      job: expect.objectContaining({ id: 'job-1' }),
      created: true,
    });
  });

  it('returns the existing active sync job instead of creating a duplicate', async () => {
    const tx = buildTx({
      existingRows: [{
        id: 'job-existing',
        orgId: 'org-1',
        configId: 'cfg-1',
        status: 'running',
      }],
    });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const result = await createC2cSyncJobIfIdle({
      orgId: 'org-1',
      configId: 'cfg-1',
    });

    expect(tx.insert).not.toHaveBeenCalled();
    expect(result).toEqual({
      job: expect.objectContaining({ id: 'job-existing' }),
      created: false,
    });
  });
});
