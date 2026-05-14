import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    insertReturning: [] as Array<{ id: string }>,
    selectRows: [] as unknown[][],
    updateSetCalls: [] as Array<{ table: unknown; value: Record<string, unknown> }>,
    runResult: { result: 'pass' as const, notes: 'ok', log: 'demo log' },
  };
  const catalogRow = { id: 'cat-1', breezeTested: true };
  const dbMock = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockImplementation(() => Promise.resolve(state.selectRows.shift() ?? [])),
        })),
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockImplementation(() => Promise.resolve(state.selectRows.shift() ?? [])),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue(state.insertReturning),
        })),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: Record<string, unknown>) => {
        state.updateSetCalls.push({ table, value });
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
  };
  const runWingetReleaseTest = vi.fn(() => Promise.resolve(state.runResult));

  return { catalogRow, dbMock, runWingetReleaseTest, state };
});

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
    packageId: 'cat.packageId',
    breezeTested: 'cat.breezeTested',
    lastTestedAt: 'cat.lastTestedAt',
    lastTestedVersion: 'cat.lastTestedVersion',
    lastTestedResult: 'cat.lastTestedResult',
  },
}));

vi.mock('../db', () => ({ db: mocks.dbMock }));
vi.mock('../services/aiPatchTestRunner', () => ({
  runWingetReleaseTest: mocks.runWingetReleaseTest,
}));

import { enqueueWingetReleaseTest, executeWingetReleaseTest } from './wingetReleaseTestWorker';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.insertReturning = [];
  mocks.state.selectRows = [[mocks.catalogRow]];
  mocks.state.updateSetCalls = [];
  mocks.state.runResult = { result: 'pass', notes: 'ok', log: 'demo log' };
});

describe('enqueueWingetReleaseTest', () => {
  it('inserts and returns a fresh testId for breeze-tested catalog hit', async () => {
    mocks.state.insertReturning = [{ id: 'rt-fresh' }];
    const result = await enqueueWingetReleaseTest({ catalogId: 'cat-1', version: '1.0.0' });
    expect(result).toEqual({ testId: 'rt-fresh', alreadyExisted: false });
  });

  it('returns alreadyExisted when conflict triggers no insert', async () => {
    mocks.state.insertReturning = []; // ON CONFLICT DO NOTHING returns 0 rows
    mocks.state.selectRows = [[mocks.catalogRow], [{ id: 'rt-existing' }]];

    const result = await enqueueWingetReleaseTest({ catalogId: 'cat-1', version: '1.0.0' });
    expect(result).toEqual({ testId: 'rt-existing', alreadyExisted: true });
  });

  it('returns null when catalog entry is not breeze-tested', async () => {
    mocks.state.selectRows = [[{ id: 'cat-1', breezeTested: false }]];

    const result = await enqueueWingetReleaseTest({ catalogId: 'cat-1', version: '1.0.0' });
    expect(result).toEqual({ testId: null, alreadyExisted: false });
  });

  it('returns null when catalog entry not found', async () => {
    mocks.state.selectRows = [[]];
    const result = await enqueueWingetReleaseTest({ catalogId: 'missing', version: '1.0.0' });
    expect(result).toEqual({ testId: null, alreadyExisted: false });
  });
});

describe('executeWingetReleaseTest', () => {
  it('runs the AI test and persists release test plus catalog verdict fields', async () => {
    mocks.state.selectRows = [[{
      id: 'rt-1',
      catalogId: 'cat-1',
      version: '121.0',
      packageId: 'Mozilla.Firefox',
    }]];

    await executeWingetReleaseTest({ testId: 'rt-1' });

    expect(mocks.runWingetReleaseTest).toHaveBeenCalledWith({
      packageId: 'Mozilla.Firefox',
      version: '121.0',
    });
    expect(mocks.dbMock.update).toHaveBeenCalledTimes(3);
    expect(mocks.state.updateSetCalls[0].value).toEqual(
      expect.objectContaining({ status: 'running', startedAt: expect.any(Date) })
    );
    expect(mocks.state.updateSetCalls[1].value).toEqual(
      expect.objectContaining({
        status: 'completed',
        result: 'pass',
        log: 'ok\n\ndemo log',
        completedAt: expect.any(Date),
      })
    );
    expect(mocks.state.updateSetCalls[2].value).toEqual(
      expect.objectContaining({
        lastTestedAt: expect.any(Date),
        lastTestedVersion: '121.0',
        lastTestedResult: 'pass',
      })
    );
  });

  it('marks the row inconclusive and rethrows when the inner runner crashes after status flips to running', async () => {
    mocks.state.selectRows = [[{
      id: 'rt-crash',
      catalogId: 'cat-1',
      version: '2.0.0',
      packageId: 'Some.Pkg',
    }]];
    // Simulate a non-throwing inner runner being replaced by a hard throw
    // (i.e. an error path that the inner try/catch does NOT cover, such as
    // a DB write failure on the 'running' update). We simulate that by
    // making runWingetReleaseTest reject AND the inner catch's follow-up
    // 'completed' update succeed — but for THIS test we want the outer
    // safety net specifically. Throw from the runner with a sentinel that
    // bypasses the inner catch by patching the mock to throw a non-Error.
    // Easiest: make the runner throw, and the inner catch will normalise
    // it. To exercise the OUTER catch, make the SECOND db.update (the
    // 'completed' one) throw. We do that by stubbing the update fn to
    // throw on its second call.
    mocks.dbMock.update.mockImplementationOnce((table: unknown) => ({
      set: vi.fn((value: Record<string, unknown>) => {
        mocks.state.updateSetCalls.push({ table, value });
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
    mocks.dbMock.update.mockImplementationOnce(() => ({
      set: vi.fn(() => {
        throw new Error('db connection lost');
      }),
    }));
    // Recovery update inside the outer catch — must succeed so the row
    // ends up marked inconclusive.
    mocks.dbMock.update.mockImplementationOnce((table: unknown) => ({
      set: vi.fn((value: Record<string, unknown>) => {
        mocks.state.updateSetCalls.push({ table, value });
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    }));
    // Suppress noisy console.error in this expected-failure path.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(executeWingetReleaseTest({ testId: 'rt-crash' })).rejects.toThrow(
      'db connection lost'
    );

    // The recovery update should have been called with status=completed,
    // result=inconclusive, and the crash message in `log`.
    const recovery = mocks.state.updateSetCalls.find(
      (c) => (c.value as Record<string, unknown>).result === 'inconclusive'
    );
    expect(recovery).toBeDefined();
    expect(recovery!.value).toEqual(
      expect.objectContaining({
        status: 'completed',
        result: 'inconclusive',
        log: expect.stringContaining('worker crashed: db connection lost'),
        completedAt: expect.any(Date),
      })
    );

    errSpy.mockRestore();
  });
});
