import { beforeEach, describe, expect, it, vi } from 'vitest';

const { failVaultMock, ambientUpdate } = vi.hoisted(() => ({
  failVaultMock: vi.fn(),
  ambientUpdate: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) })),
}));

vi.mock('../db', () => ({
  db: { update: ambientUpdate, select: vi.fn(), insert: vi.fn() },
  getCurrentDbAccessContext: () => undefined,
  runAfterDbContextExit: vi.fn(),
}));
vi.mock('./automationActionResults', () => ({ applyAutomationActionTerminal: vi.fn() }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('./scriptExecutionTerminal', () => ({
  batchIdFromPayload: () => null,
  finalizeScriptExecutionTerminal: vi.fn(),
}));
vi.mock('./vaultSyncPersistence', () => ({
  failVaultSyncWithoutResult: (...args: unknown[]) => failVaultMock(...(args as [])),
}));

import { propagateCancelledDeviceCommand } from './commandCancelPropagation';

const completedAt = new Date('2026-11-14T12:00:00Z');
const PAYLOAD = { vaultId: '00000000-0000-4000-8000-0000000000cc', snapshotId: 'snap-1' };

function executor() {
  return { update: vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) })), select: vi.fn(), insert: vi.fn() };
}

describe('vault_sync cancel propagation (#11905)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    failVaultMock.mockResolvedValue(true);
  });

  // The caller's transaction is the cancel itself (an org flip, the heartbeat
  // claim); the vault write must join it, never the ambient db.
  it("fails the vault through the caller's transaction", async () => {
    const tx = executor();
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'vault_sync', payload: PAYLOAD, completedAt, executor: tx as never,
    });

    expect(failVaultMock).toHaveBeenCalledTimes(1);
    expect(failVaultMock).toHaveBeenCalledWith({
      commandId: 'cmd-1',
      payload: PAYLOAD,
      reason: 'Cancelled before the device received it',
      completedAt,
      executor: tx,
    });
  });

  // Like every branch in that function: a failure rolls the caller's cancel
  // back rather than leaving a cancelled command beside a pending vault.
  it('propagates a vault write failure', async () => {
    failVaultMock.mockRejectedValueOnce(new Error('db down'));
    await expect(propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'vault_sync', payload: PAYLOAD, completedAt, executor: executor() as never,
    })).rejects.toThrow('db down');
  });

  it('does not touch vaults for other command types', async () => {
    await propagateCancelledDeviceCommand({
      commandId: 'cmd-1', type: 'vault_configure', payload: PAYLOAD, completedAt, executor: executor() as never,
    });
    expect(failVaultMock).not.toHaveBeenCalled();
  });
});
