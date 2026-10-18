import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateMock, releaseMock, captureExceptionMock } = vi.hoisted(() => ({
  updateMock: vi.fn(),
  releaseMock: vi.fn(),
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

vi.mock('../services/filesystemScanGenerationRelease', () => ({
  releaseFilesystemScanGenerationForCommand: (...args: unknown[]) => releaseMock(...(args as [])),
}));

import { propagateTimedOutDeviceCommand } from './staleCommandReaper';

const COMMAND_ID = '00000000-0000-4000-8000-0000000000aa';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000bb';

function timedOut(overrides: Record<string, unknown>) {
  return propagateTimedOutDeviceCommand({
    commandId: COMMAND_ID,
    payload: { path: 'C:\\' },
    errorMsg: 'Server-side timeout: no response from agent after 10 minutes',
    completedAt: new Date(),
    kind: 'timeout',
    deviceId: DEVICE_ID,
    ...overrides,
  } as never);
}

describe('staleCommandReaper filesystem_analysis scan generation (#9105)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve([]) }) });
    releaseMock.mockResolvedValue(undefined);
  });

  it('releases the scan generation when a filesystem_analysis command is timed out', async () => {
    await timedOut({ commandType: 'filesystem_analysis' });

    expect(releaseMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledWith(
      { id: COMMAND_ID, deviceId: DEVICE_ID, payload: { path: 'C:\\' } },
      'timeout',
    );
  });

  it('also releases when the command expired undelivered', async () => {
    await timedOut({ commandType: 'filesystem_analysis', kind: 'expired' });
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it('does not touch scan generations for other command types', async () => {
    await timedOut({ commandType: 'run_script' });
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('does nothing without a device id', async () => {
    await timedOut({ commandType: 'filesystem_analysis', deviceId: null });
    expect(releaseMock).not.toHaveBeenCalled();
  });

  it('contains a release failure so later propagation still runs', async () => {
    releaseMock.mockRejectedValueOnce(new Error('db down'));
    await expect(timedOut({ commandType: 'filesystem_analysis' })).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    // deployment_results + restore_jobs updates after the release still ran
    expect(updateMock).toHaveBeenCalledTimes(2);
  });
});
