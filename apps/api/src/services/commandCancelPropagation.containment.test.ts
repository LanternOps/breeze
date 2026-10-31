import { beforeEach, describe, expect, it, vi } from 'vitest';

const { finalizeMock } = vi.hoisted(() => ({ finalizeMock: vi.fn() }));

vi.mock('../db', () => ({
  db: { update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) })), select: vi.fn(), insert: vi.fn() },
  getCurrentDbAccessContext: () => undefined,
  runAfterDbContextExit: vi.fn(),
}));
vi.mock('./automationActionResults', () => ({ applyAutomationActionTerminal: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./incidentContainmentResults', () => ({
  finalizeContainmentAction: (...args: unknown[]) => finalizeMock(...(args as [])),
}));

import { propagateCancelledDeviceCommand } from './commandCancelPropagation';

const completedAt = new Date('2026-10-22T12:00:00Z');
const payload = { incidentId: '00000000-0000-4000-8000-0000000000cc' };

beforeEach(() => {
  vi.clearAllMocks();
  finalizeMock.mockResolvedValue('applied');
});

describe('execute_containment cancel propagation (#9662)', () => {
  it('cancels the incident action through the caller transaction', async () => {
    const tx = { update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) })), select: vi.fn(), insert: vi.fn() };
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'execute_containment', payload, completedAt, executor: tx as never,
    });
    expect(finalizeMock).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      payload,
      outcome: { kind: 'cancelled', error: 'Cancelled before the device received it' },
      completedAt,
      executor: tx,
    });
  });

  it('propagates a finalize failure so the caller rolls the cancel back', async () => {
    finalizeMock.mockRejectedValue(new Error('db down'));
    await expect(propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'execute_containment', payload, completedAt,
    })).rejects.toThrow('db down');
  });

  it('never changes the isolation episode or its action when a transport command is cancelled', async () => {
    await propagateCancelledDeviceCommand({ commandId: 'cmd-1', type: 'execute_containment', payload: { ...payload, actionType: 'network_isolation' }, completedAt });
    expect(finalizeMock).not.toHaveBeenCalled();
  });

  it('is not consulted for other command types', async () => {
    await propagateCancelledDeviceCommand({ commandId: 'cmd-1', type: 'script', payload: {}, completedAt });
    expect(finalizeMock).not.toHaveBeenCalled();
  });
});
