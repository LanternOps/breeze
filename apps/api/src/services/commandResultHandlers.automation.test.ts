import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateMock = vi.fn();
const selectMock = vi.fn();
const applyAutomationActionTerminalMock = vi.fn().mockResolvedValue(true);

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
  applyAutomationActionTerminal: (...args: unknown[]) =>
    applyAutomationActionTerminalMock(...(args as [])),
}));

vi.mock('../jobs/discoveryWorker', () => ({ enqueueDiscoveryResults: vi.fn() }));
vi.mock('../jobs/snmpWorker', () => ({ enqueueSnmpPollResults: vi.fn() }));

import { commandResultHandlers } from './commandResultHandlers';

const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';

function updateReturning(rows: unknown[]) {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(rows) })),
    })),
  };
}

function selectRows(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
    })),
  };
}

function scriptInput(exitCode = 0) {
  return {
    agentId: 'agent-1',
    command: {
      id: '22222222-2222-4222-8222-222222222222',
      payload: { executionId: EXECUTION_ID },
    },
    commandId: '22222222-2222-4222-8222-222222222222',
    result: { status: 'completed' as const, exitCode },
    resolvedDeviceId: '33333333-3333-4333-8333-333333333333',
    stdout: 'already redacted output',
  } as any;
}

describe('script automation terminal reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyAutomationActionTerminalMock.mockResolvedValue(true);
  });

  // D1 (port design §6): the handler record returns
  // Promise<CommandResultHandlerOutcome>, so handleScriptResult no longer hands
  // back the effective execution row. The terminal-evidence call IS the
  // observable contract these tests guard.
  it('terminalizes only after the guarded source transition', async () => {
    updateMock.mockReturnValueOnce(updateReturning([{ id: EXECUTION_ID, scriptId: 'script-1' }]));

    await commandResultHandlers.script!(scriptInput());

    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'script_execution',
      scriptExecutionId: EXECUTION_ID,
      terminalStatus: 'succeeded',
      output: 'already redacted output',
    }));
  });

  it('maps completed nonzero exit to failed', async () => {
    updateMock.mockReturnValueOnce(updateReturning([{ id: EXECUTION_ID, scriptId: 'script-1' }]));

    await commandResultHandlers.script!(scriptInput(7));

    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      terminalStatus: 'failed',
    }));
  });

  it('treats a duplicate source transition as a no-op', async () => {
    updateMock
      .mockReturnValueOnce(updateReturning([]))
      .mockReturnValueOnce(updateReturning([]));
    selectMock.mockReturnValueOnce(selectRows([{ status: 'completed', exitCode: 0 }]));

    await commandResultHandlers.script!(scriptInput());

    expect(applyAutomationActionTerminalMock).not.toHaveBeenCalled();
  });

  it('allows guarded late recovery to replace a provisional timeout', async () => {
    updateMock
      .mockReturnValueOnce(updateReturning([]))
      .mockReturnValueOnce(updateReturning([{ id: EXECUTION_ID, scriptId: 'script-1' }]));

    await commandResultHandlers.script!(scriptInput());

    expect(applyAutomationActionTerminalMock).toHaveBeenCalledWith(expect.objectContaining({
      source: 'script_execution',
      scriptExecutionId: EXECUTION_ID,
      terminalStatus: 'succeeded',
    }));
  });
});
