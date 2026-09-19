import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * #5128 review round 2 (I) — the batch-counter contract.
 *
 * Before this helper existed only `reapStaleScriptExecutions` maintained
 * `script_execution_batches`. Three other paths terminalise an execution
 * (delivery expiry, claim-time cancel, the reaper's own `cancelled` branch) and
 * none of them touched the counters — so `devicesCompleted + devicesFailed`
 * could never reach `devicesTargeted` and the batch stayed non-terminal forever.
 *
 * The CAS on `status IN ('pending','queued','running')` is the double-count
 * guard: whichever path flips the row increments; every later one is a no-op.
 */

const { updateMock, selectMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: {
  update: (...a: unknown[]) => updateMock(...(a as [])),
  select: (...a: unknown[]) => selectMock(...(a as [])),
} }));

vi.mock('../db/schema', () => ({
  scriptExecutions: {
    id: 'script_executions.id',
    status: 'script_executions.status',
    errorMessage: 'script_executions.error_message',
    completedAt: 'script_executions.completed_at',
  },
  scriptExecutionBatches: {
    id: 'script_execution_batches.id',
    status: 'script_execution_batches.status',
    devicesTargeted: 'script_execution_batches.devices_targeted',
    devicesCompleted: 'script_execution_batches.devices_completed',
    devicesFailed: 'script_execution_batches.devices_failed',
    completedAt: 'script_execution_batches.completed_at',
  },
}));

import {
  batchIdFromPayload,
  finalizeScriptExecutionTerminal,
} from './scriptExecutionTerminal';

const EXEC = 'exec-1';
const BATCH = 'batch-1';

type Call = { table: string; set: Record<string, unknown>; where: unknown };

/**
 * Records every UPDATE issued on the executor, and serves the batch SELECT.
 * `execReturning` decides whether the execution CAS matched a row — the single
 * fact everything downstream keys on.
 */
function executor(opts: { execReturning: unknown[]; batch?: unknown }) {
  const calls: Call[] = [];
  const updates = (table: string) => ({
    set: (vals: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        calls.push({ table, set: vals, where: cond });
        return {
          returning: async () => (table === 'script_executions' ? opts.execReturning : []),
          then: (res: (v: unknown) => unknown) => res(undefined),
        };
      },
    }),
  });
  const exec = {
    update: (table: unknown) =>
      updates(
        (table as { id?: string }).id === 'script_executions.id'
          ? 'script_executions'
          : 'script_execution_batches',
      ),
    select: () => ({
      from: () => ({ where: async () => (opts.batch ? [opts.batch] : []) }),
    }),
  };
  return { exec: exec as never, calls };
}

describe('finalizeScriptExecutionTerminal (#5128 I)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('terminalises the execution and increments devicesFailed for a delivery expiry', async () => {
    const { exec, calls } = executor({
      execReturning: [{ id: EXEC }],
      batch: { devicesTargeted: 2, devicesCompleted: 0, devicesFailed: 1 },
    });

    const res = await finalizeScriptExecutionTerminal({
      executionId: EXEC,
      batchId: BATCH,
      outcome: 'failed',
      errorMessage: 'Device did not reconnect before the deadline',
      completedAt: new Date(),
      executor: exec,
    });

    expect(res).toEqual({ terminalised: true });
    expect(calls[0]!.table).toBe('script_executions');
    expect(calls[0]!.set).toMatchObject({ status: 'failed' });
    // Exactly one counter write, and it is devicesFailed — not devicesCompleted.
    const counterWrites = calls.filter(
      (c) => c.table === 'script_execution_batches' && 'devicesFailed' in c.set,
    );
    expect(counterWrites).toHaveLength(1);
    expect(calls.some((c) => 'devicesCompleted' in c.set)).toBe(false);
  });

  it('a claim-time cancel takes the same path', async () => {
    const { exec, calls } = executor({
      execReturning: [{ id: EXEC }],
      batch: { devicesTargeted: 5, devicesCompleted: 0, devicesFailed: 1 },
    });

    await finalizeScriptExecutionTerminal({
      executionId: EXEC,
      batchId: BATCH,
      outcome: 'cancelled',
      errorMessage: 'Cancelled before the device received it',
      completedAt: new Date(),
      executor: exec,
    });

    expect(calls[0]!.set).toMatchObject({ status: 'cancelled' });
    expect(calls.filter((c) => 'devicesFailed' in c.set)).toHaveLength(1);
  });

  it('a completed outcome counts toward devicesCompleted instead', async () => {
    const { exec, calls } = executor({
      execReturning: [{ id: EXEC }],
      batch: { devicesTargeted: 5, devicesCompleted: 1, devicesFailed: 0 },
    });

    await finalizeScriptExecutionTerminal({
      executionId: EXEC,
      batchId: BATCH,
      outcome: 'completed',
      errorMessage: null,
      completedAt: new Date(),
      executor: exec,
    });

    expect(calls.some((c) => 'devicesCompleted' in c.set)).toBe(true);
    expect(calls.some((c) => 'devicesFailed' in c.set)).toBe(false);
  });

  it('terminalises the BATCH once the counters reach devicesTargeted', async () => {
    const { exec, calls } = executor({
      execReturning: [{ id: EXEC }],
      // Post-increment view: this was the last device, and one failed.
      batch: { devicesTargeted: 2, devicesCompleted: 1, devicesFailed: 1 },
    });

    await finalizeScriptExecutionTerminal({
      executionId: EXEC,
      batchId: BATCH,
      outcome: 'failed',
      errorMessage: 'boom',
      completedAt: new Date(),
      executor: exec,
    });

    const terminal = calls.find((c) => 'status' in c.set && c.table === 'script_execution_batches');
    expect(terminal?.set).toMatchObject({ status: 'failed' });
  });

  it('an all-success batch terminalises as completed', async () => {
    const { exec, calls } = executor({
      execReturning: [{ id: EXEC }],
      batch: { devicesTargeted: 2, devicesCompleted: 2, devicesFailed: 0 },
    });

    await finalizeScriptExecutionTerminal({
      executionId: EXEC,
      batchId: BATCH,
      outcome: 'completed',
      errorMessage: null,
      completedAt: new Date(),
      executor: exec,
    });

    const terminal = calls.find((c) => 'status' in c.set && c.table === 'script_execution_batches');
    expect(terminal?.set).toMatchObject({ status: 'completed' });
  });

  it('leaves the batch alone while devices are still outstanding', async () => {
    const { exec, calls } = executor({
      execReturning: [{ id: EXEC }],
      batch: { devicesTargeted: 5, devicesCompleted: 1, devicesFailed: 1 },
    });

    await finalizeScriptExecutionTerminal({
      executionId: EXEC,
      batchId: BATCH,
      outcome: 'failed',
      errorMessage: 'boom',
      completedAt: new Date(),
      executor: exec,
    });

    expect(calls.some((c) => c.table === 'script_execution_batches' && 'status' in c.set)).toBe(false);
  });

  it('a CAS that matches nothing does NOT double-count the batch', async () => {
    // This is the case where `propagateCancelledDeviceCommand` already
    // terminalised the execution and the reaper's `cancelled` branch arrives
    // afterwards. Without the fence the batch would be charged twice and could
    // overshoot devicesTargeted (or terminalise on the wrong device).
    const { exec, calls } = executor({ execReturning: [] });

    const res = await finalizeScriptExecutionTerminal({
      executionId: EXEC,
      batchId: BATCH,
      outcome: 'cancelled',
      errorMessage: 'Cancelled before the device received it',
      completedAt: new Date(),
      executor: exec,
    });

    expect(res).toEqual({ terminalised: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe('script_executions');
  });

  it('the execution UPDATE is fenced on the non-terminal statuses', async () => {
    const { exec, calls } = executor({ execReturning: [{ id: EXEC }] });

    await finalizeScriptExecutionTerminal({
      executionId: EXEC,
      outcome: 'cancelled',
      errorMessage: null,
      completedAt: new Date(),
      executor: exec,
    });

    // The mocked columns are plain strings, so they render as bound params and
    // the exact fence is checkable. Dropping it is what would allow the double
    // count this suite exists to prevent.
    const { params } = new PgDialect().sqlToQuery(calls[0]!.where as never);
    expect(params).toEqual([
      'script_executions.id',
      EXEC,
      'script_executions.status',
      'pending',
      'queued',
      'running',
    ]);
  });

  it('no batchId means no batch traffic at all', async () => {
    const { exec, calls } = executor({ execReturning: [{ id: EXEC }] });

    await finalizeScriptExecutionTerminal({
      executionId: EXEC,
      batchId: null,
      outcome: 'failed',
      errorMessage: 'boom',
      completedAt: new Date(),
      executor: exec,
    });

    expect(calls).toHaveLength(1);
  });

  it('batchIdFromPayload only accepts a non-empty string', () => {
    expect(batchIdFromPayload({ batchId: 'b1' })).toBe('b1');
    expect(batchIdFromPayload({ batchId: '  ' })).toBeNull();
    expect(batchIdFromPayload({ batchId: 42 })).toBeNull();
    expect(batchIdFromPayload({})).toBeNull();
    expect(batchIdFromPayload(null)).toBeNull();
    expect(batchIdFromPayload('nope')).toBeNull();
    expect(batchIdFromPayload([{ batchId: 'b1' }])).toBeNull();
  });
});
