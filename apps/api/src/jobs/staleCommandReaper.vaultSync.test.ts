import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMock, failVaultMock, captureExceptionMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  failVaultMock: vi.fn(),
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

vi.mock('../services/vaultSyncPersistence', () => ({
  failVaultSyncWithoutResult: (...args: unknown[]) => failVaultMock(...(args as [])),
}));

import { propagateTimedOutDeviceCommand } from './staleCommandReaper';

const COMMAND_ID = '00000000-0000-4000-8000-0000000000aa';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000bb';
const VAULT_ID = '00000000-0000-4000-8000-0000000000cc';
const PAYLOAD = { vaultId: VAULT_ID, vaultPath: 'D:\\BreezeVault', snapshotId: 'snap-1' };

function timedOut(overrides: Record<string, unknown>) {
  return propagateTimedOutDeviceCommand({
    commandId: COMMAND_ID,
    payload: PAYLOAD,
    errorMsg: 'Server-side timeout: no response from agent after 30 minutes',
    completedAt: new Date('2026-11-14T12:00:00Z'),
    kind: 'timeout',
    deviceId: DEVICE_ID,
    ...overrides,
  } as never);
}

describe('staleCommandReaper vault_sync outcome (#11905)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) });
    failVaultMock.mockResolvedValue(true);
  });

  it('records the reaper reason on the vault a timed-out vault_sync names', async () => {
    await timedOut({ commandType: 'vault_sync' });

    expect(failVaultMock).toHaveBeenCalledTimes(1);
    expect(failVaultMock).toHaveBeenCalledWith({
      commandId: COMMAND_ID,
      payload: PAYLOAD,
      reason: 'Server-side timeout: no response from agent after 30 minutes',
      completedAt: new Date('2026-11-14T12:00:00Z'),
    });
  });

  it('also records an expired (or refused) vault_sync', async () => {
    await timedOut({
      commandType: 'vault_sync',
      kind: 'expired',
      errorMsg: 'Command was not delivered: destination unavailable',
    });
    expect(failVaultMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Command was not delivered: destination unavailable' }),
    );
  });

  it('does not touch vaults for other command types', async () => {
    await timedOut({ commandType: 'vault_configure' });
    expect(failVaultMock).not.toHaveBeenCalled();
  });

  it('contains a vault write failure so later propagation still runs', async () => {
    failVaultMock.mockRejectedValueOnce(new Error('db down'));
    await expect(timedOut({ commandType: 'vault_sync' })).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    // the deployment_results + restore_jobs updates still ran
    expect(updateMock).toHaveBeenCalledTimes(2);
  });
});
