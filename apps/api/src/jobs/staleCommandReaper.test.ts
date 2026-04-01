import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, updateMock, deviceCommandsTable, restoreJobsTable } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  deviceCommandsTable: {
    id: 'device_commands.id',
    type: 'device_commands.type',
    status: 'device_commands.status',
    payload: 'device_commands.payload',
    createdAt: 'device_commands.created_at',
    executedAt: 'device_commands.executed_at',
    completedAt: 'device_commands.completed_at',
    result: 'device_commands.result',
  },
  restoreJobsTable: {
    id: 'restore_jobs.id',
    commandId: 'restore_jobs.command_id',
    status: 'restore_jobs.status',
    targetConfig: 'restore_jobs.target_config',
    completedAt: 'restore_jobs.completed_at',
    updatedAt: 'restore_jobs.updated_at',
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      select: (...args: unknown[]) => selectMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
    },
  };
});

vi.mock('../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema')>();
  return {
    ...actual,
    deviceCommands: deviceCommandsTable,
    restoreJobs: restoreJobsTable,
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { reapStaleDeviceCommands } from './staleCommandReaper';

function selectChain(resolvedValue: unknown) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'orderBy', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

describe('stale command reaper', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('propagates timeout failures into restore jobs for all restore command types', async () => {
    const staleCreatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    selectMock.mockReturnValueOnce(selectChain([
      {
        id: 'cmd-restore',
        type: 'backup_restore',
        status: 'pending',
        payload: null,
        createdAt: staleCreatedAt,
        executedAt: null,
      },
      {
        id: 'cmd-vm',
        type: 'vm_restore_from_backup',
        status: 'sent',
        payload: null,
        createdAt: staleCreatedAt,
        executedAt: staleCreatedAt,
      },
      {
        id: 'cmd-boot',
        type: 'vm_instant_boot',
        status: 'sent',
        payload: null,
        createdAt: staleCreatedAt,
        executedAt: staleCreatedAt,
      },
      {
        id: 'cmd-bmr',
        type: 'bmr_recover',
        status: 'pending',
        payload: null,
        createdAt: staleCreatedAt,
        executedAt: null,
      },
    ]));

    const deviceCommandReturning = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'cmd-restore' }])
      .mockResolvedValueOnce([{ id: 'cmd-vm' }])
      .mockResolvedValueOnce([{ id: 'cmd-boot' }])
      .mockResolvedValueOnce([{ id: 'cmd-bmr' }]);

    const deviceCommandSet = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: deviceCommandReturning,
      })),
    }));

    const restoreWhere = vi.fn().mockResolvedValue([]);
    const restoreSet = vi.fn(() => ({
      where: restoreWhere,
    }));

    updateMock.mockImplementation((table: unknown) => {
      if (table === deviceCommandsTable) {
        return { set: deviceCommandSet };
      }
      if (table === restoreJobsTable) {
        return { set: restoreSet };
      }
      throw new Error(`Unexpected table update: ${String(table)}`);
    });

    const reaped = await reapStaleDeviceCommands();

    expect(reaped).toBe(4);
    expect(deviceCommandReturning).toHaveBeenCalledTimes(4);
    expect(restoreWhere).toHaveBeenCalledTimes(4);
  });
});
