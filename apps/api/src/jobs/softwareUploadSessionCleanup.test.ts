import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  addMock, getRepeatableJobsMock, removeRepeatableByKeyMock,
  selectMock, deleteMock, unlinkMock,
  withSystemDbAccessContextMock, capturedWorkerProcessor,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(async () => []),
  removeRepeatableByKeyMock: vi.fn(),
  selectMock: vi.fn(),
  deleteMock: vi.fn(),
  unlinkMock: vi.fn(async () => undefined),
  withSystemDbAccessContextMock: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  capturedWorkerProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(public name: string) {}
    add = (...args: unknown[]) => addMock(...(args as []));
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...(args as []));
    close = vi.fn();
  },
  Worker: class {
    constructor(public name: string, processor: (job: unknown) => Promise<unknown>) {
      capturedWorkerProcessor.current = processor;
    }
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));

vi.mock('node:fs/promises', () => ({ unlink: unlinkMock }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

// Wrap the condition builders in spies (behavior preserved, same pattern as
// software.test.ts) so tests can assert BOTH reap conditions — idle and
// absolute age — are built, independently, with the right cutoffs.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return { ...actual, lt: vi.fn(actual.lt), or: vi.fn(actual.or) };
});
import { lt, or } from 'drizzle-orm';

vi.mock('../db', () => ({
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => withSystemDbAccessContextMock(fn),
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  },
}));

vi.mock('../db/schema', () => ({
  softwareUploadSessions: {
    id: 'id', tempPath: 'temp_path',
    lastActivityAt: 'last_activity_at', createdAt: 'created_at',
  },
}));

import { captureException } from '../services/sentry';
import {
  initializeSoftwareUploadSessionCleanupWorker,
  __testOnly,
} from './softwareUploadSessionCleanup';

describe('softwareUploadSessionCleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    getRepeatableJobsMock.mockResolvedValue([]);
    delete process.env.SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED;
    delete process.env.SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS;
    delete process.env.SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS;
  });

  it('registers an hourly repeatable job with a fixed jobId', async () => {
    await initializeSoftwareUploadSessionCleanupWorker();
    expect(addMock).toHaveBeenCalledWith(
      __testOnly.JOB_NAME,
      {},
      expect.objectContaining({
        jobId: __testOnly.REPEAT_JOB_ID,
        repeat: { pattern: __testOnly.HOURLY_CRON },
      }),
    );
  });

  it('skips scheduling when disabled via env', async () => {
    process.env.SOFTWARE_UPLOAD_SESSION_CLEANUP_ENABLED = 'false';
    await initializeSoftwareUploadSessionCleanupWorker();
    expect(addMock).not.toHaveBeenCalled();
  });

  it('deletes the stale rows (conditionally) then unlinks each returned temp file, at system scope', async () => {
    await initializeSoftwareUploadSessionCleanupWorker();
    const stale = [
      { id: 's-1', tempPath: '/tmp/breeze-uploads/session-s-1.part' },
      { id: 's-2', tempPath: '/tmp/breeze-uploads/session-s-2.part' },
    ];
    selectMock.mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve(stale) }),
    });
    deleteMock.mockReturnValueOnce({
      where: () => ({ returning: () => Promise.resolve(stale) }),
    });

    const result = await capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME });
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledTimes(2);
    expect(unlinkMock).toHaveBeenCalledWith('/tmp/breeze-uploads/session-s-1.part');
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ deletedCount: 2 });
    // The SELECT and the DELETE share the same computed reap condition
    // (built once, reused) rather than each calling or(...) independently.
    expect(or).toHaveBeenCalledTimes(1);
  });

  it('reports a non-ENOENT unlink failure via captureException but still deletes the row', async () => {
    await initializeSoftwareUploadSessionCleanupWorker();
    const stale = [{ id: 's-1', tempPath: '/tmp/breeze-uploads/session-s-1.part' }];
    selectMock.mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve(stale) }),
    });
    deleteMock.mockReturnValueOnce({
      where: () => ({ returning: () => Promise.resolve(stale) }),
    });
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    unlinkMock.mockRejectedValueOnce(eacces);

    const result = await capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME });

    expect(captureException).toHaveBeenCalledWith(eacces);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ deletedCount: 1 });
  });

  it('a missing temp file (ENOENT) is treated as success, not reported', async () => {
    await initializeSoftwareUploadSessionCleanupWorker();
    const stale = [{ id: 's-1', tempPath: '/tmp/breeze-uploads/session-s-1.part' }];
    selectMock.mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve(stale) }),
    });
    deleteMock.mockReturnValueOnce({
      where: () => ({ returning: () => Promise.resolve(stale) }),
    });
    const enoent = Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
    unlinkMock.mockRejectedValueOnce(enoent);

    const result = await capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME });

    expect(captureException).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deletedCount: 1 });
  });

  it('a session revived between SELECT and DELETE (conditional delete matches fewer rows) is neither deleted nor unlinked for the survivor', async () => {
    await initializeSoftwareUploadSessionCleanupWorker();
    const stale = [
      { id: 's-1', tempPath: '/tmp/breeze-uploads/session-s-1.part' },
      { id: 's-2', tempPath: '/tmp/breeze-uploads/session-s-2.part' },
    ];
    selectMock.mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve(stale) }),
    });
    // s-2's last_activity_at advanced past the idle cutoff between the
    // SELECT and the DELETE (a legitimate chunk append resumed it) — the
    // conditional DELETE's repeated cutoff predicate excludes it from the
    // returned rows, simulating that race.
    deleteMock.mockReturnValueOnce({
      where: () => ({ returning: () => Promise.resolve([stale[0]]) }),
    });

    const result = await capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME });

    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledWith('/tmp/breeze-uploads/session-s-1.part');
    expect(unlinkMock).not.toHaveBeenCalledWith('/tmp/breeze-uploads/session-s-2.part');
    expect(result).toMatchObject({ deletedCount: 1 });
  });

  it('reaps on BOTH ceilings independently: idle (2h, last_activity_at) OR absolute age (24h, created_at)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T12:00:00.000Z'));
    await initializeSoftwareUploadSessionCleanupWorker();
    selectMock.mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve([]) }),
    });

    await capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME });

    // Idle condition: last_activity_at < now - 2h.
    expect(lt).toHaveBeenCalledWith(
      'last_activity_at',
      new Date('2026-08-02T10:00:00.000Z'),
    );
    // Absolute-lifetime condition: created_at < now - 24h — fires even for a
    // session that keeps itself warm forever.
    expect(lt).toHaveBeenCalledWith(
      'created_at',
      new Date('2026-08-01T12:00:00.000Z'),
    );
    // The two conditions are OR'd — either alone is sufficient to reap.
    expect(or).toHaveBeenCalledTimes(1);
  });

  it('honors both env knobs independently', async () => {
    process.env.SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS = '6';
    process.env.SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS = '48';
    expect(__testOnly.getIdleTtlHours()).toBe(6);
    expect(__testOnly.getMaxAgeHours()).toBe(48);

    process.env.SOFTWARE_UPLOAD_SESSION_IDLE_TTL_HOURS = 'garbage';
    process.env.SOFTWARE_UPLOAD_SESSION_MAX_AGE_HOURS = '-1';
    expect(__testOnly.getIdleTtlHours()).toBe(__testOnly.DEFAULT_IDLE_TTL_HOURS);
    expect(__testOnly.getMaxAgeHours()).toBe(__testOnly.DEFAULT_MAX_AGE_HOURS);
  });

  it('is a no-op when nothing is stale', async () => {
    await initializeSoftwareUploadSessionCleanupWorker();
    selectMock.mockReturnValueOnce({
      from: () => ({ where: () => Promise.resolve([]) }),
    });
    const result = await capturedWorkerProcessor.current!({ name: __testOnly.JOB_NAME });
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ deletedCount: 0 });
  });
});
