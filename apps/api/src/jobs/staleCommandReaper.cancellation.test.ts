import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * #3525 W03 closers 4 and 5 — cancel-command expiry and the cancellation sweep.
 *
 * `cancelling` must never be reachable-and-permanent. `reapStaleCancellations`
 * owns that state exclusively; `reapStaleScriptExecutions` deliberately cannot
 * see it, and the last test in the first block proves that from the compiled
 * predicate rather than from a mock's canned answer.
 */

const {
  selectMock,
  updateMock,
  scriptExecutionsTable,
  deviceCommandsTable,
  scriptsTable,
  scriptExecutionBatchesTable,
  createAuditLogAsyncMock,
  recordCancelUnconfirmedMock,
  applyAutomationActionTerminalMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  scriptExecutionsTable: {
    id: 'script_executions.id',
    deviceId: 'script_executions.device_id',
    orgId: 'script_executions.org_id',
    status: 'script_executions.status',
    scriptId: 'script_executions.script_id',
    createdAt: 'script_executions.created_at',
    startedAt: 'script_executions.started_at',
    completedAt: 'script_executions.completed_at',
    errorMessage: 'script_executions.error_message',
    cancelState: 'script_executions.cancel_state',
    cancelCommandId: 'script_executions.cancel_command_id',
    cancelPrevStatus: 'script_executions.cancel_prev_status',
    cancelRequestedAt: 'script_executions.cancel_requested_at',
  },
  deviceCommandsTable: {
    id: 'device_commands.id',
    type: 'device_commands.type',
    status: 'device_commands.status',
    payload: 'device_commands.payload',
    createdAt: 'device_commands.created_at',
    executedAt: 'device_commands.executed_at',
    completedAt: 'device_commands.completed_at',
    result: 'device_commands.result',
    deviceId: 'device_commands.device_id',
  },
  scriptsTable: {
    id: 'scripts.id',
    timeoutSeconds: 'scripts.timeout_seconds',
  },
  scriptExecutionBatchesTable: {
    id: 'script_execution_batches.id',
    devicesTargeted: 'script_execution_batches.devices_targeted',
    devicesCompleted: 'script_execution_batches.devices_completed',
    devicesFailed: 'script_execution_batches.devices_failed',
    status: 'script_execution_batches.status',
    completedAt: 'script_execution_batches.completed_at',
  },
  createAuditLogAsyncMock: vi.fn().mockResolvedValue(undefined),
  recordCancelUnconfirmedMock: vi.fn(),
  applyAutomationActionTerminalMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      select: (...args: unknown[]) => selectMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
    },
  };
});

vi.mock('../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema')>();
  return {
    ...actual,
    scriptExecutions: scriptExecutionsTable,
    deviceCommands: deviceCommandsTable,
    scripts: scriptsTable,
    scriptExecutionBatches: scriptExecutionBatchesTable,
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: (...args: unknown[]) => createAuditLogAsyncMock(...(args as [])),
}));

vi.mock('../services/scriptCancellationMetrics', () => ({
  recordCancelUnconfirmed: (...args: unknown[]) => recordCancelUnconfirmedMock(...(args as [])),
}));

vi.mock('../services/automationActionResults', () => ({
  applyAutomationActionTerminal: (...args: unknown[]) =>
    applyAutomationActionTerminalMock(...(args as [])),
}));

import {
  REAPER_DOMAINS,
  reapStaleCancellations,
  reapStaleScriptExecutions,
} from './staleCommandReaper';
import { CANCEL_GRACE_MS } from '../services/scriptCancellation';
import { SERVER_TIMEOUT_RESULT_STATUS } from '../services/commandResultAcceptance';

// ── harness ───────────────────────────────────────────────────────────────

function selectChain(resolvedValue: unknown) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

type RecordedUpdate = { table: unknown; values: Record<string, unknown>; where: unknown };
let recordedUpdates: RecordedUpdate[];

/**
 * Every `db.update()` is recorded with the TABLE it targeted, so an assertion
 * about the execution row can never accidentally be satisfied by the write to
 * the cancel command (or vice versa).
 */
function installUpdateRecorder(executionReturning: unknown[] = [{ id: 'exec-1' }]) {
  updateMock.mockImplementation((table: unknown) => ({
    set: (values: Record<string, unknown>) => ({
      where: (whereArg: unknown) => {
        recordedUpdates.push({ table, values, where: whereArg });
        const rows = table === scriptExecutionsTable ? executionReturning : [];
        return Object.assign(Promise.resolve(rows), {
          returning: vi.fn().mockResolvedValue(rows),
        });
      },
    }),
  }));
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);
const updatesTo = (table: unknown) => recordedUpdates.filter((u) => u.table === table);
const lastExecutionUpdate = () => updatesTo(scriptExecutionsTable).at(-1)?.values;
const lastCommandUpdate = () => updatesTo(deviceCommandsTable).at(-1)?.values;

type CancellingRow = {
  executionId?: string;
  deviceId?: string;
  orgId?: string;
  prevStatus?: string | null;
  cancelCommandId?: string | null;
  cancelRequestedAt?: Date | null;
  cmdStatus?: string | null;
  cmdExecutedAt?: Date | null;
  cmdResult?: unknown;
};

function seed(row: CancellingRow) {
  selectMock.mockReturnValueOnce(selectChain([{
    executionId: row.executionId ?? 'exec-1',
    deviceId: row.deviceId ?? 'device-1',
    orgId: row.orgId ?? 'org-1',
    prevStatus: row.prevStatus === undefined ? 'running' : row.prevStatus,
    cancelCommandId: row.cancelCommandId === undefined ? 'cancel-cmd-1' : row.cancelCommandId,
    cancelRequestedAt: row.cancelRequestedAt === undefined ? minutesAgo(1) : row.cancelRequestedAt,
    cmdStatus: row.cmdStatus === undefined ? 'sent' : row.cmdStatus,
    cmdExecutedAt: row.cmdExecutedAt === undefined ? null : row.cmdExecutedAt,
    cmdResult: row.cmdResult ?? null,
  }]));
}

beforeEach(() => {
  vi.clearAllMocks();
  recordedUpdates = [];
  createAuditLogAsyncMock.mockResolvedValue(undefined);
  applyAutomationActionTerminalMock.mockResolvedValue(true);
  installUpdateRecorder();
});

// ── tests ─────────────────────────────────────────────────────────────────

describe('reapStaleCancellations (#3525 closer 5)', () => {
  it('gives up on a cancelling execution past CANCEL_GRACE_MS FROM DELIVERY', async () => {
    // Grace is measured from device_commands.executed_at, not from
    // cancel_requested_at: the clock starts when the device receives the cancel.
    seed({ prevStatus: 'running', cmdExecutedAt: minutesAgo(5) });
    expect(await reapStaleCancellations()).toBe(1);
    expect(lastExecutionUpdate()).toMatchObject({ status: 'running', cancelState: 'unconfirmed' });
  });

  it('reverts to cancel_prev_status, not to a hardcoded running', async () => {
    seed({ prevStatus: 'queued', cmdExecutedAt: minutesAgo(5) });
    await reapStaleCancellations();
    expect(lastExecutionUpdate()).toMatchObject({ status: 'queued', cancelState: 'unconfirmed' });
  });

  it('falls back to running when cancel_prev_status is NULL rather than stranding the row', async () => {
    seed({ prevStatus: null, cmdExecutedAt: minutesAgo(5) });
    await reapStaleCancellations();
    expect(lastExecutionUpdate()).toMatchObject({ status: 'running' });
  });

  it('does NOT give up while the cancel command is still merely pending', async () => {
    // Undelivered means the grace clock has not started. The command's own
    // 2-hour expiry owns that case (closer 4).
    seed({ cmdStatus: 'pending', cmdExecutedAt: null });
    expect(await reapStaleCancellations()).toBe(0);
    expect(recordedUpdates).toHaveLength(0);
  });

  it('does NOT give up on a delivered cancel still inside the grace window', async () => {
    seed({ cmdStatus: 'sent', cmdExecutedAt: new Date(Date.now() - Math.floor(CANCEL_GRACE_MS / 2)) });
    expect(await reapStaleCancellations()).toBe(0);
  });

  it('closes the cancel command with a marker the acceptance path will reopen', async () => {
    seed({ prevStatus: 'running', cmdExecutedAt: minutesAgo(5) });
    await reapStaleCancellations();
    // commandResultAcceptance only reopens `failed` rows whose
    // result->>'status' = 'timeout'. Any other marker loses a late ack forever.
    expect(lastCommandUpdate()).toMatchObject({ status: 'failed' });
    expect((lastCommandUpdate()?.result as Record<string, unknown>)?.status)
      .toBe(SERVER_TIMEOUT_RESULT_STATUS);
  });

  it('does not re-close a cancel command that already reached a terminal status', async () => {
    seed({ cmdStatus: 'failed', cmdResult: { status: 'timeout' }, prevStatus: 'queued' });
    await reapStaleCancellations();
    expect(updatesTo(deviceCommandsTable)).toHaveLength(0);
  });

  it('writes the script.execution.cancel.unconfirmed audit event', async () => {
    seed({ prevStatus: 'running', cmdExecutedAt: minutesAgo(5) });
    await reapStaleCancellations();
    expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'script.execution.cancel.unconfirmed',
      resourceType: 'script_execution',
      resourceId: 'exec-1',
      orgId: 'org-1',
      details: expect.objectContaining({
        deviceId: 'device-1',
        cancelCommandId: 'cancel-cmd-1',
        revertedTo: 'running',
      }),
    }));
  });

  it('records the metric', async () => {
    seed({ prevStatus: 'running', cmdExecutedAt: minutesAgo(5) });
    await reapStaleCancellations();
    expect(recordCancelUnconfirmedMock).toHaveBeenCalledTimes(1);
  });

  it('does not audit or count when the CAS lost the row to another closer', async () => {
    // The agent's ack landed between the SELECT and the UPDATE. That closer
    // owns the outcome; this sweep must not also claim it.
    installUpdateRecorder([]);
    seed({ prevStatus: 'running', cmdExecutedAt: minutesAgo(5) });
    expect(await reapStaleCancellations()).toBe(0);
    expect(createAuditLogAsyncMock).not.toHaveBeenCalled();
    expect(recordCancelUnconfirmedMock).not.toHaveBeenCalled();
    expect(updatesTo(deviceCommandsTable)).toHaveLength(0);
  });

  it('compare-and-swaps on status = cancelling so a concurrent closer wins', async () => {
    seed({ prevStatus: 'running', cmdExecutedAt: minutesAgo(5) });
    await reapStaleCancellations();
    const { sql: sqlText, params } = new PgDialect()
      .sqlToQuery(updatesTo(scriptExecutionsTable)[0]!.where as never);
    expect(params).toContain('script_executions.status');
    expect(params).toContain('cancelling');
    expect(sqlText).toContain('and');
  });

  it('is registered as a reaper domain, after scriptExecutions', () => {
    const names = REAPER_DOMAINS.map(([name]) => name);
    expect(names).toContain('scriptCancellations');
    expect(names.indexOf('scriptCancellations')).toBeGreaterThan(names.indexOf('scriptExecutions'));
  });

  it('leaves reapStaleScriptExecutions unchanged — a cancelling row is invisible to it', async () => {
    // Asserted on the COMPILED predicate, not on a mocked result set: the point
    // is that Postgres never hands this reaper a `cancelling` row at all.
    const chain = selectChain([]);
    selectMock.mockReturnValueOnce(chain);
    await reapStaleScriptExecutions();
    const { params } = new PgDialect().sqlToQuery(chain.where.mock.calls[0]?.[0] as never);
    expect(params).toEqual(expect.arrayContaining(['pending', 'queued', 'running']));
    expect(params).not.toContain('cancelling');
  });
});

describe('cancel-command expiry (#3525 closer 4)', () => {
  it('an expired script_cancel reverts the execution to unconfirmed, never strands it', async () => {
    seed({
      prevStatus: 'queued',
      cmdStatus: 'failed',
      cmdResult: { status: 'timeout' },
      cmdExecutedAt: null,
    });
    await reapStaleCancellations();
    expect(lastExecutionUpdate()).toMatchObject({ status: 'queued', cancelState: 'unconfirmed' });
  });

  it('treats a completed cancel command with no ack applied as terminal too', async () => {
    // The ack handler no-ops when another closer already resolved the row; if
    // it did not, the command is terminal and the execution must not sit in
    // `cancelling` waiting for an ack that will never be redelivered.
    seed({ prevStatus: 'running', cmdStatus: 'completed', cmdExecutedAt: null });
    expect(await reapStaleCancellations()).toBe(1);
  });

  it('resolves an execution whose cancel command row has vanished entirely', async () => {
    // `cancel_command_id` is a bare uuid precisely because command rows are
    // reaped on their own schedule (see the column comment in schema/scripts.ts).
    // Once the row is gone nothing can ever ack it, and neither `cmdTerminal`
    // nor `cmdExecutedAt` can be true — so without this arm the execution sits
    // in `cancelling` forever, which is the one state this wave exists to make
    // unreachable.
    seed({ cmdStatus: null, cmdExecutedAt: null, cancelRequestedAt: minutesAgo(30), prevStatus: 'running' });
    expect(await reapStaleCancellations()).toBe(1);
    expect(lastExecutionUpdate()).toMatchObject({ status: 'running', cancelState: 'unconfirmed' });
    expect(updatesTo(deviceCommandsTable)).toHaveLength(0);
  });

  it('does NOT resolve a missing command row inside the grace window', async () => {
    // Guards the write-ordering window: an execution stamped `cancelling` a
    // moment before its command row is visible must not be reverted out from
    // under the cancel that is still being dispatched.
    seed({ cmdStatus: null, cmdExecutedAt: null, cancelRequestedAt: new Date(), prevStatus: 'running' });
    expect(await reapStaleCancellations()).toBe(0);
  });
});
