import { beforeEach, describe, expect, it, vi } from 'vitest';

// #7277 — the agent-result path publishes script.completed / script.failed, but
// only for the writer that actually terminalised the execution row. Wiring only:
// the mapping and the after-commit deferral live in scriptTerminalEvents.test.ts.

const updateMock = vi.fn();
const selectMock = vi.fn();
const emitMock = vi.fn();

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

vi.mock('./automationActionResults', () => ({ applyAutomationActionTerminal: vi.fn(async () => true) }));
vi.mock('./scriptExitCodeAlerts', () => ({ evaluateScriptExitCodeAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./fixMemory/scriptTerminalHook', () => ({ advanceOutcomesForTerminalExecution: vi.fn().mockResolvedValue(1) }));
vi.mock('./scriptTerminalEvents', () => ({ emitScriptTerminalEvent: (...a: unknown[]) => emitMock(...a) }));
vi.mock('../jobs/discoveryWorker', () => ({ enqueueDiscoveryResults: vi.fn() }));
vi.mock('../jobs/snmpWorker', () => ({ enqueueSnmpPollResults: vi.fn() }));

import { commandResultHandlers } from './commandResultHandlers';

const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';
const COMMAND_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const SCRIPT_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '55555555-5555-4555-8555-555555555555';
const RUN_ID = '66666666-6666-4666-8666-666666666666';

const executionRow = {
  id: EXECUTION_ID,
  scriptId: SCRIPT_ID,
  proposalId: null,
  orgId: ORG_ID,
  triggerType: 'automation',
  automationRunId: RUN_ID,
};

function updateReturning(rows: unknown[]) {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(async () => rows) })),
    })),
  };
}

function scriptInput(result: Record<string, unknown>) {
  return {
    agentId: 'agent-1',
    command: { id: COMMAND_ID, payload: { executionId: EXECUTION_ID } },
    commandId: COMMAND_ID,
    result,
    resolvedDeviceId: DEVICE_ID,
    stdout: 'out',
  } as any;
}

describe('script result → public terminal events (#7277)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits completed for the CAS winner, with the execution identity and no output', async () => {
    updateMock
      .mockReturnValueOnce(updateReturning([])) // cancel-unconfirmed CAS: not cancelling
      .mockReturnValueOnce(updateReturning([executionRow])); // primary CAS

    await commandResultHandlers.script!(scriptInput({ status: 'completed', exitCode: 0 }));

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith({
      executionId: EXECUTION_ID,
      orgId: ORG_ID,
      deviceId: DEVICE_ID,
      scriptId: SCRIPT_ID,
      triggerType: 'automation',
      automationRunId: RUN_ID,
      exitCode: 0,
      status: 'completed',
    });
  });

  it('a non-zero exit code is a failure', async () => {
    updateMock.mockReturnValueOnce(updateReturning([executionRow]));
    await commandResultHandlers.script!(scriptInput({ status: 'completed', exitCode: 2 }));
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', exitCode: 2 }));
  });

  it('a timeout is emitted as timeout (published as script.failed)', async () => {
    updateMock.mockReturnValueOnce(updateReturning([executionRow]));
    await commandResultHandlers.script!(scriptInput({ status: 'timeout' }));
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'timeout', exitCode: null }));
  });

  it('does NOT emit for the #3607 late-result recovery (the sweep that terminalised the row already did)', async () => {
    updateMock
      .mockReturnValueOnce(updateReturning([])) // cancel-unconfirmed
      .mockReturnValueOnce(updateReturning([])) // primary CAS lost
      .mockReturnValueOnce(updateReturning([executionRow])); // 3607 recovery matched

    await commandResultHandlers.script!(scriptInput({ status: 'completed', exitCode: 0 }));

    expect(emitMock).not.toHaveBeenCalled();
  });

  it('does NOT emit for a proven cancel (a stop is not a failure)', async () => {
    updateMock.mockReturnValueOnce(updateReturning([executionRow])); // cancel-confirm CAS

    await commandResultHandlers.script!(
      scriptInput({ status: 'failed', exitCode: -1, cancelled: true, cancelledByCommandId: '77777777-7777-4777-8777-777777777777' }),
    );

    expect(emitMock).not.toHaveBeenCalled();
  });

  it('does NOT emit when nothing matched', async () => {
    updateMock.mockReturnValue(updateReturning([]));
    selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [] }) }) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await commandResultHandlers.script!(scriptInput({ status: 'completed', exitCode: 0 }));

    expect(emitMock).not.toHaveBeenCalled();
  });
});
