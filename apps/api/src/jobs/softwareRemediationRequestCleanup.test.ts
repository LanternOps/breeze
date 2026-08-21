import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #3614 follow-up 1: #3585 minted up to 500 authorization rows per Remediate
// click and nothing ever pruned them.
const selectMock = vi.fn();
const deleteMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...a: unknown[]) => selectMock(...(a as [])),
    delete: (...a: unknown[]) => deleteMock(...(a as [])),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('bullmq', () => ({ Queue: vi.fn(), Worker: vi.fn(), Job: vi.fn() }));

import { pruneExpiredRemediationRequests, __testOnly } from './softwareRemediationRequestCleanup';

// The mocks capture the predicate so the DELETE can be shown to re-apply the
// cutoff rather than trusting the id list alone.
//
// SCOPE, stated honestly because the previous version of this comment overclaimed:
// `columnsIn` returns column NAMES only. It cannot see the operator or the bound
// value, so it does NOT catch an inverted comparison (`lt` -> `gt`), which is the
// mutation that would delete every UNEXPIRED authorization. That case is covered
// against a real database in
// __tests__/integration/softwareRemediationRequestsRls.integration.test.ts —
// a query-shape assertion cannot express it, because the failure is a row count.
const capturedSelectWhere: unknown[] = [];
const capturedDeleteWhere: unknown[] = [];

/** select().from().where().limit() -> rows */
function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn((pred: unknown) => {
        capturedSelectWhere.push(pred);
        return { limit: vi.fn().mockResolvedValue(rows) };
      }),
    }),
  };
}
/** delete().where().returning() -> rows */
function deleteChain(rows: unknown[]) {
  return {
    where: vi.fn((pred: unknown) => {
      capturedDeleteWhere.push(pred);
      return { returning: vi.fn().mockResolvedValue(rows) };
    }),
  };
}

/** Walk a Drizzle SQL predicate's queryChunks and collect the column names it
 *  references. Enough to assert WHICH column was filtered on without a live
 *  database, and it cannot be satisfied by a predicate on the wrong column. */
function columnsIn(pred: unknown, seen = new Set<unknown>()): string[] {
  if (!pred || typeof pred !== 'object' || seen.has(pred)) return [];
  seen.add(pred);
  const node = pred as Record<string, unknown>;
  // A Drizzle Column carries its SQL name and its owning table.
  if (typeof node.name === 'string' && 'table' in node) return [node.name];
  const chunks = node.queryChunks;
  if (Array.isArray(chunks)) return chunks.flatMap((c) => columnsIn(c, seen));
  return [];
}

describe('softwareRemediationRequestCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedSelectWhere.length = 0;
    capturedDeleteWhere.length = 0;
    delete process.env.SOFTWARE_REMEDIATION_REQUEST_RETENTION_HOURS;
    delete process.env.SOFTWARE_REMEDIATION_REQUEST_CLEANUP_ENABLED;
  });
  afterEach(() => {
    delete process.env.SOFTWARE_REMEDIATION_REQUEST_RETENTION_HOURS;
    delete process.env.SOFTWARE_REMEDIATION_REQUEST_CLEANUP_ENABLED;
  });

  it('deletes rows past the retention cutoff', async () => {
    selectMock.mockReturnValueOnce(selectChain([{ id: 'r1' }, { id: 'r2' }]) as never);
    deleteMock.mockReturnValueOnce(deleteChain([{ id: 'r1' }, { id: 'r2' }]) as never);

    const result = await pruneExpiredRemediationRequests();

    expect(result.deletedCount).toBe(2);
    expect(result.batches).toBe(1);
    expect(deleteMock).toHaveBeenCalledTimes(1);

    // The SELECT filters on expires_at, not created_at or consumed_at.
    expect(columnsIn(capturedSelectWhere[0])).toEqual(['expires_at']);
    // The DELETE re-applies the SAME expiry cutoff, not just the id list. That
    // is the race guard: without it a row that stopped being eligible between
    // the SELECT and the DELETE would still be removed by id alone.
    // (Direction of the comparison is covered by the integration test, not here.)
    const del = columnsIn(capturedDeleteWhere[0]);
    expect(del).toContain('id');
    expect(del).toContain('expires_at');
  });

  it('is a no-op when nothing has expired (idempotent re-run)', async () => {
    selectMock.mockReturnValueOnce(selectChain([]) as never);

    const result = await pruneExpiredRemediationRequests();

    expect(result.deletedCount).toBe(0);
    expect(result.batches).toBe(0);
    // Never opens a DELETE it does not need.
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('keeps batching while a full batch comes back, then stops on a short one', async () => {
    const full = Array.from({ length: __testOnly.BATCH_SIZE }, (_, i) => ({ id: `f${i}` }));
    selectMock
      .mockReturnValueOnce(selectChain(full) as never)
      .mockReturnValueOnce(selectChain([{ id: 'tail' }]) as never);
    deleteMock
      .mockReturnValueOnce(deleteChain(full) as never)
      .mockReturnValueOnce(deleteChain([{ id: 'tail' }]) as never);

    const result = await pruneExpiredRemediationRequests();

    expect(result.batches).toBe(2);
    expect(result.deletedCount).toBe(__testOnly.BATCH_SIZE + 1);
    // The short second batch ends the loop — no guaranteed-empty third query.
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('stops at the batch cap instead of looping forever under sustained inserts', async () => {
    // Every batch comes back full, as it would if eligible rows were being
    // inserted as fast as they are deleted. The sweep must bound itself and
    // leave the remainder for the next hourly run rather than spin.
    const full = Array.from({ length: __testOnly.BATCH_SIZE }, (_, i) => ({ id: `f${i}` }));
    selectMock.mockReturnValue(selectChain(full) as never);
    deleteMock.mockReturnValue(deleteChain(full) as never);

    const result = await pruneExpiredRemediationRequests();

    expect(result.batches).toBe(__testOnly.MAX_BATCHES);
    // Confirmed, not assumed: on hitting the cap the sweep probes once more for
    // a still-eligible row before claiming a backlog, so a run that happened to
    // drain the table on its last batch does not report one.
    expect(result.hasMore).toBe(true);
    expect(selectMock).toHaveBeenCalledTimes(__testOnly.MAX_BATCHES + 1);
  });

  it('honors a retention override and falls back on a nonsense value', () => {
    process.env.SOFTWARE_REMEDIATION_REQUEST_RETENTION_HOURS = '6';
    expect(__testOnly.getRetentionHours()).toBe(6);

    process.env.SOFTWARE_REMEDIATION_REQUEST_RETENTION_HOURS = 'not-a-number';
    expect(__testOnly.getRetentionHours()).toBe(__testOnly.DEFAULT_RETENTION_HOURS);

    process.env.SOFTWARE_REMEDIATION_REQUEST_RETENTION_HOURS = '0';
    expect(__testOnly.getRetentionHours()).toBe(__testOnly.DEFAULT_RETENTION_HOURS);
  });

  it('can be disabled by env, and defaults to enabled', () => {
    expect(__testOnly.isCleanupEnabled()).toBe(true);
    for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
      process.env.SOFTWARE_REMEDIATION_REQUEST_CLEANUP_ENABLED = off;
      expect(__testOnly.isCleanupEnabled()).toBe(false);
    }
    process.env.SOFTWARE_REMEDIATION_REQUEST_CLEANUP_ENABLED = 'true';
    expect(__testOnly.isCleanupEnabled()).toBe(true);
  });
});
