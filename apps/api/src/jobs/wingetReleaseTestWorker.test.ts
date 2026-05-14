import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('drizzle-orm', () => ({
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', strings: Array.from(strings), values }),
}));

vi.mock('../db/schema', () => ({
  thirdPartyReleaseTests: {
    id: 'rt.id',
    catalogId: 'rt.catalogId',
    version: 'rt.version',
    status: 'rt.status',
    startedAt: 'rt.startedAt',
    result: 'rt.result',
    log: 'rt.log',
    completedAt: 'rt.completedAt',
  },
  thirdPartyPackageCatalog: {
    id: 'cat.id',
    breezeTested: 'cat.breezeTested',
  },
}));

const mocks = vi.hoisted(() => {
  const state = {
    insertReturning: [] as Array<{ id: string }>,
  };
  const catalogRow = { id: 'cat-1', breezeTested: true };
  const updateChain = {
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(undefined),
    })),
  };
  const dbMock = {
    select: vi.fn(),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue(state.insertReturning),
        })),
      })),
    })),
    update: vi.fn(() => updateChain),
  };

  return { catalogRow, dbMock, state, updateChain };
});

vi.mock('../db', () => ({ db: mocks.dbMock }));

import { enqueueWingetReleaseTest, executeWingetReleaseTest } from './wingetReleaseTestWorker';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.insertReturning = [];
  mocks.dbMock.select.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([mocks.catalogRow]),
      })),
    })),
  }));
});

describe('enqueueWingetReleaseTest', () => {
  it('inserts and returns a fresh testId for breeze-tested catalog hit', async () => {
    mocks.state.insertReturning = [{ id: 'rt-fresh' }];
    const result = await enqueueWingetReleaseTest({ catalogId: 'cat-1', version: '1.0.0' });
    expect(result).toEqual({ testId: 'rt-fresh', alreadyExisted: false });
  });

  it('returns alreadyExisted when conflict triggers no insert', async () => {
    mocks.state.insertReturning = []; // ON CONFLICT DO NOTHING returns 0 rows
    mocks.dbMock.select
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([mocks.catalogRow]) })),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ id: 'rt-existing' }]) })),
        })),
      }));

    const result = await enqueueWingetReleaseTest({ catalogId: 'cat-1', version: '1.0.0' });
    expect(result).toEqual({ testId: 'rt-existing', alreadyExisted: true });
  });

  it('returns null when catalog entry is not breeze-tested', async () => {
    mocks.dbMock.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([{ id: 'cat-1', breezeTested: false }]),
        })),
      })),
    }));

    const result = await enqueueWingetReleaseTest({ catalogId: 'cat-1', version: '1.0.0' });
    expect(result).toEqual({ testId: null, alreadyExisted: false });
  });

  it('returns null when catalog entry not found', async () => {
    mocks.dbMock.select.mockImplementation(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    }));
    const result = await enqueueWingetReleaseTest({ catalogId: 'missing', version: '1.0.0' });
    expect(result).toEqual({ testId: null, alreadyExisted: false });
  });
});

describe('executeWingetReleaseTest stub', () => {
  it('transitions status running -> completed (skipped)', async () => {
    await executeWingetReleaseTest({ testId: 'rt-1' });
    expect(mocks.dbMock.update).toHaveBeenCalledTimes(2);
    expect(mocks.updateChain.set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ status: 'running' })
    );
    expect(mocks.updateChain.set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: 'completed', result: 'skipped' })
    );
  });
});
