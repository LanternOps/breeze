// apps/api/src/jobs/aiModelDiscoveryWorker.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, getJobMock, getRepeatableJobsMock, removeRepeatableByKeyMock, syncMock, capturedProcessor } = vi.hoisted(() => ({
  addMock: vi.fn(),
  getJobMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  syncMock: vi.fn(),
  capturedProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) { this.name = name; }
    add = (...args: unknown[]) => addMock(...args);
    getJob = (...args: unknown[]) => getJobMock(...args);
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...args);
    close = vi.fn();
  },
  Worker: class {
    name: string;
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      this.name = name;
      capturedProcessor.current = processor;
    }
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/aiModels/discovery', () => ({ syncPlatformModels: (...args: unknown[]) => syncMock(...args) }));

import {
  AI_MODEL_DISCOVERY_QUEUE,
  SYNC_PLATFORM_JOB,
  __testOnly,
  enqueuePlatformModelSync,
  initializeAiModelDiscoveryWorker,
  processAiModelDiscoveryJob,
  scheduleAiModelDiscoveryJobs,
  shutdownAiModelDiscoveryWorker,
} from './aiModelDiscoveryWorker';

beforeEach(() => {
  vi.clearAllMocks();
  addMock.mockImplementation(async (_name: string, _data: unknown, opts: { jobId?: string }) => ({ id: opts.jobId ?? 'job-1' }));
  getJobMock.mockResolvedValue(null);
  getRepeatableJobsMock.mockResolvedValue([]);
});

describe('ai-model-discovery queue', () => {
  it('uses the index names', () => {
    expect(AI_MODEL_DISCOVERY_QUEUE).toBe('ai-model-discovery');
    expect(SYNC_PLATFORM_JOB).toBe('sync-platform');
  });

  it('schedules exactly one daily sync-platform repeatable with a stable job id', async () => {
    getRepeatableJobsMock.mockResolvedValue([{ key: 'old-key' }]);
    await scheduleAiModelDiscoveryJobs();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
    expect(addMock).toHaveBeenCalledWith(
      'sync-platform',
      { type: 'sync-platform', trigger: 'schedule' },
      expect.objectContaining({ jobId: __testOnly.DAILY_REPEAT_JOB_ID, repeat: { pattern: __testOnly.DAILY_CRON }, attempts: 3 }),
    );
    expect(__testOnly.DAILY_REPEAT_JOB_ID).not.toContain(':');
  });

  it('a manual refresh enqueues sync-platform under the manual job id and reuses a waiting one', async () => {
    expect(await enqueuePlatformModelSync('manual')).toEqual({ id: __testOnly.MANUAL_JOB_ID });
    expect(addMock).toHaveBeenLastCalledWith('sync-platform', { type: 'sync-platform', trigger: 'manual' }, expect.objectContaining({ jobId: __testOnly.MANUAL_JOB_ID }));
    getJobMock.mockResolvedValue({ id: __testOnly.MANUAL_JOB_ID, getState: async () => 'waiting' });
    addMock.mockClear();
    expect(await enqueuePlatformModelSync('manual')).toEqual({ id: __testOnly.MANUAL_JOB_ID });
    expect(addMock).not.toHaveBeenCalled();
  });

  it('init starts the worker, schedules the daily job, and enqueues a delayed boot sync', async () => {
    await initializeAiModelDiscoveryWorker();
    expect(capturedProcessor.current).toBeTypeOf('function');
    expect(addMock).toHaveBeenCalledWith('sync-platform', { type: 'sync-platform', trigger: 'boot' }, expect.objectContaining({ jobId: __testOnly.BOOT_JOB_ID, delay: 60_000 }));
    await shutdownAiModelDiscoveryWorker();
  });

  it('a failed sync throws so BullMQ retries; ok and skipped reports are returned', async () => {
    syncMock.mockResolvedValueOnce({ status: 'failed', error: 'network down' });
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-platform', trigger: 'schedule' } })).rejects.toThrow(/network down/);
    syncMock.mockResolvedValueOnce({ status: 'skipped', reason: 'no_platform_key' });
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-platform', trigger: 'manual' } }))
      .resolves.toEqual({ status: 'skipped', reason: 'no_platform_key' });
  });

  it('rejects an unknown job type', async () => {
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-connection' } as never })).rejects.toThrow(/Unknown/);
  });
});
