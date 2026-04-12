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
  discoveryJobs: {
    profileId: 'discoveryJobs.profileId',
    status: 'discoveryJobs.status',
  },
}));

import { db } from '../db';
import { createDiscoveryJobIfIdle } from './discoveryJobCreation';

function buildTx(options?: {
  existingRows?: Array<{ id: string; profileId: string; orgId: string; siteId: string; status: string }>;
  insertedRows?: Array<{ id: string; profileId: string; orgId: string; siteId: string; status: string }>;
}) {
  const existingRows = options?.existingRows ?? [];
  const insertedRows = options?.insertedRows ?? [{
    id: 'job-1',
    profileId: 'profile-1',
    orgId: 'org-1',
    siteId: 'site-1',
    status: 'scheduled',
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

describe('discovery job creation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('creates a discovery job when no active job exists for the profile', async () => {
    const tx = buildTx();
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const result = await createDiscoveryJobIfIdle({
      profileId: 'profile-1',
      orgId: 'org-1',
      siteId: 'site-1',
    });

    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      job: expect.objectContaining({ id: 'job-1' }),
      created: true,
    });
  });

  it('returns the existing active discovery job instead of creating a duplicate', async () => {
    const tx = buildTx({
      existingRows: [{
        id: 'job-existing',
        profileId: 'profile-1',
        orgId: 'org-1',
        siteId: 'site-1',
        status: 'running',
      }],
    });
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    const result = await createDiscoveryJobIfIdle({
      profileId: 'profile-1',
      orgId: 'org-1',
      siteId: 'site-1',
    });

    expect(tx.insert).not.toHaveBeenCalled();
    expect(result).toEqual({
      job: expect.objectContaining({ id: 'job-existing' }),
      created: false,
    });
  });
});
