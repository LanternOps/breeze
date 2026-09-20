import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMock, setSpy } = vi.hoisted(() => {
  const setSpy = vi.fn((_fields: Record<string, unknown>) => ({ where: () => Promise.resolve([{ id: 'run-1' }]) }));
  return { updateMock: vi.fn(() => ({ set: setSpy })), setSpy };
});

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
}));
vi.mock('../db', () => ({ db: { update: updateMock, select: vi.fn(), insert: vi.fn() } }));
vi.mock('../db/schema', () => ({
  deploymentResults: { deviceCommandId: 'dr.deviceCommandId', status: 'dr.status' },
  deviceFilesystemCleanupRuns: { id: 'runs.id', status: 'runs.status', commandId: 'runs.commandId' },
}));
vi.mock('./automationActionResults', () => ({ applyAutomationActionTerminal: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./scriptExecutionTerminal', () => ({
  batchIdFromPayload: () => null,
  finalizeScriptExecutionTerminal: vi.fn(),
}));

import { propagateCancelledDeviceCommand } from './commandCancelPropagation';

const completedAt = new Date('2026-09-19T12:00:00Z');

beforeEach(() => { vi.clearAllMocks(); });

describe('system_cleanup_run cancel propagation (spec §13 #13)', () => {
  it('fails the owning run so it does not sit running on a moved device', async () => {
    const tx = { update: updateMock, select: vi.fn(), insert: vi.fn() } as never;
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1',
      type: 'system_cleanup_run',
      payload: { runId: 'run-1' },
      completedAt,
      executor: tx,
    });

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: 'Cancelled before the device received it',
    }));
  });

  // The caller's transaction is the org flip itself; joining it is the whole
  // point, so the branch must use `executor`, never the ambient db.
  it('writes through the caller transaction, not the ambient db', async () => {
    const txUpdate = vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) }));
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'system_cleanup_run', payload: { runId: 'run-1' }, completedAt,
      executor: { update: txUpdate, select: vi.fn(), insert: vi.fn() } as never,
    });
    expect(txUpdate).toHaveBeenCalled();
  });

  it('is inert without a usable runId', async () => {
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'system_cleanup_run', payload: {}, completedAt,
      executor: { update: updateMock, select: vi.fn(), insert: vi.fn() } as never,
    });
    for (const call of setSpy.mock.calls) {
      expect((call[0] as Record<string, unknown>).status).not.toBe('failed');
    }
  });

  it('leaves other command types alone', async () => {
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'file_delete', payload: { runId: 'run-1' }, completedAt,
      executor: { update: updateMock, select: vi.fn(), insert: vi.fn() } as never,
    });
    for (const call of setSpy.mock.calls) {
      expect((call[0] as Record<string, unknown>).error).not.toBe('Cancelled before the device received it');
    }
  });
});
