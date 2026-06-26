import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// runBulkIsolated wraps each item in withDbAccessContext + runOutsideDbContext.
// Stub both as passthrough spies so the loop runs without a real DB and we can
// assert the per-item isolation wiring. Implementations are (re)set per test in
// beforeEach so the afterEach restoreAllMocks (which clears the console spy in
// the failure test) can't strip them.
const withDbAccessContext = vi.fn();
const runOutsideDbContext = vi.fn();
vi.mock('../db', () => ({
  withDbAccessContext: (ctx: unknown, fn: () => unknown) => withDbAccessContext(ctx, fn),
  runOutsideDbContext: (fn: () => unknown) => runOutsideDbContext(fn),
}));

import { runBulk, runBulkIsolated } from './bulkOps';

class SvcError extends Error {
  constructor(msg: string, public status: number, public code?: string) { super(msg); }
}

beforeEach(() => {
  vi.clearAllMocks();
  withDbAccessContext.mockImplementation((_ctx: unknown, fn: () => unknown) => fn());
  runOutsideDbContext.mockImplementation((fn: () => unknown) => fn());
});
afterEach(() => vi.restoreAllMocks());

describe('runBulk', () => {
  it('counts successes', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const r = await runBulk(['a', 'b', 'c'], fn);
    expect(r).toMatchObject({ total: 3, succeeded: 3, skipped: 0, failed: 0 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('treats 4xx service errors as skipped and tallies reasons by code', async () => {
    const fn = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SvcError('not a draft', 409, 'NOT_A_DRAFT'))
      .mockRejectedValueOnce(new SvcError('denied', 403, 'ORG_DENIED'));
    const r = await runBulk(['a', 'b', 'c'], fn);
    expect(r).toMatchObject({ total: 3, succeeded: 1, skipped: 2, failed: 0 });
    expect(r.skippedReasons).toEqual({ NOT_A_DRAFT: 1, ORG_DENIED: 1 });
  });

  it('treats unexpected errors as failed without throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const r = await runBulk(['a'], fn);
    expect(r).toMatchObject({ total: 1, succeeded: 0, skipped: 0, failed: 1 });
  });
});

describe('runBulkIsolated', () => {
  const ctx = { scope: 'partner', orgId: null, accessibleOrgIds: ['o1'] } as never;

  it('runs the loop outside the ambient context and each item in its own access context', async () => {
    const perItem = vi.fn().mockResolvedValue(undefined);
    const r = await runBulkIsolated(ctx, ['a', 'b', 'c'], perItem);

    expect(r).toMatchObject({ total: 3, succeeded: 3, skipped: 0, failed: 0 });
    // whole loop wrapped once in runOutsideDbContext (releases the request txn)
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    // each item re-enters the caller's exact context in its own transaction
    expect(withDbAccessContext).toHaveBeenCalledTimes(3);
    expect(withDbAccessContext).toHaveBeenCalledWith(ctx, expect.any(Function));
    expect(perItem).toHaveBeenCalledTimes(3);
  });

  it('isolates a per-item failure without aborting siblings (accurate counts)', async () => {
    const perItem = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new SvcError('not a draft', 409, 'NOT_A_DRAFT'))
      .mockResolvedValueOnce(undefined);
    const r = await runBulkIsolated(ctx, ['a', 'b', 'c'], perItem);

    // 'b' failing does not prevent 'c' from running and succeeding
    expect(r).toMatchObject({ total: 3, succeeded: 2, skipped: 1, failed: 0 });
    expect(r.skippedReasons).toEqual({ NOT_A_DRAFT: 1 });
    expect(withDbAccessContext).toHaveBeenCalledTimes(3);
  });
});
