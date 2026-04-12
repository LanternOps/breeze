import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn())
}));

vi.mock('../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema')>();
  return {
    ...actual,
    deviceCommands: {
      id: 'deviceCommands.id',
      deviceId: 'deviceCommands.deviceId',
      status: 'deviceCommands.status',
      createdAt: 'deviceCommands.createdAt',
      executedAt: 'deviceCommands.executedAt',
    },
    devices: {
      id: 'devices.id',
      status: 'devices.status',
      orgId: 'devices.orgId',
      hostname: 'devices.hostname',
    },
    auditLogs: {},
  };
});

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn(() => false),
}));

vi.mock('./sentry', () => ({
  captureException: vi.fn(),
}));

import { db } from '../db';
import { markCommandsSent, submitCommandResult, waitForCommandResult } from './commandQueue';

describe('command queue state transitions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('marks commands sent only from pending state', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where }),
    } as any);

    await markCommandsSent(['cmd-1']);

    expect(where).toHaveBeenCalledTimes(1);
  });

  it('submits command results only for sent commands', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where }),
    } as any);

    await submitCommandResult('cmd-1', { status: 'completed', stdout: 'ok' });

    expect(where).toHaveBeenCalledTimes(1);
  });

  it('times out pending commands too', async () => {
    vi.useFakeTimers();

    const limit = vi.fn()
      .mockResolvedValueOnce([{ id: 'cmd-1', status: 'pending', type: 'mssql_backup' }])
      .mockResolvedValueOnce([{ id: 'cmd-1', status: 'pending', type: 'mssql_backup' }])
      .mockResolvedValueOnce([{ id: 'cmd-1', status: 'pending', type: 'mssql_backup' }])
      .mockResolvedValueOnce([{ id: 'cmd-1', status: 'failed', result: { status: 'timeout' } }]);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit,
        }),
      }),
    } as any);

    const returning = vi.fn().mockResolvedValue([{ id: 'cmd-1', status: 'failed' }]);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning,
        }),
      }),
    } as any);

    const promise = waitForCommandResult('cmd-1', 250, 100);
    await vi.advanceTimersByTimeAsync(300);
    await promise;

    expect(returning).toHaveBeenCalledTimes(1);
  });
});
