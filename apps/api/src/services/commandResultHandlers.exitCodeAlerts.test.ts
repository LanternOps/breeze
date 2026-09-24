import { beforeEach, describe, expect, it, vi } from 'vitest';

// #6690 — the script-result handler hands every terminal execution with a real
// exit code to evaluateScriptExitCodeAlert, AFTER the execution row is written.
// The evaluator's own rules live in scriptExitCodeAlerts.test.ts; this suite
// guards the wiring only.

const updateMock = vi.fn();
const selectMock = vi.fn();
const evaluateMock = vi.fn().mockResolvedValue(undefined);
const callOrder: string[] = [];

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      update: (...args: unknown[]) => updateMock(...(args as [])),
      select: (...args: unknown[]) => selectMock(...(args as [])),
    },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock('./automationActionResults', () => ({
  applyAutomationActionTerminal: vi.fn(async () => {
    callOrder.push('automation-terminal');
    return true;
  }),
}));

vi.mock('./scriptExitCodeAlerts', () => ({
  evaluateScriptExitCodeAlert: (...args: unknown[]) => {
    callOrder.push('evaluate');
    return evaluateMock(...args);
  },
}));

vi.mock('../jobs/discoveryWorker', () => ({ enqueueDiscoveryResults: vi.fn() }));
vi.mock('../jobs/snmpWorker', () => ({ enqueueSnmpPollResults: vi.fn() }));

import { commandResultHandlers } from './commandResultHandlers';

const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const ORG_ID = '55555555-5555-4555-8555-555555555555';
const SCRIPT_ID = '44444444-4444-4444-8444-444444444444';

const executionRow = {
  id: EXECUTION_ID,
  scriptId: SCRIPT_ID,
  proposalId: null,
  orgId: ORG_ID,
  triggerType: 'scheduled',
};

function updateReturning(rows: unknown[]) {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => {
        callOrder.push('execution-update');
        return rows;
      }) })),
    })),
  };
}

function scriptInput(result: Record<string, unknown>) {
  return {
    agentId: 'agent-1',
    command: {
      id: '22222222-2222-4222-8222-222222222222',
      payload: { executionId: EXECUTION_ID },
    },
    commandId: '22222222-2222-4222-8222-222222222222',
    result,
    resolvedDeviceId: DEVICE_ID,
    stdout: 'out',
  } as any;
}

describe('script result → exit-code alert wiring (#6690)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
  });

  it('evaluates a completed run after the execution row is written, with the execution org + trigger type', async () => {
    updateMock
      .mockReturnValueOnce(updateReturning([])) // cancel-unconfirmed CAS: not cancelling
      .mockReturnValueOnce(updateReturning([executionRow])); // primary CAS

    await commandResultHandlers.script!(scriptInput({ status: 'completed', exitCode: 3, stderr: 'boom' }));

    expect(evaluateMock).toHaveBeenCalledTimes(1);
    expect(evaluateMock).toHaveBeenCalledWith({
      executionId: EXECUTION_ID,
      scriptId: SCRIPT_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      triggerType: 'scheduled',
      exitCode: 3,
      stderr: 'boom',
    });
    expect(callOrder.indexOf('execution-update')).toBeLessThan(callOrder.indexOf('evaluate'));
  });

  it('still evaluates when an UNPROVEN cancel closes the row (the real outcome is kept)', async () => {
    // No cancelled marker → skips the confirm CAS; the unconfirmed CAS matches.
    updateMock.mockReturnValueOnce(updateReturning([executionRow]));

    await commandResultHandlers.script!(scriptInput({ status: 'completed', exitCode: 3 }));

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(evaluateMock).toHaveBeenCalledTimes(1);
    expect(evaluateMock).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 3, triggerType: 'scheduled' }));
  });

  it('does not evaluate a timeout (no real exit code)', async () => {
    updateMock.mockReturnValueOnce(updateReturning([executionRow]));

    await commandResultHandlers.script!(scriptInput({ status: 'timeout' }));

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it('does not evaluate a failed-to-run result', async () => {
    updateMock.mockReturnValueOnce(updateReturning([executionRow]));

    await commandResultHandlers.script!(scriptInput({ status: 'failed', exitCode: -1, error: 'killed' }));

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it('does not evaluate a proven cancel', async () => {
    updateMock.mockReturnValueOnce(updateReturning([executionRow]));

    await commandResultHandlers.script!(scriptInput({
      status: 'completed',
      exitCode: 0,
      cancelled: true,
      cancelledByCommandId: '99999999-9999-4999-8999-999999999999',
    }));

    expect(evaluateMock).not.toHaveBeenCalled();
  });

  it('does not evaluate when no execution row transitioned', async () => {
    updateMock
      .mockReturnValueOnce(updateReturning([])) // cancel-unconfirmed
      .mockReturnValueOnce(updateReturning([])) // primary
      .mockReturnValueOnce(updateReturning([])); // #3607 recovery
    selectMock.mockReturnValueOnce({
      from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([{ status: 'completed', exitCode: 0 }]) })) })),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await commandResultHandlers.script!(scriptInput({ status: 'completed', exitCode: 3 }));

    expect(evaluateMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
