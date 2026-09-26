import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sets: [] as Record<string, unknown>[], returning: [] as unknown[][], savepoints: 0, throwOnUpdate: false }));
vi.mock('../../db', () => {
  const update = vi.fn(() => ({
    set: (s: Record<string, unknown>) => {
      h.sets.push(s);
      return { where: () => ({ returning: async () => { if (h.throwOnUpdate) throw new Error('boom'); return h.returning.shift() ?? []; } }) };
    },
  }));
  return {
    db: { update },
    hasDbAccessContext: () => true,
    withDbTransaction: async (fn: () => unknown) => { h.savepoints += 1; return fn(); },
  };
});

import { advanceOutcomesForTerminalExecution, terminalVerdict } from './scriptTerminalHook';

describe('terminalVerdict', () => {
  it.each([
    ['completed', 'awaiting_recovery', 'script_succeeded'],
    ['failed', 'failed', 'script_failed'],
    ['timeout', 'failed', 'script_timeout'],
    ['cancelled', 'cancelled', 'script_cancelled'],
  ] as const)('%s → %s', (status, state, reason) => {
    expect(terminalVerdict(status)).toEqual({ state, reason });
  });
});

describe('advanceOutcomesForTerminalExecution', () => {
  beforeEach(() => { h.sets.length = 0; h.returning.length = 0; h.savepoints = 0; h.throwOnUpdate = false; });

  it('a successful run moves pending → awaiting_recovery with a 24h recovery deadline, inside a savepoint', async () => {
    h.returning.push([{ id: 'o-1' }]);
    await expect(advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'completed' })).resolves.toBe(1);
    expect(h.sets[0]).toMatchObject({ state: 'awaiting_recovery', stateReason: 'script_succeeded' });
    expect(h.sets[0]).not.toHaveProperty('countedAt');
    expect(((h.sets[0]!.deadlineAt as Date).getTime() - Date.now()) / 3_600_000).toBeGreaterThan(23.9);
    expect(h.savepoints).toBe(1);
  });

  it('a failed run is terminal + counted and requests a deferred aggregate recount (no fix_memory write here)', async () => {
    h.returning.push([{ id: 'o-1' }]);
    await advanceOutcomesForTerminalExecution({ executionId: 'e-1', status: 'timeout' });
    expect(h.sets[0]).toMatchObject({ state: 'failed', stateReason: 'script_timeout' });
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

  it('uses a caller-supplied executor (the reaper’s / cancel propagation’s transaction), inside a savepoint on it', async () => {
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
