import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../db';
import { scriptExecutions } from '../db/schema/scripts';
import { deviceCommands } from '../db/schema/devices';

/**
 * #3525 W02b — the REQUEST side of the cancel state machine.
 *
 * The ack side (`applyScriptCancelAck`) is covered by
 * `scriptCancellation.ack.test.ts`; this file covers `cancelScriptExecution`,
 * `deliverCancelCommand` and `cancelExecutionsForRun`.
 */

vi.mock('../db', () => ({
  db: { select: vi.fn(), update: vi.fn(), transaction: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
}));

const insertInTx = vi.hoisted(() => vi.fn());
const assertDeviceExecuteAllowedMock = vi.hoisted(() => vi.fn());
vi.mock('./commandQueue', () => ({
  CommandTypes: { SCRIPT: 'script', SCRIPT_CANCEL: 'script_cancel' },
  insertQueuedCommandInTransaction: insertInTx,
}));
vi.mock('./partnerTrust.commands', () => ({
  assertDeviceExecuteAllowed: assertDeviceExecuteAllowedMock,
}));

const applyAutomationActionTerminalMock = vi.hoisted(() => vi.fn());
vi.mock('./automationActionResults', () => ({
  applyAutomationActionTerminal: applyAutomationActionTerminalMock,
}));

const sendCommandToAgentMock = vi.hoisted(() => vi.fn());
vi.mock('../routes/agentWs', () => ({ sendCommandToAgent: sendCommandToAgentMock }));

const claimMock = vi.hoisted(() => vi.fn());
const releaseMock = vi.hoisted(() => vi.fn());
vi.mock('./commandDispatch', () => ({
  claimPendingCommandForDelivery: claimMock,
  releaseClaimedCommandDelivery: releaseMock,
}));

vi.mock('./sentry', () => ({ captureException: vi.fn() }));

const dialect = new PgDialect();
const renderSql = (clause: unknown) => dialect.sqlToQuery(clause as SQL).sql;

type Fixture = {
  executionId?: string;
  commandId?: string | null;
  /** `null` models "no paired script command row exists". */
  commandStatus: string | null;
  executionStatus: string;
  cancelState?: string | null;
  deviceId?: string;
  actorIsUser?: boolean;
  /** An existing live script_cancel for the same original command. */
  existingCancelId?: string | null;
};

let executionUpdates: Record<string, unknown>[] = [];
let commandUpdates: Record<string, unknown>[] = [];
/** Rendered WHERE clause of each `device_commands` SELECT, in call order. */
let commandLookups: string[] = [];
let eventOrder: string[] = [];

/**
 * Stubs the whole DB surface `cancelScriptExecution` touches: the pre-read of
 * the execution, the users FK probe, and the transaction's locking selects,
 * dedup select and updates. Dispatch is keyed on the Drizzle table object so
 * the mock does not bake in the order of the calls inside the transaction.
 */
function withFixture(fx: Fixture) {
  const executionId = fx.executionId ?? 'exec-uuid';
  const commandId = fx.commandId === undefined ? 'cmd-uuid' : fx.commandId;
  const deviceId = fx.deviceId ?? 'device-uuid';
  executionUpdates = [];
  commandUpdates = [];
  commandLookups = [];
  eventOrder = [];

  const executionRow = {
    id: executionId,
    deviceId,
    status: fx.executionStatus,
    cancelState: fx.cancelState ?? null,
    cancelPrevStatus: null,
  };

  // Outside the transaction: the execution pre-read, then the users FK probe.
  vi.mocked(db.select).mockImplementation((() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => (
          table === scriptExecutions
            ? [executionRow]
            : fx.actorIsUser === false ? [] : [{ id: 'user-uuid' }]
        )),
      })),
    })),
  })) as never);

  const commandRows = fx.commandStatus === null
    ? []
    : [{ id: commandId, status: fx.commandStatus, deviceId }];

  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((clause: unknown) => {
          const isCommandLookup = table === deviceCommands;
          // The FIRST device_commands select is the paired original `script`
          // command; a SECOND one is the script_cancel dedup probe.
          const lookupIndex = isCommandLookup ? commandLookups.length : -1;
          if (isCommandLookup) commandLookups.push(renderSql(clause));
          return {
            limit: vi.fn(() => {
              const rows = table === scriptExecutions
                ? [executionRow]
                : lookupIndex === 0
                  ? commandRows
                  : fx.existingCancelId ? [{ id: fx.existingCancelId }] : [];
              // The dedup select is awaited straight off `.limit(1)`; the two
              // locking selects add `.for('update')` first.
              return Object.assign(Promise.resolve(rows), { for: vi.fn(async () => rows) });
            }),
          };
        }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((patch: Record<string, unknown>) => {
        if (table === scriptExecutions) executionUpdates.push(patch);
        else commandUpdates.push(patch);
        return { where: vi.fn(async () => undefined) };
      }),
    })),
  };

  vi.mocked(db.transaction).mockImplementation((async (fn: (t: unknown) => unknown) => {
    const out = await fn(tx);
    eventOrder.push('commit');
    return out;
  }) as never);

  return { executionId, commandId, deviceId };
}

const lastExecutionUpdate = () => executionUpdates[executionUpdates.length - 1]!;

beforeEach(() => {
  vi.clearAllMocks();
  insertInTx.mockResolvedValue({ id: 'cancel-cmd-id' });
  assertDeviceExecuteAllowedMock.mockResolvedValue(undefined);
  applyAutomationActionTerminalMock.mockResolvedValue(true);
  claimMock.mockResolvedValue({ id: 'cancel-cmd-id', executedAt: new Date() });
  releaseMock.mockResolvedValue(undefined);
  sendCommandToAgentMock.mockImplementation(() => {
    eventOrder.push('sendCommandToAgent');
    return true;
  });
});

describe('script_cancel wire contract (#3525 blocker)', () => {
  it('payload.executionId carries the ORIGINAL device_commands.id, not script_executions.id', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'sent', executionStatus: 'running' });

    await cancelScriptExecution({
      executionId: 'exec-uuid',
      actorId: 'user-uuid',
      actorLabel: 'tech@msp.example',
    });

    expect(insertInTx).toHaveBeenCalledTimes(1);
    const { type, payload } = insertInTx.mock.calls[0]![1] as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(type).toBe('script_cancel');
    // The agent keys e.running on cmd.ID. Sending script_executions.id here
    // makes the whole feature a silent no-op on every agent in the fleet.
    expect(payload.executionId).toBe('cmd-uuid');
    expect(payload.executionId).not.toBe('exec-uuid');
    expect(payload.scriptExecutionId).toBe('exec-uuid');
    expect(payload.graceSeconds).toBe(5);
  });

  it('clamps graceSeconds into 0..30', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'sent', executionStatus: 'running' });
    await cancelScriptExecution({
      executionId: 'exec-uuid', actorId: null, actorLabel: 'ai', graceSeconds: 999,
    });
    const { payload } = insertInTx.mock.calls[0]![1] as { payload: Record<string, unknown> };
    expect(payload.graceSeconds).toBe(30);
  });

  it('accepts an explicit zero grace rather than defaulting it', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'sent', executionStatus: 'running' });
    await cancelScriptExecution({
      executionId: 'exec-uuid', actorId: null, actorLabel: 'ai', graceSeconds: 0,
    });
    const { payload } = insertInTx.mock.calls[0]![1] as { payload: Record<string, unknown> };
    expect(payload.graceSeconds).toBe(0);
  });

  it('records the queued cancel command id on the execution so the closers can find it', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'sent', executionStatus: 'running' });
    const out = await cancelScriptExecution({
      executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech',
    });
    const queuedId = (insertInTx.mock.calls[0]![1] as { id: string }).id;
    expect(lastExecutionUpdate().cancelCommandId).toBe(queuedId);
    expect(out).toMatchObject({ kind: 'cancelling', cancelCommandId: queuedId });
  });
});

describe('cancel branch matrix', () => {
  it('command still pending -> retract it, execution cancelled/confirmed, no agent round-trip', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'pending', executionStatus: 'running' });
    const out = await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech' });

    expect(out.kind).toBe('retracted');
    expect(insertInTx).not.toHaveBeenCalled();
    expect(lastExecutionUpdate()).toMatchObject({ status: 'cancelled', cancelState: 'confirmed' });
    // The retraction is the only server-side proof, so it is the only branch
    // that may close the paired automation action.
    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'cancellation', scriptExecutionId: 'exec-uuid', terminalStatus: 'cancelled',
    }));
  });

  it('a retracted command result never claims a timeout it did not have', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'pending', executionStatus: 'running' });
    await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech' });
    expect(commandUpdates[0]).toMatchObject({ status: 'cancelled' });
    expect((commandUpdates[0]!.result as Record<string, unknown>).status).toBe('cancelled');
  });

  it('command already terminal -> recover the completion, do NOT queue a cancel', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'completed', executionStatus: 'running' });
    const out = await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech' });

    expect(out.kind).toBe('recovered');
    expect(insertInTx).not.toHaveBeenCalled();
    expect(lastExecutionUpdate()).toMatchObject({ cancelState: 'unconfirmed' });
    // No proof of a stop: the execution status is left for the real closer.
    expect(lastExecutionUpdate().status).toBeUndefined();
    expect(applyAutomationActionTerminalMock).not.toHaveBeenCalled();
  });

  it('command sent -> cancelling, prev status recorded, completed_at stays NULL', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'sent', executionStatus: 'running' });
    const out = await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech' });

    expect(out.kind).toBe('cancelling');
    expect(lastExecutionUpdate()).toMatchObject({
      status: 'cancelling', cancelState: 'requested', cancelPrevStatus: 'running',
    });
    expect(lastExecutionUpdate().completedAt).toBeUndefined();
    expect(applyAutomationActionTerminalMock).not.toHaveBeenCalled();
  });

  it('command row ABSENT -> fail closed, never a confirmed cancel', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: null, executionStatus: 'running' });
    const out = await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech' });

    // Absence is not proof that nothing ran; it is an inconsistency.
    expect(out).toEqual({ kind: 'inconsistent' });
    expect(executionUpdates).toEqual([]);
    expect(insertInTx).not.toHaveBeenCalled();
  });

  it('execution already terminal -> already_terminal (409, changed from today 400)', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'completed', executionStatus: 'completed' });
    const out = await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech' });

    expect(out).toEqual({ kind: 'already_terminal', status: 'completed' });
    expect(executionUpdates).toEqual([]);
  });

  it('a terminal execution that already carries cancel metadata is idempotent, not a 409', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'completed', executionStatus: 'cancelled', cancelState: 'confirmed' });
    const out = await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech' });

    expect(out).toEqual({ kind: 'idempotent', status: 'cancelled' });
  });

  it('execution already cancelling -> idempotent 200, no second command row', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'sent', executionStatus: 'cancelling' });
    const out = await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech' });

    expect(out).toEqual({ kind: 'idempotent', status: 'cancelling' });
    expect(insertInTx).not.toHaveBeenCalled();
  });

  it('the paired-command lookup constrains type=script', async () => {
    // Today's route omits it, so an unrelated pending command whose payload
    // happens to carry the same executionId can be collided with.
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'sent', executionStatus: 'running' });
    await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech' });
    expect(commandLookups[0]).toContain('"type"');
    expect(commandLookups[0]).toContain('device_id');
  });

  it('an actor id that is not a users row degrades to NULL rather than raising 23503', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'sent', executionStatus: 'running', actorIsUser: false });
    await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'ai-agent-uuid', actorLabel: 'ai_agent' });
    expect(lastExecutionUpdate().cancelledBy).toBeNull();
  });

  it('a live script_cancel for the same original command is reused, never duplicated', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'sent', executionStatus: 'running', existingCancelId: 'already-queued' });
    const out = await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech' });

    expect(insertInTx).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: 'cancelling', cancelCommandId: 'already-queued', alreadyQueued: true });
  });

  it('a missing execution is not_found, never a fabricated terminal status', async () => {
    const { cancelScriptExecution } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'sent', executionStatus: 'running' });
    vi.mocked(db.select).mockImplementation((() => ({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => []) })) })),
    })) as never);
    const out = await cancelScriptExecution({ executionId: 'nope', actorId: 'user-uuid', actorLabel: 'tech' });
    expect(out).toEqual({ kind: 'not_found' });
  });

  it('never delivers to the agent from inside the cancel transaction', async () => {
    // A send before commit lets a fast ack land against a snapshot that cannot
    // see the command row yet, and the agent WS routes it as orphaned.
    const { cancelScriptExecution, deliverCancelCommand } = await import('./scriptCancellation');
    withFixture({ commandStatus: 'sent', executionStatus: 'running' });
    const out = await cancelScriptExecution({ executionId: 'exec-uuid', actorId: 'user-uuid', actorLabel: 'tech' });
    expect(sendCommandToAgentMock).not.toHaveBeenCalled();

    if (out.kind !== 'cancelling') throw new Error('expected a cancelling outcome');
    vi.mocked(db.select).mockImplementation((() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{
              id: out.cancelCommandId, type: 'script_cancel', payload: {}, agentId: 'agent-1',
            }]),
          })),
        })),
      })),
    })) as never);
    await deliverCancelCommand(out.cancelCommandId, out.deviceId);
    expect(eventOrder).toEqual(['commit', 'sendCommandToAgent']);
  });
});

describe('deliverCancelCommand', () => {
  function withCommandRow(row: Record<string, unknown> | null) {
    vi.mocked(db.select).mockImplementation((() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => (row ? [row] : [])) })),
        })),
      })),
    })) as never);
  }

  it('claims the row and hands the frame to the agent', async () => {
    const { deliverCancelCommand } = await import('./scriptCancellation');
    withCommandRow({
      id: 'cancel-cmd-id', type: 'script_cancel',
      payload: { executionId: 'cmd-uuid' }, agentId: 'agent-1',
    });

    expect(await deliverCancelCommand('cancel-cmd-id', 'device-uuid')).toBe(true);
    expect(claimMock).toHaveBeenCalledWith('cancel-cmd-id');
    expect(sendCommandToAgentMock).toHaveBeenCalledWith('agent-1', {
      id: 'cancel-cmd-id', type: 'script_cancel', payload: { executionId: 'cmd-uuid' },
    });
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('releases the claim when the send fails, so the row stays deliverable', async () => {
    const { deliverCancelCommand } = await import('./scriptCancellation');
    withCommandRow({ id: 'cancel-cmd-id', type: 'script_cancel', payload: {}, agentId: 'agent-1' });
    sendCommandToAgentMock.mockReturnValue(false);

    expect(await deliverCancelCommand('cancel-cmd-id', 'device-uuid')).toBe(false);
    // The command row must go back to `pending`: the heartbeat/HTTP-poll path
    // is the fallback, and a stranded `sent` row would misreport a server-side
    // send failure as agent unreachability.
    expect(releaseMock).toHaveBeenCalled();
  });

  it('never sends when the device has no connected agent', async () => {
    const { deliverCancelCommand } = await import('./scriptCancellation');
    withCommandRow({ id: 'cancel-cmd-id', type: 'script_cancel', payload: {}, agentId: null });

    expect(await deliverCancelCommand('cancel-cmd-id', 'device-uuid')).toBe(false);
    expect(claimMock).not.toHaveBeenCalled();
    expect(sendCommandToAgentMock).not.toHaveBeenCalled();
  });

  it('does not send when the claim was lost to the heartbeat path', async () => {
    const { deliverCancelCommand } = await import('./scriptCancellation');
    withCommandRow({ id: 'cancel-cmd-id', type: 'script_cancel', payload: {}, agentId: 'agent-1' });
    claimMock.mockResolvedValue(null);

    expect(await deliverCancelCommand('cancel-cmd-id', 'device-uuid')).toBe(false);
    expect(sendCommandToAgentMock).not.toHaveBeenCalled();
    expect(releaseMock).not.toHaveBeenCalled();
  });
});

describe('cancelExecutionsForRun', () => {
  it('keys on the run id alone and never on the caller org', async () => {
    const { cancelExecutionsForRun } = await import('./scriptCancellation');
    let scanSql = '';
    vi.mocked(db.select).mockImplementation((() => ({
      from: vi.fn(() => ({
        where: vi.fn((clause: unknown) => {
          scanSql = renderSql(clause);
          return Promise.resolve([]);
        }),
      })),
    })) as never);

    await cancelExecutionsForRun({ runId: 'run-1', actorId: null, actorLabel: 'tech' });
    // A partner-wide automation's executions carry many different org_ids; an
    // org filter here silently no-ops most of the run.
    expect(scanSql).not.toContain('org_id');
    expect(scanSql).toContain('automation_run_id');
  });

  it('tallies exactly one outcome per execution in the run', async () => {
    const mod = await import('./scriptCancellation');
    // The run scan awaits `.where(...)` directly; every per-execution pre-read
    // then finds nothing (the scan and the cancel race). The tally must still
    // account for every execution rather than dropping the losers.
    vi.mocked(db.select).mockImplementation((() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Object.assign(
          Promise.resolve([{ id: 'exec-a' }, { id: 'exec-b' }]),
          { limit: vi.fn(async () => []) },
        )),
      })),
    })) as never);
    const out = await mod.cancelExecutionsForRun({ runId: 'run-1', actorId: null, actorLabel: 'tech' });
    expect(out).toEqual({ requested: 0, retracted: 0, alreadyTerminal: 0, failed: 2 });
  });
});
