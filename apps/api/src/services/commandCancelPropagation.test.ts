import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #5128 — a cancelled command is TERMINAL, so the command reaper (which scans
 * only pending/sent) never revisits it. Everything the command owned has to be
 * terminalised right here, or it waits forever: the script execution, its batch
 * counters (via the shared terminaliser), the deployment result, and the
 * automation action that dispatched it.
 */

const { finalizeMock, applyAutomationMock, captureExceptionMock, updateMock } = vi.hoisted(() => ({
  finalizeMock: vi.fn(),
  applyAutomationMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: { update: (...a: unknown[]) => updateMock(...(a as [])), select: vi.fn() } }));
vi.mock('../db/schema', () => ({
  deploymentResults: {
    deviceCommandId: 'deployment_results.device_command_id',
    status: 'deployment_results.status',
  },
}));
vi.mock('./scriptExecutionTerminal', () => ({
  finalizeScriptExecutionTerminal: (...a: unknown[]) => finalizeMock(...(a as [])),
  batchIdFromPayload: (payload: unknown) =>
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? ((payload as Record<string, unknown>).batchId as string | undefined) ?? null
      : null,
}));
vi.mock('./automationActionResults', () => ({
  applyAutomationActionTerminal: (...a: unknown[]) => applyAutomationMock(...(a as [])),
}));
vi.mock('./sentry', () => ({
  captureException: (...a: unknown[]) => captureExceptionMock(...(a as [])),
}));

import {
  propagateCancelledDeviceCommand,
  propagateCancelledDeviceCommands,
} from './commandCancelPropagation';

const COMPLETED_AT = new Date('2026-10-13T00:00:00Z');
const ERROR = 'Cancelled before the device received it';

function executor() {
  const sets: Array<Record<string, unknown>> = [];
  return {
    sets,
    handle: {
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          sets.push(vals);
          return { where: async () => undefined };
        },
      }),
      select: vi.fn(),
    } as never,
  };
}

describe('propagateCancelledDeviceCommand (#5128 §G)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    finalizeMock.mockResolvedValue({ terminalised: true });
    applyAutomationMock.mockResolvedValue(true);
  });

  it('terminalises a script execution through the shared batch-aware helper', async () => {
    // Writing to script_executions directly here is what left the owning batch
    // non-terminal forever: only the shared helper advances the counters.
    const { handle } = executor();
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1',
      type: 'script',
      payload: { executionId: 'exec-1', batchId: 'batch-1' },
      completedAt: COMPLETED_AT,
      executor: handle,
    });

    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock.mock.calls[0]![0]).toMatchObject({
      executionId: 'exec-1',
      batchId: 'batch-1',
      outcome: 'cancelled',
      errorMessage: ERROR,
      completedAt: COMPLETED_AT,
      executor: handle,
    });
  });

  it('a script command with no executionId does not reach the terminaliser', async () => {
    const { handle } = executor();
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1',
      type: 'script',
      payload: {},
      completedAt: COMPLETED_AT,
      executor: handle,
    });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('a non-script command never touches script_executions', async () => {
    const { handle, sets } = executor();
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1',
      type: 'software_install',
      payload: { deploymentId: 'dep-1' },
      completedAt: COMPLETED_AT,
      executor: handle,
    });
    expect(finalizeMock).not.toHaveBeenCalled();
    // ...but the deployment result still is.
    expect(sets).toEqual([{ status: 'cancelled', errorMessage: ERROR, completedAt: COMPLETED_AT }]);
  });

  it('terminalises the automation action that dispatched the command', async () => {
    const { handle } = executor();
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1',
      type: 'reboot',
      payload: null,
      completedAt: COMPLETED_AT,
      executor: handle,
    });

    expect(applyAutomationMock).toHaveBeenCalledWith({
      source: 'cancellation',
      commandId: 'cmd-1',
      terminalStatus: 'cancelled',
      error: ERROR,
      completedAt: COMPLETED_AT,
    });
  });

  it('an automation bookkeeping failure is reported, never thrown into the caller', async () => {
    // The caller is a route transaction (org move, decommission, user cancel) or
    // the heartbeat claim. Aborting those because a separate-connection
    // automation write failed would turn a cosmetic miss into a 500 / a device
    // that cannot check in.
    const { handle } = executor();
    applyAutomationMock.mockRejectedValue(new Error('automation down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        propagateCancelledDeviceCommand({
          commandId: 'cmd-1',
          type: 'reboot',
          payload: null,
          completedAt: COMPLETED_AT,
          executor: handle,
        }),
      ).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });

  it('the bulk form applies every row on the caller executor', async () => {
    const { handle } = executor();
    await propagateCancelledDeviceCommands(
      [
        { id: 'a', type: 'script', payload: { executionId: 'x' } },
        { id: 'b', type: 'software_install', payload: null },
      ],
      COMPLETED_AT,
      handle,
    );

    expect(finalizeMock).toHaveBeenCalledTimes(1);
    expect(applyAutomationMock).toHaveBeenCalledTimes(2);
    expect(applyAutomationMock.mock.calls.map((c) => (c[0] as { commandId: string }).commandId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('falls back to the ambient db when no executor is given', async () => {
    updateMock.mockReturnValue({
      set: () => ({ where: async () => undefined }),
    });
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1',
      type: 'reboot',
      payload: null,
      completedAt: COMPLETED_AT,
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });
});
