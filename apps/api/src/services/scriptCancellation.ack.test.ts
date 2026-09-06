import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../db';
import { applyScriptCancelAck } from './scriptCancellation';

vi.mock('../db', () => ({
  db: { transaction: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const captureExceptionMock = vi.hoisted(() => vi.fn());
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

const dialect = new PgDialect();
const renderSql = (clause: unknown) => dialect.sqlToQuery(clause as SQL).sql;

type Row = {
  id: string;
  status: string;
  cancelPrevStatus: string | null;
};

let selectWhere: unknown;
let updateWhere: unknown;
let updatePatch: Record<string, unknown> | undefined;
let forUpdate: ReturnType<typeof vi.fn>;

/**
 * Stubs the one transaction `applyScriptCancelAck` opens: a locking SELECT of
 * the execution paired with the cancel command, then at most one UPDATE.
 * `row = null` models "another closer already resolved this execution".
 */
function withRow(row: Row | null) {
  forUpdate = vi.fn().mockResolvedValue(row ? [row] : []);
  const tx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn((clause: unknown) => {
          selectWhere = clause;
          return { limit: vi.fn().mockReturnValue({ for: forUpdate }) };
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn((patch: Record<string, unknown>) => {
        updatePatch = patch;
        return {
          where: vi.fn(async (clause: unknown) => {
            updateWhere = clause;
          }),
        };
      }),
    }),
  };
  vi.mocked(db.transaction).mockImplementation((async (fn: (t: unknown) => unknown) => fn(tx)) as never);
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectWhere = undefined;
  updateWhere = undefined;
  updatePatch = undefined;
});

/**
 * #3525 closer 2 of 5 — the agent's `script_cancel` ack. This is the ONLY
 * evidence that lets an execution terminalise as `cancelled`, so every branch
 * that is not a proven `terminated` must REVERT `status` to the value it held
 * when the cancel was requested and record why in `cancel_state` (OD8-C).
 */
describe('applyScriptCancelAck maps every agent outcome (OD8-C state table)', () => {
  it('outcome terminated → cancelled/confirmed, with a completion timestamp', async () => {
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: 'running' });

    await applyScriptCancelAck({ cancelCommandId: 'cc-1', result: { outcome: 'terminated' } });

    expect(updatePatch).toMatchObject({
      status: 'cancelled',
      cancelState: 'confirmed',
      errorMessage: 'Stopped on the device',
    });
    expect(updatePatch!.completedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['kill_failed', 'failed'],
    ['not_found', 'unconfirmed'],
  ] as const)('outcome %s → revert to cancel_prev_status, cancel_state %s', async (outcome, cancelState) => {
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: 'running' });

    await applyScriptCancelAck({ cancelCommandId: 'cc-1', result: { outcome } });

    expect(updatePatch).toMatchObject({ status: 'running', cancelState });
    // A failed cancel request does not change what happened to the process, so
    // the row must not acquire a completion time it has not earned.
    expect(updatePatch).not.toHaveProperty('completedAt');
  });

  it('reads the outcome out of the nested structured payload too', async () => {
    // tools.NewSuccessResult marshals its map into CommandResult.Result, so the
    // HTTP transport delivers `{ status, result: { … } }`.
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: 'queued' });

    await applyScriptCancelAck({
      cancelCommandId: 'cc-1',
      result: { status: 'completed', result: { outcome: 'terminated' } },
    });

    expect(updatePatch).toMatchObject({ status: 'cancelled', cancelState: 'confirmed' });
  });

  it('an unknown-command reply from an old agent is unconfirmed, never confirmed', async () => {
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: 'queued' });

    await applyScriptCancelAck({
      cancelCommandId: 'cc-1',
      result: { status: 'failed', error: 'unknown command type' },
    });

    expect(updatePatch).toMatchObject({ status: 'queued', cancelState: 'unconfirmed' });
  });

  it("a pre-#3525 agent's bare `cancelled: true` is NOT proof and stays unconfirmed", async () => {
    // The deployed agent's Cancel() is non-blocking: it signals and returns.
    // Only the W04 structured outcome proves the process actually died.
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: 'running' });

    await applyScriptCancelAck({
      cancelCommandId: 'cc-1',
      result: { status: 'completed', result: { executionId: 'cmd-1', cancelled: true } },
    });

    expect(updatePatch).toMatchObject({ status: 'running', cancelState: 'unconfirmed' });
  });

  it('a null result is unconfirmed rather than a crash or a confirmation', async () => {
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: 'pending' });

    await applyScriptCancelAck({ cancelCommandId: 'cc-1', result: null });

    expect(updatePatch).toMatchObject({ status: 'pending', cancelState: 'unconfirmed' });
  });

  it('a NULL cancel_prev_status still leaves cancelling — never stranded', async () => {
    // cancel_prev_status is written with the cancel, so NULL means a broken
    // writer. Falling back to `running` keeps the execution inside
    // reapStaleScriptExecutions' pending|queued|running predicate, which is what
    // guarantees something eventually closes it.
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: null });

    await applyScriptCancelAck({ cancelCommandId: 'cc-1', result: { outcome: 'not_found' } });

    expect(updatePatch).toMatchObject({ status: 'running', cancelState: 'unconfirmed' });
  });

  it('reports the NULL cancel_prev_status rather than silently absorbing it', async () => {
    // The safety net above must not hide the upstream bug that tripped it: a
    // writer that stops persisting cancel_prev_status would otherwise misreport
    // execution history fleet-wide with nothing in logs or Sentry to find it.
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: null });

    await applyScriptCancelAck({ cancelCommandId: 'cc-9', result: { outcome: 'not_found' } });

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0]![2]).toMatchObject({
      executionId: 'exec-1',
      cancelCommandId: 'cc-9',
    });
  });

  it('does not report when cancel_prev_status is present', async () => {
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: 'running' });

    await applyScriptCancelAck({ cancelCommandId: 'cc-1', result: { outcome: 'not_found' } });

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});

describe('applyScriptCancelAck is safe against every other closer', () => {
  it('does nothing when no cancelling execution matches the cancel command', async () => {
    const tx = withRow(null);

    await applyScriptCancelAck({ cancelCommandId: 'cc-orphan', result: { outcome: 'terminated' } });

    expect(tx.update).not.toHaveBeenCalled();
    expect(updatePatch).toBeUndefined();
  });

  it('locks the row it is about to close', () => {
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: 'running' });
    return applyScriptCancelAck({ cancelCommandId: 'cc-1', result: { outcome: 'terminated' } })
      .then(() => {
        expect(forUpdate).toHaveBeenCalledWith('update');
      });
  });

  it('selects on BOTH the cancel command id and status = cancelling', async () => {
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: 'running' });

    await applyScriptCancelAck({ cancelCommandId: 'cc-1', result: { outcome: 'terminated' } });

    const sql = renderSql(selectWhere);
    expect(sql).toContain('cancel_command_id');
    expect(sql).toContain('status');
  });

  it('the UPDATE is compare-and-swap guarded on status = cancelling', async () => {
    // Between the locking read and the write, a late original result may have
    // already terminalised the row. Without the guard this write would resurrect
    // `cancelling` over a real outcome.
    withRow({ id: 'exec-1', status: 'cancelling', cancelPrevStatus: 'running' });

    await applyScriptCancelAck({ cancelCommandId: 'cc-1', result: { outcome: 'terminated' } });

    const sql = renderSql(updateWhere);
    expect(sql).toContain('"id"');
    expect(sql).toContain('status');
  });
});
