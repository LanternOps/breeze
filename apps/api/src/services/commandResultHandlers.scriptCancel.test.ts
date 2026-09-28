import { describe, it, expect, vi, beforeEach } from 'vitest';

const applyScriptCancelAckMock = vi.fn();
vi.mock('./scriptCancellation', () => ({
  applyScriptCancelAck: (...args: unknown[]) => applyScriptCancelAckMock(...args),
}));

const captureExceptionMock = vi.hoisted(() => vi.fn());
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

vi.mock('./peripheralPolicyState', () => ({ handlePeripheralPolicyResultV2: vi.fn() }));
vi.mock('./pamActuationResult', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pamActuationResult')>()),
  recordPamActuationResult: vi.fn(),
}));

import { commandResultHandlers } from './commandResultHandlers';

const COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

const dispatch = (result: unknown) =>
  commandResultHandlers.script_cancel!({
    agentId: 'agent-1',
    commandId: COMMAND_ID,
    resolvedDeviceId: DEVICE_ID,
    // The cancel command row. Its payload carries the ORIGINAL script command's
    // id — which must NOT be what the handler keys the lookup on.
    command: { id: COMMAND_ID, payload: { executionId: 'original-script-cmd' } } as never,
    result: result as never,
    stdout: undefined,
  });

beforeEach(() => vi.clearAllMocks());

/**
 * #3525. The wiring between the transport and closer 2. A wrong id here does not
 * throw — `applyScriptCancelAck`'s locking SELECT simply matches nothing and the
 * execution sits in `cancelling` until a sweep gives up on it. That is precisely
 * the silent no-op this suite exists to make loud.
 */
describe('script_cancel result handler wiring', () => {
  it('keys the ack on the TRANSPORT-authorized command id, not the payload', async () => {
    await dispatch({ status: 'completed', result: { outcome: 'terminated' } });

    expect(applyScriptCancelAckMock).toHaveBeenCalledTimes(1);
    const [arg] = applyScriptCancelAckMock.mock.calls[0]!;
    expect(arg).toMatchObject({ cancelCommandId: COMMAND_ID });
    // Accepting an agent-supplied id would let one command's ack close another
    // command's execution — the invariant every handler in this file holds.
    expect(arg.cancelCommandId).not.toBe('original-script-cmd');
  });

  it('forwards the result envelope unchanged', async () => {
    const envelope = { status: 'failed', error: 'unknown command type' };

    await dispatch(envelope);

    expect(applyScriptCancelAckMock.mock.calls[0]![0]).toMatchObject({ result: envelope });
  });

  it('normalizes a missing result to null, never undefined', async () => {
    // applyScriptCancelAck's signature is `Record<string, unknown> | null`, and
    // it classifies a null result as `unconfirmed`. Leaking `undefined` through
    // would be a type lie even though both are currently falsy.
    await dispatch(undefined);

    expect(applyScriptCancelAckMock.mock.calls[0]![0]).toEqual({
      cancelCommandId: COMMAND_ID,
      result: null,
    });
  });

  it('propagates a failed ack so the transport can roll back the terminal CAS', async () => {
    // #3530: this handler no longer catches-and-swallows a persistence
    // failure — it rethrows so the transport rolls back the command's terminal
    // transition and parks the row as result_processing_failed, instead of the
    // command silently reading "done" while the ack never landed. Sentry
    // capture now happens exactly once, at the transport, not here — asserting
    // a handler-level captureException would reassert the old swallow-and-log
    // contract this fix replaced.
    const boom = new Error('deadlock detected');
    applyScriptCancelAckMock.mockRejectedValueOnce(boom);

    await expect(dispatch({ status: 'completed', result: { outcome: 'terminated' } }))
      .rejects.toBe(boom);

    expect(captureExceptionMock).not.toHaveBeenCalled();
  });
});
