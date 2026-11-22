import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sets: [] as Record<string, unknown>[], wheres: [] as unknown[], returning: [] as unknown[][], savepoints: 0, throwOnUpdate: false, hasContext: true }));
vi.mock('../../db', () => {
  const update = vi.fn(() => ({
    set: (s: Record<string, unknown>) => {
      h.sets.push(s);
      return { where: (w: unknown) => { h.wheres.push(w); return { returning: async () => { if (h.throwOnUpdate) throw new Error('boom'); return h.returning.shift() ?? []; } }; } };
    },
  }));
  return {
    db: { update },
    hasDbAccessContext: () => h.hasContext,
    withDbTransaction: async (fn: () => unknown) => { h.savepoints += 1; return fn(); },
  };
});

const captureExceptionMock = vi.hoisted(() => vi.fn());
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { advanceOutcomesForTerminalExecution, terminalVerdict } from './scriptTerminalHook';

const dialect = new PgDialect();
const whereSql = (i: number) => dialect.sqlToQuery(h.wheres[i] as SQL);

describe('terminalVerdict', () => {
  it.each([
    ['completed', 'awaiting_recovery', 'script_succeeded'],
    ['failed', 'failed', 'script_failed'],
    ['timeout', 'failed', 'script_timeout'],
    ['cancelled', 'cancelled', 'script_cancelled'],
  ] as const)('%s → %s', (status, state, reason) => {
    expect(terminalVerdict(status)).toEqual({ state, reason });
  });
  it.each(['failed', 'timeout'] as const)('%s that was never delivered → inconclusive (never evidence about the fix)', (status) => {
    expect(terminalVerdict(status, { neverDelivered: true })).toEqual({ state: 'inconclusive', reason: 'script_never_delivered' });
  });
  it('neverDelivered does not change a completed or cancelled verdict', () => {
    expect(terminalVerdict('completed', { neverDelivered: true })).toEqual({ state: 'awaiting_recovery', reason: 'script_succeeded' });
    expect(terminalVerdict('cancelled', { neverDelivered: true })).toEqual({ state: 'cancelled', reason: 'script_cancelled' });
  });
});

describe('advanceOutcomesForTerminalExecution', () => {
  beforeEach(() => { h.sets.length = 0; h.wheres.length = 0; h.returning.length = 0; h.savepoints = 0; h.throwOnUpdate = false; h.hasContext = true; });

  it('a successful run moves pending → awaiting_recovery with a 24h recovery deadline, inside a savepoint', async () => {
    h.returning.push([{ id: 'o-1' }]);
    await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'completed' })).resolves.toBe(1);
    expect(h.sets[0]).toMatchObject({ state: 'awaiting_recovery', stateReason: 'script_succeeded' });
    expect(h.sets[0]).not.toHaveProperty('countedAt');
    expect(((h.sets[0]!.deadlineAt as Date).getTime() - Date.now()) / 3_600_000).toBeGreaterThan(23.9);
    expect(h.savepoints).toBe(1);
  });

  it('dates the recovery deadline from the script completion time the caller passes (#7279)', async () => {
    h.returning.push([{ id: 'o-1' }]);
    const completedAt = new Date(Date.now() - 2 * 3_600_000);
    await advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'completed', completedAt });
    expect((h.sets[0]!.deadlineAt as Date).getTime()).toBe(completedAt.getTime() + 24 * 3_600_000);
  });

  it('an on-time result never touches an attempt that is already terminal (one write, the pending CAS)', async () => {
    await advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'completed' });
    expect(h.sets).toHaveLength(1);
  });

  describe('a late result recovered onto a swept execution (#7279)', () => {
    it('a real success re-opens an attempt the sweep failed or called undelivered, uncounted, with a recount request', async () => {
      h.returning.push([], [{ id: 'o-1' }]);
      const completedAt = new Date(Date.now() - 60_000);
      await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'completed', completedAt, lateResult: true })).resolves.toBe(1);
      expect(h.sets).toHaveLength(2);
      expect(h.sets[1]).toMatchObject({
        state: 'awaiting_recovery', stateReason: 'script_succeeded_late', terminalAt: null, countedAt: null,
        deadlineAt: new Date(completedAt.getTime() + 24 * 3_600_000),
      });
      expect(h.sets[1]!.recountRequestedAt).toBeInstanceOf(Date);
      const q = whereSql(1);
      expect(q.sql).toContain('"state" in');
      expect(q.sql).toContain('"state_reason" in');
      expect(q.sql).toContain('"counted_at" is not null');
      expect(q.params).toEqual(expect.arrayContaining(['e-1', 'failed', 'inconclusive', 'script_failed', 'script_timeout', 'script_never_delivered']));
      expect(h.savepoints).toBe(1); // both writes in the one savepoint
    });

    it('a real failure only turns an undelivered (inconclusive) attempt into a counted failure', async () => {
      h.returning.push([], [{ id: 'o-1' }]);
      await advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'failed', lateResult: true });
      expect(h.sets[1]).toMatchObject({ state: 'failed', stateReason: 'script_failed' });
      expect(h.sets[1]).not.toHaveProperty('countedAt'); // already counted: the CAS requires it
      expect(h.sets[1]!.recountRequestedAt).toBeInstanceOf(Date);
      const q = whereSql(1);
      expect(q.params).toEqual(expect.arrayContaining(['e-1', 'inconclusive', 'script_never_delivered']));
      expect(q.params).not.toContain('failed');
    });

    it('a failed reconcile is reported (no sweeper retry exists for it), never thrown', async () => {
      h.throwOnUpdate = true;
      captureExceptionMock.mockClear();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'completed', lateResult: true })).resolves.toBe(0);
      expect(err.mock.calls[0]![0]).toContain('keeps the sweep');
      err.mockRestore();
      expect(captureExceptionMock).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ phase: 'late_result_reconcile', executionId: 'e-1' }));
    });

    it('a cancelled late result reconciles nothing', async () => {
      await advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'cancelled', lateResult: true });
      expect(h.sets).toHaveLength(1);
    });
  });

  it('a failed run is terminal + counted and requests a deferred aggregate recount (no fix_memory write here)', async () => {
    h.returning.push([{ id: 'o-1' }]);
    await advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'timeout' });
    expect(h.sets[0]).toMatchObject({ state: 'failed', stateReason: 'script_timeout' });
    expect(h.sets[0]!.terminalAt).toBeInstanceOf(Date);
    expect(h.sets[0]!.countedAt).toBeInstanceOf(Date);
    expect(h.sets[0]!.recountRequestedAt).toBeInstanceOf(Date);
  });

  it('an execution whose command expired undelivered is terminal + counted as inconclusive, not failed', async () => {
    h.returning.push([{ id: 'o-1' }]);
    await advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'failed', neverDelivered: true });
    expect(h.sets[0]).toMatchObject({ state: 'inconclusive', stateReason: 'script_never_delivered' });
    expect(h.sets[0]!.countedAt).toBeInstanceOf(Date);
    expect(h.sets[0]!.recountRequestedAt).toBeInstanceOf(Date);
  });

  it('with no ambient DB context writes on the bare db directly, with no savepoint (contextless branch)', async () => {
    h.hasContext = false;
    h.returning.push([{ id: 'o-1' }]);
    await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'completed' })).resolves.toBe(1);
    expect(h.sets[0]).toMatchObject({ state: 'awaiting_recovery' });
    expect(h.savepoints).toBe(0);
  });

  it('contextless branch also swallows a failed update', async () => {
    h.hasContext = false;
    h.throwOnUpdate = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'failed' })).resolves.toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('a cancelled run is terminal + counted with a deferred recount and no recovery deadline (non-awaiting branch)', async () => {
    h.returning.push([{ id: 'o-1' }]);
    await advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'cancelled' });
    expect(h.sets[0]).toMatchObject({ state: 'cancelled', stateReason: 'script_cancelled' });
    expect(h.sets[0]).not.toHaveProperty('deadlineAt');
    expect(h.sets[0]!.terminalAt).toBeInstanceOf(Date);
    expect(h.sets[0]!.countedAt).toBeInstanceOf(Date);
    expect(h.sets[0]!.recountRequestedAt).toBeInstanceOf(Date);
  });

  it('never throws: a failed update is logged and reported as 0 (ingestion is the durable record)', async () => {
    h.throwOnUpdate = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'failed' })).resolves.toBe(0);
    err.mockRestore();
  });

  /** A caller's open transaction: `transaction(fn)` is Drizzle's nested transaction (a SAVEPOINT) and hands `fn` the savepoint handle. */
  function callerTx(savepointUpdate: () => Promise<unknown[]>) {
    const savepoint = { update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: savepointUpdate }) }) })) };
    const tx = {
      update: vi.fn(() => { throw new Error('the hook must never write on the caller’s transaction directly'); }),
      transaction: vi.fn(async (fn: (sp: unknown) => Promise<unknown>) => fn(savepoint)),
    };
    return { tx, savepoint };
  }

  it('uses a caller-supplied executor (cancel propagation’s transaction), inside a savepoint on it', async () => {
    const { tx, savepoint } = callerTx(async () => [{ id: 'o-9' }]);
    await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'cancelled' }, tx as never)).resolves.toBe(1);
    expect(tx.transaction).toHaveBeenCalledTimes(1);
    expect(savepoint.update).toHaveBeenCalledTimes(1);
    expect(tx.update).not.toHaveBeenCalled();
    expect(h.savepoints).toBe(0); // the ambient-db path was not used
  });

  it('a SQL failure on a caller-supplied executor is confined to the savepoint and swallowed: the caller never sees a rejection', async () => {
    // commandCancelPropagation.ts:90-97 passes its open tx through finalizeScriptExecutionTerminal.
    // A bare write there would leave that tx aborted (25P02) even though the JS error was caught.
    const { tx, savepoint } = callerTx(async () => { throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'failed' }, tx as never)).resolves.toBe(0);
    err.mockRestore();
    expect(tx.transaction).toHaveBeenCalledTimes(1); // the failing statement ran on the savepoint handle...
    expect(savepoint.update).toHaveBeenCalledTimes(1);
    expect(tx.update).not.toHaveBeenCalled(); // ...never on the caller's transaction
  });
});
