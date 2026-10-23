import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMock, finalizeMock, captureExceptionMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  finalizeMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: { ...actual.db, update: (...args: unknown[]) => updateMock(...(args as [])) },
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...(args as [])),
}));

vi.mock('../services/incidentContainmentResults', () => ({
  finalizeContainmentAction: (...args: unknown[]) => finalizeMock(...(args as [])),
  // Reached through the command-queue graph's result-handler registry.
  handleExecuteContainmentResult: vi.fn(),
}));

import { propagateTimedOutDeviceCommand } from './staleCommandReaper';

const COMMAND_ID = '00000000-0000-4000-8000-0000000000aa';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000bb';
const PAYLOAD = { incidentId: '00000000-0000-4000-8000-0000000000cc', actionType: 'process_kill' };
const COMPLETED_AT = new Date('2026-10-22T12:00:00Z');

function timedOut(overrides: Record<string, unknown>) {
  return propagateTimedOutDeviceCommand({
    commandId: COMMAND_ID,
    payload: PAYLOAD,
    errorMsg: 'Server-side timeout: no response from agent after 10 minutes',
    completedAt: COMPLETED_AT,
    kind: 'timeout',
    deviceId: DEVICE_ID,
    ...overrides,
  } as never);
}

describe('staleCommandReaper execute_containment follow-through (#9662)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) });
    finalizeMock.mockResolvedValue('applied');
  });

  it('fails the incident action as a server timeout', async () => {
    await timedOut({ commandType: 'execute_containment' });
    expect(finalizeMock).toHaveBeenCalledWith({
      commandId: COMMAND_ID,
      payload: PAYLOAD,
      outcome: { kind: 'timeout', error: 'Server-side timeout: no response from agent after 10 minutes' },
      completedAt: COMPLETED_AT,
    });
  });

  it('also finalizes a command that expired undelivered', async () => {
    await timedOut({ commandType: 'execute_containment', kind: 'expired' });
    expect(finalizeMock).toHaveBeenCalledTimes(1);
  });

  it('leaves other command types alone', async () => {
    await timedOut({ commandType: 'collect_evidence' });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('contains a finalize failure (reported, not thrown)', async () => {
    finalizeMock.mockRejectedValue(new Error('db down'));
    await expect(timedOut({ commandType: 'execute_containment' })).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
