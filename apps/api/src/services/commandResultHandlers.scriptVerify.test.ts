import { beforeEach, describe, expect, it, vi } from 'vitest';

// W03 (#5612): a proposal-backed execution reaching a terminal state enqueues
// `script-verify`. Harness mirrors commandResultHandlers.automation.test.ts —
// the enqueue sits at the same convergence point as the automation terminal.

const updateMock = vi.fn();
const selectMock = vi.fn();
const enqueueScriptVerifyMock = vi.fn().mockResolvedValue(undefined);
const captureExceptionMock = vi.fn();

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
vi.mock('./automationActionResults', () => ({ applyAutomationActionTerminal: vi.fn().mockResolvedValue(true) }));
vi.mock('./scriptProposals/verify', () => ({
  enqueueScriptVerify: (...args: unknown[]) => enqueueScriptVerifyMock(...(args as [])),
}));
vi.mock('./sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sentry')>()),
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));
vi.mock('../jobs/discoveryWorker', () => ({ enqueueDiscoveryResults: vi.fn() }));
vi.mock('../jobs/snmpWorker', () => ({ enqueueSnmpPollResults: vi.fn() }));

import { commandResultHandlers } from './commandResultHandlers';

const EXECUTION_ID = '11111111-1111-4111-8111-111111111111';
const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';

function updateReturning(rows: unknown[]) {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue(rows) })),
    })),
  };
}
function selectRows(rows: unknown[]) {
  return { from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })) })) };
}
function scriptInput(exitCode = 0) {
  return {
    agentId: 'agent-1',
    command: { id: '22222222-2222-4222-8222-222222222222', payload: { executionId: EXECUTION_ID } },
    commandId: '22222222-2222-4222-8222-222222222222',
    result: { status: 'completed' as const, exitCode },
    resolvedDeviceId: '33333333-3333-4333-8333-333333333333',
    stdout: 'ok',
  } as any;
}

describe('script-verify enqueue at result ingest (W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueScriptVerifyMock.mockResolvedValue(undefined);
  });

  it('enqueues script-verify for a proposal-backed execution', async () => {
    updateMock.mockReturnValueOnce(updateReturning([{ id: EXECUTION_ID, scriptId: null, proposalId: PROPOSAL_ID }]));
    await commandResultHandlers.script!(scriptInput());
    expect(enqueueScriptVerifyMock).toHaveBeenCalledWith({ proposalId: PROPOSAL_ID, executionId: EXECUTION_ID, attempt: 1 });
  });

  it('enqueues even for a failed execution — the claim is evaluated, not assumed', async () => {
    updateMock.mockReturnValueOnce(updateReturning([{ id: EXECUTION_ID, scriptId: null, proposalId: PROPOSAL_ID }]));
    await commandResultHandlers.script!(scriptInput(7));
    expect(enqueueScriptVerifyMock).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue for a library execution', async () => {
    updateMock.mockReturnValueOnce(updateReturning([{ id: EXECUTION_ID, scriptId: 'script-1', proposalId: null }]));
    await commandResultHandlers.script!(scriptInput());
    expect(enqueueScriptVerifyMock).not.toHaveBeenCalled();
  });

  it('does not enqueue when no CAS rung matched (a late duplicate frame)', async () => {
    updateMock.mockReturnValueOnce(updateReturning([])).mockReturnValueOnce(updateReturning([]));
    selectMock.mockReturnValueOnce(selectRows([{ status: 'completed', exitCode: 0 }]));
    await commandResultHandlers.script!(scriptInput());
    expect(enqueueScriptVerifyMock).not.toHaveBeenCalled();
  });

  it('enqueues on the #3607 late-recovery rung too', async () => {
    updateMock
      .mockReturnValueOnce(updateReturning([]))
      .mockReturnValueOnce(updateReturning([{ id: EXECUTION_ID, scriptId: null, proposalId: PROPOSAL_ID }]));
    await commandResultHandlers.script!(scriptInput());
    expect(enqueueScriptVerifyMock).toHaveBeenCalledTimes(1);
  });

  it('never lets an enqueue failure break result ingestion', async () => {
    updateMock.mockReturnValueOnce(updateReturning([{ id: EXECUTION_ID, scriptId: null, proposalId: PROPOSAL_ID }]));
    enqueueScriptVerifyMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(commandResultHandlers.script!(scriptInput())).resolves.not.toThrow();
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});
