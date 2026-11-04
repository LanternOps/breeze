import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { selectRows, enqueueMock, isConnectedMock, captureExceptionMock } = vi.hoisted(() => ({
  selectRows: { value: [] as unknown[] },
  enqueueMock: vi.fn(),
  isConnectedMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'where', 'orderBy', 'limit']) c[m] = () => c;
  c.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(onOk, onErr);
  return c;
}

vi.mock('../db', () => ({
  db: { select: () => chain(selectRows.value) },
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('./backupEnqueue', () => ({ enqueueBackupCatchUpDispatch: enqueueMock }));
vi.mock('../services/agentCommandRelay', () => ({ isAgentConnectedAnywhere: isConnectedMock }));
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

const {
  BACKUP_CATCH_UP_NOT_STARTED_ERROR,
  BACKUP_CATCH_UP_WINDOW_MS,
  BACKUP_MISSED_ERROR,
  catchUpExpiryReason,
  computeBackupCatchUpUntil,
  dispatchBackupCatchUpJobs,
  dispatchCatchUpsForConnectedDevices,
  isBackupCatchUpEnabled,
} = await import('./backupCatchUp');

const JOB = {
  jobId: 'job-1',
  configId: 'config-1',
  orgId: 'org-1',
  deviceId: 'device-1',
  catchUpUntil: new Date('2026-11-05T01:00:00.000Z'),
  configGeneration: 3,
};

describe('computeBackupCatchUpUntil', () => {
  const scheduledAt = new Date('2026-11-04T05:00:30.000Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(scheduledAt);
  });
  afterEach(() => vi.useRealTimers());

  it('is 20 h after the schedule for a daily policy, whose next run is further away', () => {
    expect(computeBackupCatchUpUntil({ frequency: 'daily', time: '05:00' }, scheduledAt, 'UTC'))
      .toBe('2026-11-05T01:00:30.000Z');
  });

  it('is 20 h for a weekly policy too', () => {
    expect(computeBackupCatchUpUntil({ frequency: 'weekly', time: '05:00', dayOfWeek: 3 }, scheduledAt, 'UTC'))
      .toBe('2026-11-05T01:00:30.000Z');
  });

  it('stops at the next run when that comes first', () => {
    // The schedule was edited to a later time today: the next run is 2 h away.
    expect(computeBackupCatchUpUntil({ frequency: 'daily', time: '07:00' }, scheduledAt, 'UTC'))
      .toBe('2026-11-04T07:00:00.000Z');
  });

  it('honours the policy timezone when finding the next run', () => {
    // 07:00 in UTC+2 is 05:00 UTC, so today's has passed and tomorrow's is past the 20 h cap.
    expect(computeBackupCatchUpUntil({ frequency: 'daily', time: '07:00' }, scheduledAt, 'Africa/Johannesburg'))
      .toBe(new Date(scheduledAt.getTime() + BACKUP_CATCH_UP_WINDOW_MS).toISOString());
  });
});

describe('catchUpExpiryReason', () => {
  const createdAt = new Date('2026-11-04T05:00:00.000Z');

  it('is Missed when the device was not seen after the schedule', () => {
    expect(catchUpExpiryReason(new Date('2026-11-04T04:00:00.000Z'), createdAt)).toBe(BACKUP_MISSED_ERROR);
    expect(catchUpExpiryReason(null, createdAt)).toBe(BACKUP_MISSED_ERROR);
  });

  it('is not Missed when the device came back and the catch-up still never started', () => {
    expect(catchUpExpiryReason(new Date('2026-11-04T09:00:00.000Z'), createdAt)).toBe(BACKUP_CATCH_UP_NOT_STARTED_ERROR);
  });
});

describe('isBackupCatchUpEnabled', () => {
  it.each([
    [{ frequency: 'daily' }, true],
    [{ frequency: 'daily', runMissedBackupsOnConnect: true }, true],
    [{ frequency: 'daily', runMissedBackupsOnConnect: false }, false],
    [null, true],
  ])('%j → %s', (schedule, expected) => {
    expect(isBackupCatchUpEnabled(schedule as never)).toBe(expected);
  });
});

describe('dispatchBackupCatchUpJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows.value = [];
    enqueueMock.mockResolvedValue('queued');
  });

  it('enqueues every deferred job of the device through the catch-up dispatch', async () => {
    selectRows.value = [JOB, { ...JOB, jobId: 'job-2' }];

    await expect(dispatchBackupCatchUpJobs('device-1')).resolves.toBe(2);

    expect(enqueueMock).toHaveBeenCalledWith(JOB);
    expect(enqueueMock).toHaveBeenCalledWith({ ...JOB, jobId: 'job-2' });
  });

  it('enqueues nothing for a device with nothing inside its window', async () => {
    await expect(dispatchBackupCatchUpJobs('device-1')).resolves.toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('keeps going past an enqueue failure and leaves that row for the next sweep', async () => {
    selectRows.value = [JOB, { ...JOB, jobId: 'job-2' }];
    enqueueMock.mockRejectedValueOnce(new Error('redis down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(dispatchBackupCatchUpJobs('device-1')).resolves.toBe(1);

    expect(enqueueMock).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('job-1'), expect.any(Error));
    // A failure that repeats every tick for 20 h must be visible, not log-only.
    expect(captureExceptionMock).toHaveBeenCalledWith(
      expect.any(Error), undefined, { backup_dispatch_issue: 'catch-up-enqueue-failed' },
    );
    errorSpy.mockRestore();
  });
});

describe('dispatchCatchUpsForConnectedDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueMock.mockResolvedValue('queued');
  });

  it('dispatches only for devices whose agent is really connected', async () => {
    selectRows.value = [
      { ...JOB, agentId: 'agent-on' },
      { ...JOB, jobId: 'job-2', deviceId: 'device-2', agentId: 'agent-off' },
    ];
    isConnectedMock.mockImplementation(async (id: string) => id === 'agent-on');

    await expect(dispatchCatchUpsForConnectedDevices()).resolves.toBe(1);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1' }));
  });

  it('checks a device with several deferred jobs once', async () => {
    selectRows.value = [
      { ...JOB, agentId: 'agent-on' },
      { ...JOB, jobId: 'job-2', agentId: 'agent-on' },
    ];
    isConnectedMock.mockResolvedValue(true);

    await expect(dispatchCatchUpsForConnectedDevices()).resolves.toBe(2);

    expect(isConnectedMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledTimes(2);
  });
});
