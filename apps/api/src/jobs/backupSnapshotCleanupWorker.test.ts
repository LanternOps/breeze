import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #12061: expired-snapshot cleanup used to run on the shared 5-slot `backup`
// worker. Runs longer than the 6-hour schedule filled every slot, and backup
// dispatch, result processing and schedule checks stalled for every org.

const bullmq = vi.hoisted(() => ({
  workers: [] as Array<{ name: string; processor: (job: unknown) => Promise<unknown>; opts: Record<string, unknown> }>,
  queue: {
    add: vi.fn(),
    getRepeatableJobs: vi.fn(),
    removeRepeatableByKey: vi.fn(),
    close: vi.fn(),
  },
}));
vi.mock('bullmq', () => ({
  Queue: vi.fn(function Queue() { return bullmq.queue; }),
  Worker: vi.fn(function Worker(name: string, processor: (job: unknown) => Promise<unknown>, opts: Record<string, unknown>) {
    bullmq.workers.push({ name, processor, opts });
    return { on: vi.fn(), close: vi.fn() };
  }),
}));

const legacyBackupQueue = vi.hoisted(() => ({
  getRepeatableJobs: vi.fn(),
  removeRepeatableByKey: vi.fn(),
}));
vi.mock('./backupEnqueue', () => ({ getBackupQueue: () => legacyBackupQueue }));

// Minimal in-memory Redis: enough for SET NX PX, GET, DEL and the two lease scripts.
const redisStore = vi.hoisted(() => new Map<string, string>());
const redisFake = vi.hoisted(() => ({
  set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    if (args.includes('NX') && redisStore.has(key)) return null;
    redisStore.set(key, value);
    return 'OK';
  }),
  get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  del: vi.fn(async (key: string) => (redisStore.delete(key) ? 1 : 0)),
  eval: vi.fn(async (script: string, _numKeys: number, key: string, token: string) => {
    if (redisStore.get(key) !== token) return 0;
    if (script.includes('DEL')) redisStore.delete(key);
    return 1;
  }),
}));
vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
  getRedis: vi.fn(() => redisFake),
}));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
const captureExceptionMock = vi.hoisted(() => vi.fn());
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));

const processCleanupMock = vi.hoisted(() => vi.fn());
vi.mock('./backupSnapshotCleanup', () => ({ processCleanupExpiredSnapshots: processCleanupMock }));
const checkpointGcMock = vi.hoisted(() => vi.fn());
vi.mock('../services/backupTreeCheckpointGc', () => ({ collectUnreferencedCheckpoints: checkpointGcMock }));

import {
  BACKUP_SNAPSHOT_CLEANUP_QUEUE,
  BACKUP_SNAPSHOT_CLEANUP_LEASE_KEY,
  BACKUP_SNAPSHOT_CLEANUP_CURSOR_KEYS,
  initializeBackupSnapshotCleanupWorker,
  shutdownBackupSnapshotCleanupWorker,
  resolveBackupSnapshotCleanupTimeBudgetMs,
  __testOnly,
} from './backupSnapshotCleanupWorker';
import { jobSchedule } from './scheduleRegistry';

const cleanupJob = { name: 'cleanup-expired-snapshots', data: { type: 'cleanup-expired-snapshots' } } as never;

describe('backupSnapshotCleanupWorker (#12061)', () => {
  beforeEach(() => {
    bullmq.workers.length = 0;
    bullmq.queue.add.mockReset().mockResolvedValue({ repeatJobKey: 'new-key' });
    bullmq.queue.getRepeatableJobs.mockReset().mockResolvedValue([]);
    bullmq.queue.removeRepeatableByKey.mockReset();
    legacyBackupQueue.getRepeatableJobs.mockReset().mockResolvedValue([]);
    legacyBackupQueue.removeRepeatableByKey.mockReset();
    redisStore.clear();
    processCleanupMock.mockReset().mockResolvedValue({ deleted: 0 });
    checkpointGcMock.mockReset().mockResolvedValue({ deleted: 0, refused: 0 });
    redisFake.eval.mockClear();
    captureExceptionMock.mockReset();
    delete process.env.BACKUP_SNAPSHOT_CLEANUP_CRON;
    delete process.env.BACKUP_SNAPSHOT_CLEANUP_TIME_BUDGET_MS;
  });

  afterEach(async () => {
    await shutdownBackupSnapshotCleanupWorker();
    delete process.env.BACKUP_SNAPSHOT_CLEANUP_CRON;
    delete process.env.BACKUP_SNAPSHOT_CLEANUP_TIME_BUDGET_MS;
  });

  describe('queue isolation', () => {
    it('runs on its own queue with a single slot, never the shared backup queue', async () => {
      await initializeBackupSnapshotCleanupWorker();

      expect(BACKUP_SNAPSHOT_CLEANUP_QUEUE).not.toBe('backup');
      expect(bullmq.workers).toHaveLength(1);
      expect(bullmq.workers[0]!.name).toBe(BACKUP_SNAPSHOT_CLEANUP_QUEUE);
      expect(bullmq.workers[0]!.opts.concurrency).toBe(1);
    });

    it('removes the cleanup schedule a previous version registered on the shared backup queue', async () => {
      legacyBackupQueue.getRepeatableJobs.mockResolvedValue([
        { name: 'cleanup-expired-snapshots', key: 'legacy-cleanup' },
        { name: 'check-schedules', key: 'keep-me' },
      ]);

      await initializeBackupSnapshotCleanupWorker();

      expect(legacyBackupQueue.removeRepeatableByKey).toHaveBeenCalledTimes(1);
      expect(legacyBackupQueue.removeRepeatableByKey).toHaveBeenCalledWith('legacy-cleanup');
    });

    it('still schedules cleanup when removing the legacy schedule fails', async () => {
      legacyBackupQueue.getRepeatableJobs.mockRejectedValue(new Error('redis timeout'));

      await expect(initializeBackupSnapshotCleanupWorker()).resolves.toBeUndefined();

      expect(bullmq.queue.add).toHaveBeenCalledTimes(1);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('schedule', () => {
    it('uses the registry slot by default', async () => {
      await initializeBackupSnapshotCleanupWorker();

      expect(bullmq.queue.add).toHaveBeenCalledWith(
        'cleanup-expired-snapshots',
        expect.objectContaining({ type: 'cleanup-expired-snapshots' }),
        expect.objectContaining({ repeat: { pattern: jobSchedule('backup-expired-snapshot-cleanup') } }),
      );
    });

    it('honors BACKUP_SNAPSHOT_CLEANUP_CRON', async () => {
      process.env.BACKUP_SNAPSHOT_CLEANUP_CRON = '17 3 * * *';

      await initializeBackupSnapshotCleanupWorker();

      expect(bullmq.queue.add).toHaveBeenCalledWith(
        'cleanup-expired-snapshots',
        expect.anything(),
        expect.objectContaining({ repeat: { pattern: '17 3 * * *' } }),
      );
    });

    it('BACKUP_SNAPSHOT_CLEANUP_CRON=off registers no schedule and removes an existing one', async () => {
      process.env.BACKUP_SNAPSHOT_CLEANUP_CRON = 'off';
      bullmq.queue.getRepeatableJobs.mockResolvedValue([{ name: 'cleanup-expired-snapshots', key: 'old-key' }]);

      await initializeBackupSnapshotCleanupWorker();

      expect(bullmq.queue.add).not.toHaveBeenCalled();
      expect(bullmq.queue.removeRepeatableByKey).toHaveBeenCalledWith('old-key');
    });

    it('removes a stale schedule left by a previous cron value', async () => {
      bullmq.queue.getRepeatableJobs.mockResolvedValue([
        { name: 'cleanup-expired-snapshots', key: 'stale-key' },
        { name: 'cleanup-expired-snapshots', key: 'new-key' },
      ]);

      await initializeBackupSnapshotCleanupWorker();

      expect(bullmq.queue.removeRepeatableByKey).toHaveBeenCalledTimes(1);
      expect(bullmq.queue.removeRepeatableByKey).toHaveBeenCalledWith('stale-key');
    });
  });

  describe('one run at a time', () => {
    it('skips the run while another run holds the lease, without touching the lease', async () => {
      redisStore.set(BACKUP_SNAPSHOT_CLEANUP_LEASE_KEY, 'other-run');

      const result = await __testOnly.processCleanupJob(cleanupJob);

      expect(result).toEqual({ skipped: 'already-running' });
      expect(processCleanupMock).not.toHaveBeenCalled();
      expect(redisStore.get(BACKUP_SNAPSHOT_CLEANUP_LEASE_KEY)).toBe('other-run');
    });

    it('a second run started while the first is still going is skipped', async () => {
      let finishFirst!: () => void;
      processCleanupMock.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = () => resolve({ deleted: 1 }); }));

      const first = __testOnly.processCleanupJob(cleanupJob);
      await vi.waitFor(() => expect(processCleanupMock).toHaveBeenCalledTimes(1));
      const second = await __testOnly.processCleanupJob(cleanupJob);
      finishFirst();

      expect(second).toEqual({ skipped: 'already-running' });
      await expect(first).resolves.toEqual({ deleted: 1, checkpointGc: { deleted: 0, refused: 0 } });
      expect(processCleanupMock).toHaveBeenCalledTimes(1);
      // The first run released its lease, so the next scheduled run proceeds.
      expect(redisStore.has(BACKUP_SNAPSHOT_CLEANUP_LEASE_KEY)).toBe(false);
    });

    describe('lease renewal', () => {
      afterEach(() => {
        vi.useRealTimers();
      });

      const renewCalls = () => redisFake.eval.mock.calls.filter(([script]) => String(script).includes('PEXPIRE')).length;

      it('renews while the run is within its ceiling, then stops renewing and reports a run that looks hung', async () => {
        vi.useFakeTimers();
        process.env.BACKUP_SNAPSHOT_CLEANUP_TIME_BUDGET_MS = '600000'; // 10 min budget -> 20 min lease ceiling
        processCleanupMock.mockImplementationOnce(() => new Promise(() => {})); // hangs

        void __testOnly.processCleanupJob(cleanupJob);
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(renewCalls()).toBe(1);
        expect(captureExceptionMock).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(20 * 60_000);
        const renewedBeforeCeiling = renewCalls();
        expect(renewedBeforeCeiling).toBe(10);
        expect(captureExceptionMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(renewCalls()).toBe(renewedBeforeCeiling);
      });

      it('reports a lost lease', async () => {
        vi.useFakeTimers();
        processCleanupMock.mockImplementationOnce(() => new Promise(() => {}));

        void __testOnly.processCleanupJob(cleanupJob);
        await vi.waitFor(() => expect(processCleanupMock).toHaveBeenCalledTimes(1));
        redisStore.set(BACKUP_SNAPSHOT_CLEANUP_LEASE_KEY, 'someone-else');
        await vi.advanceTimersByTimeAsync(2 * 60_000);

        expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      });
    });

    it('releases the lease when the run fails', async () => {
      processCleanupMock.mockRejectedValueOnce(new Error('row delete failed'));

      await expect(__testOnly.processCleanupJob(cleanupJob)).rejects.toThrow('row delete failed');
      expect(redisStore.has(BACKUP_SNAPSHOT_CLEANUP_LEASE_KEY)).toBe(false);
    });
  });

  describe('checkpoint GC (#11736 step 2)', () => {
    it('runs after retention, until the end of the time budget, and reports its counts', async () => {
      process.env.BACKUP_SNAPSHOT_CLEANUP_TIME_BUDGET_MS = '600000';
      checkpointGcMock.mockResolvedValueOnce({ deleted: 3, refused: 1 });
      const before = Date.now();

      const result = await __testOnly.processCleanupJob(cleanupJob);

      expect(result).toEqual({ deleted: 0, checkpointGc: { deleted: 3, refused: 1 } });
      expect(checkpointGcMock).toHaveBeenCalledTimes(1);
      expect(checkpointGcMock.mock.invocationCallOrder[0]!).toBeGreaterThan(processCleanupMock.mock.invocationCallOrder[0]!);
      const { deadlineMs } = checkpointGcMock.mock.calls[0]![0] as { deadlineMs: number };
      expect(deadlineMs).toBeGreaterThanOrEqual(before + 600_000);
      expect(deadlineMs).toBeLessThanOrEqual(Date.now() + 600_000);
    });

    it('a GC failure is reported and does not fail the run retention already did', async () => {
      checkpointGcMock.mockRejectedValueOnce(new Error('statement timeout'));
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await __testOnly.processCleanupJob(cleanupJob);

        expect(result).toEqual({ deleted: 0, checkpointGc: 'error' });
        expect(captureExceptionMock).toHaveBeenCalledTimes(1);
        expect(redisStore.has(BACKUP_SNAPSHOT_CLEANUP_LEASE_KEY)).toBe(false);
      } finally {
        error.mockRestore();
      }
    });

    it('does not run when retention failed', async () => {
      processCleanupMock.mockRejectedValueOnce(new Error('row delete failed'));
      await expect(__testOnly.processCleanupJob(cleanupJob)).rejects.toThrow('row delete failed');
      expect(checkpointGcMock).not.toHaveBeenCalled();
    });
  });

  describe('bounded, resumable runs', () => {
    it('passes the saved cursors and a deadline inside the time budget, then saves the new cursors', async () => {
      process.env.BACKUP_SNAPSHOT_CLEANUP_TIME_BUDGET_MS = '600000';
      redisStore.set(BACKUP_SNAPSHOT_CLEANUP_CURSOR_KEYS.retention, 'org-b');
      redisStore.set(BACKUP_SNAPSHOT_CLEANUP_CURSOR_KEYS.gc, 'gc-prev');
      processCleanupMock.mockImplementationOnce(async (options: {
        saveCursors: (c: { retention: string | null; gc: string | null }) => Promise<void>;
      }) => {
        await options.saveCursors({ retention: null, gc: 'gc-next' });
        return { deleted: 0 };
      });
      const before = Date.now();

      await __testOnly.processCleanupJob(cleanupJob);

      const options = processCleanupMock.mock.calls[0]![0] as {
        retentionCursor: string | null; gcCursor: string | null; retentionDeadlineMs: number; gcDeadlineMs: number;
      };
      expect(options.retentionCursor).toBe('org-b');
      expect(options.gcCursor).toBe('gc-prev');
      // Retention gets the first half of the budget; the sweep runs until the end of it.
      expect(options.retentionDeadlineMs).toBeGreaterThanOrEqual(before + 300_000);
      expect(options.retentionDeadlineMs).toBeLessThanOrEqual(Date.now() + 300_000);
      expect(options.gcDeadlineMs).toBeGreaterThanOrEqual(before + 600_000);
      expect(options.gcDeadlineMs).toBeLessThanOrEqual(Date.now() + 600_000);
      expect(redisStore.has(BACKUP_SNAPSHOT_CLEANUP_CURSOR_KEYS.retention)).toBe(false);
      expect(redisStore.get(BACKUP_SNAPSHOT_CLEANUP_CURSOR_KEYS.gc)).toBe('gc-next');
    });

    it.each([
      [undefined, 4 * 60 * 60 * 1000],
      ['', 4 * 60 * 60 * 1000],
      ['abc', 4 * 60 * 60 * 1000],
      ['0', 4 * 60 * 60 * 1000],
      ['-5', 4 * 60 * 60 * 1000],
      ['1.5', 4 * 60 * 60 * 1000],
      ['7200000', 7_200_000],
    ])('time budget %s resolves to %d ms', (raw, expected) => {
      if (raw === undefined) delete process.env.BACKUP_SNAPSHOT_CLEANUP_TIME_BUDGET_MS;
      else process.env.BACKUP_SNAPSHOT_CLEANUP_TIME_BUDGET_MS = raw;
      expect(resolveBackupSnapshotCleanupTimeBudgetMs()).toBe(expected);
    });
  });
});
