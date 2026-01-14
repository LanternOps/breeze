import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  queueCommand,
  waitForCommandResult,
  executeCommand,
  getPendingCommands,
  markCommandsSent,
  submitCommandResult
} from './commandQueue';
import { db } from '../db';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn()
  }
}));

vi.mock('../db/schema', () => ({
  deviceCommands: {
    id: 'id',
    deviceId: 'deviceId',
    status: 'status',
    createdAt: 'createdAt'
  },
  devices: {
    id: 'id',
    status: 'status'
  }
}));

describe('command queue service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should queue a command for a device', async () => {
    const queued = {
      id: 'cmd-1',
      deviceId: 'dev-1',
      type: 'list_processes',
      payload: { filter: 'chrome' },
      status: 'pending',
      createdBy: 'user-1',
      createdAt: new Date(),
      executedAt: null,
      completedAt: null,
      result: null
    };

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([queued])
      })
    } as any);

    const result = await queueCommand('dev-1', 'list_processes', { filter: 'chrome' }, 'user-1');

    expect(result).toEqual(queued);
    expect(db.insert).toHaveBeenCalled();
  });

  it('should return a completed command after polling', async () => {
    vi.useFakeTimers();
    const pending = {
      id: 'cmd-2',
      status: 'pending'
    };
    const completed = {
      id: 'cmd-2',
      status: 'completed',
      result: { status: 'completed', stdout: 'ok' }
    };

    const limitMock = vi.fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([completed]);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: limitMock
        })
      })
    } as any);

    const promise = waitForCommandResult('cmd-2', 1000, 100);
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result).toEqual(completed);
    expect(limitMock).toHaveBeenCalledTimes(2);
  });

  it('should mark commands as failed on timeout', async () => {
    vi.useFakeTimers();
    const pending = { id: 'cmd-3', status: 'pending' };
    const timedOut = {
      id: 'cmd-3',
      status: 'failed',
      result: { status: 'timeout' }
    };

    const limitMock = vi.fn()
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([timedOut]);

    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined)
    });

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: limitMock
        })
      })
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: updateSet
    } as any);

    const promise = waitForCommandResult('cmd-3', 250, 100);
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    expect(result).toEqual(timedOut);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      result: expect.objectContaining({ status: 'timeout' })
    }));
  });

  it('should return failed when device does not exist', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([])
        })
      })
    } as any);

    const result = await executeCommand('missing-device', 'list_services');

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Device not found');
  });

  it('should queue and return a completed result for online devices', async () => {
    const device = { id: 'dev-2', status: 'online' };
    const queued = { id: 'cmd-4' };
    const completed = {
      id: 'cmd-4',
      status: 'completed',
      result: { status: 'completed', stdout: 'done' }
    };

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([device])
          })
        })
      } as any)
      .mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([completed])
          })
        })
      } as any);

    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([queued])
      })
    } as any);

    const result = await executeCommand('dev-2', 'list_services');

    expect(result).toEqual(completed.result);
  });

  it('should return pending commands for a device', async () => {
    const commands = [{ id: 'cmd-5' }, { id: 'cmd-6' }];
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(commands)
          })
        })
      })
    } as any);

    const result = await getPendingCommands('dev-3', 2);

    expect(result).toEqual(commands);
  });

  it('should mark commands as sent', async () => {
    const whereMock = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: whereMock });

    vi.mocked(db.update).mockReturnValue({
      set: updateSet
    } as any);

    await markCommandsSent(['cmd-7', 'cmd-8']);

    expect(updateSet).toHaveBeenCalledTimes(2);
    expect(whereMock).toHaveBeenCalledTimes(2);
  });

  it('should submit command result with completed status', async () => {
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined)
    });

    vi.mocked(db.update).mockReturnValue({
      set: updateSet
    } as any);

    await submitCommandResult('cmd-9', { status: 'completed', stdout: 'ok' });

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      result: expect.objectContaining({ status: 'completed' })
    }));
  });
});
