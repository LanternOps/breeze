import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, updateMock, deviceCommandsTable, restoreJobsTable, backupJobsTable, devicesTable, queueBackupStopCommandMock } = vi.hoisted(() => ({
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
  backupJobsTable: {
    id: 'backup_jobs.id',
    deviceId: 'backup_jobs.device_id',
    status: 'backup_jobs.status',
    lastProgressAt: 'backup_jobs.last_progress_at',
    startedAt: 'backup_jobs.started_at',
    createdAt: 'backup_jobs.created_at',
    completedAt: 'backup_jobs.completed_at',
    updatedAt: 'backup_jobs.updated_at',
    errorLog: 'backup_jobs.error_log',
  },
  devicesTable: {
    id: 'devices.id',
    status: 'devices.status',
    lastSeenAt: 'devices.last_seen_at',
  },
  queueBackupStopCommandMock: vi.fn(),
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
    backupJobs: backupJobsTable,
    devices: devicesTable,
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/commandQueue')>();
  return {
    ...actual,
    queueBackupStopCommand: (...args: unknown[]) => queueBackupStopCommandMock(...(args as [])),
  };
});

import { reapStaleDeviceCommands, reapStaleBackupJobs } from './staleCommandReaper';

function selectChain(resolvedValue: unknown) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

function backupUpdateChain(returningValue: unknown) {
  return {
    set: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue(returningValue),
      })),
    })),
  };
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

describe('reapStaleBackupJobs', () => {
  const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000);

  beforeEach(() => {
    vi.resetAllMocks();
    queueBackupStopCommandMock.mockResolvedValue({ command: {} });
  });

  it('reaps a stalled running job (rule A) on an online device and queues a stop command', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-stall',
          deviceId: 'device-1',
          lastProgressAt: minutesAgo(20),
          startedAt: minutesAgo(40),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'job-stall' }]),
      })),
    }));
    updateMock.mockImplementation((table: unknown) => {
      if (table !== backupJobsTable) throw new Error(`Unexpected table update: ${String(table)}`);
      return { set: setMock };
    });

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorLog: 'Backup stalled: no progress reported for 15 minutes',
      })
    );
    expect(queueBackupStopCommandMock).toHaveBeenCalledWith('device-1', {});
  });

  it('reaps a running job whose device went offline (rule B) and does NOT queue a stop command', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-offline',
          deviceId: 'device-2',
          lastProgressAt: minutesAgo(12),
          startedAt: minutesAgo(30),
          errorLog: null,
          deviceStatus: 'offline',
          deviceLastSeenAt: minutesAgo(12),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'job-offline' }]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorLog: 'Device went offline during backup',
      })
    );
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });

  it('reaps a legacy running job with no progress signal past the absolute cap (rule C)', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-legacy',
          deviceId: 'device-3',
          lastProgressAt: null,
          startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
          errorLog: 'previous warning',
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'job-legacy' }]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorLog: 'previous warning\nBackup timed out (no completion after 24h)',
      })
    );
    expect(queueBackupStopCommandMock).toHaveBeenCalledWith('device-3', {});
  });

  it('does not reap a healthy running job with recent progress', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-healthy',
          deviceId: 'device-4',
          lastProgressAt: minutesAgo(2),
          startedAt: minutesAgo(30),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });

  it('does not reap a recent legacy job (no progress, 2h old, device online)', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-recent-legacy',
          deviceId: 'device-5',
          lastProgressAt: null,
          startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('reaps a pending job stuck past the pending timeout', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-pending-stuck',
          errorLog: null,
          createdAt: minutesAgo(90),
        },
      ]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'job-pending-stuck' }]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(1);
    expect(setMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorLog: 'Backup dispatch never completed',
      })
    );
  });

  it('does not reap a pending job under an hour old', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([]))
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-pending-fresh',
          errorLog: null,
          createdAt: minutesAgo(30),
        },
      ]));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(0);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('queues a stop command only for the online device among multiple reaped jobs', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-online',
          deviceId: 'device-online',
          lastProgressAt: minutesAgo(20),
          startedAt: minutesAgo(40),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
        {
          id: 'job-offline-2',
          deviceId: 'device-offline',
          lastProgressAt: minutesAgo(20),
          startedAt: minutesAgo(40),
          errorLog: null,
          deviceStatus: 'offline',
          deviceLastSeenAt: minutesAgo(20),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn().mockResolvedValue([{ id: 'reaped' }]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(2);
    expect(queueBackupStopCommandMock).toHaveBeenCalledTimes(1);
    expect(queueBackupStopCommandMock).toHaveBeenCalledWith('device-online', {});
  });

  it('does not double-count or queue a stop command when a concurrent completion wins (terminal-status guard)', async () => {
    selectMock
      .mockReturnValueOnce(selectChain([
        {
          id: 'job-race',
          deviceId: 'device-6',
          lastProgressAt: minutesAgo(20),
          startedAt: minutesAgo(40),
          errorLog: null,
          deviceStatus: 'online',
          deviceLastSeenAt: minutesAgo(0.1),
        },
      ]))
      .mockReturnValueOnce(selectChain([]));

    const setMock = vi.fn(() => ({
      where: vi.fn(() => ({
        // Simulates the job already having transitioned to a terminal status
        // (e.g. 'completed') between the select and this guarded update.
        returning: vi.fn().mockResolvedValue([]),
      })),
    }));
    updateMock.mockImplementation(() => ({ set: setMock }));

    const reaped = await reapStaleBackupJobs();

    expect(reaped).toBe(0);
    expect(queueBackupStopCommandMock).not.toHaveBeenCalled();
  });
});
