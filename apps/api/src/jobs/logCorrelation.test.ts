import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getJobMock, addMock, closeMock } = vi.hoisted(() => ({
  getJobMock: vi.fn(),
  addMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
  },
  Worker: class {
    close = closeMock;
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/logSearch', () => ({
  detectPatternCorrelation: vi.fn(),
  runCorrelationRules: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import {
  enqueueAdHocPatternCorrelationDetection,
  enqueueLogCorrelationDetection,
  shutdownLogCorrelationWorker,
} from './logCorrelation';

describe('log correlation queue helpers', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownLogCorrelationWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for rules detection and normalizes rule ids', async () => {
    await enqueueLogCorrelationDetection({ orgId: 'org-1', ruleIds: ['r2', 'r1', 'r2'] });

    expect(addMock).toHaveBeenCalledWith(
      'rules-detect',
      expect.objectContaining({ orgId: 'org-1', ruleIds: ['r1', 'r2'] }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^log-correlation-rules:org-1:[a-z0-9]+:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active ad hoc pattern detection job within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-pattern-job',
      getState: vi.fn().mockResolvedValue('active'),
    });

    const jobId = await enqueueAdHocPatternCorrelationDetection({
      orgId: 'org-1',
      pattern: 'powershell',
      minDevices: 2,
    });

    expect(jobId).toBe('existing-pattern-job');
    expect(addMock).not.toHaveBeenCalled();
  });
});
