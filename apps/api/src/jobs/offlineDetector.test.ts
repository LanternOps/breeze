import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock, getRepeatableJobsMock, workerOptions } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(async () => []),
  workerOptions: [] as Array<Record<string, unknown>>,
}));

vi.mock('../services/offlineEffectsStore', () => ({
  persistOfflineTransition: vi.fn(async () => ['effect-id']),
  findDueOfflineEffects: vi.fn(async () => []),
  pruneOfflineEffects: vi.fn(async () => 0),
}));
vi.mock('../services/offlineTransitionEffects', () => ({ processOfflineEffect: vi.fn() }));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
    getRepeatableJobs = getRepeatableJobsMock;
    removeRepeatableByKey = vi.fn();
  },
  Worker: class {
    constructor(_name: string, _processor: unknown, options: Record<string, unknown>) {
      workerOptions.push(options);
    }
    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: {},

  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {},
  alertRules: {},
  alertTemplates: {},
  alerts: {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn(),
}));

vi.mock('../services/alertService', () => ({
  // #2128: and() drops undefined, so this stub keeps the mocked rule query unchanged
  alertRuleOwnershipConditionForOrg: vi.fn(async () => undefined),
  createAlert: vi.fn(),
}));

vi.mock('../services/alertConditions', () => ({
  interpolateTemplate: vi.fn(),
}));

import {
  createOfflineWorker,
  resolveOfflineWorkerConcurrency,
  scheduleOfflineJobs,
  shutdownOfflineDetector,
  triggerOfflineDetection,
} from './offlineDetector';

describe('triggerOfflineDetection', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    getRepeatableJobsMock.mockClear();
    workerOptions.length = 0;
    await shutdownOfflineDetector();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for manual offline detection requests', async () => {
    await triggerOfflineDetection(10);

    expect(addMock).toHaveBeenCalledWith(
      'detect-offline',
      expect.objectContaining({ thresholdMinutes: 10 }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^offline-detect:10:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active offline detection job within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('delayed'),
    });

    const jobId = await triggerOfflineDetection();

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });
});

describe('offline detector scheduling and worker bounds', () => {
  beforeEach(async () => {
    addMock.mockClear();
    getRepeatableJobsMock.mockClear();
    workerOptions.length = 0;
    delete process.env.OFFLINE_DETECTOR_WORKER_CONCURRENCY;
    await shutdownOfflineDetector();
  });

  afterEach(() => {
    delete process.env.OFFLINE_DETECTOR_WORKER_CONCURRENCY;
  });

  it('uses a fixed seven-second offset for the thirty-second root repeat', async () => {
    await scheduleOfflineJobs();

    expect(addMock).toHaveBeenCalledWith(
      'detect-offline',
      { type: 'detect-offline' },
      expect.objectContaining({ repeat: { every: 30_000, offset: 7_000 } }),
    );
  });

  it.each([
    [undefined, 5],
    ['', 5],
    ['   ', 5],
    ['1', 1],
    ['20', 20],
    ['0', 1],
    ['-4', 1],
    ['1.5', 5],
    ['nope', 5],
    ['21', 20],
  ])('resolves worker concurrency %s to %i', (raw, expected) => {
    expect(resolveOfflineWorkerConcurrency(raw)).toBe(expected);
  });

  it('passes bounded configured concurrency to BullMQ', () => {
    process.env.OFFLINE_DETECTOR_WORKER_CONCURRENCY = '200';
    createOfflineWorker();

    expect(workerOptions.at(-1)).toEqual(expect.objectContaining({ concurrency: 20 }));
  });
});
