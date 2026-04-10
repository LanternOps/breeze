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

vi.mock('../db', () => ({
  db: {},
}));

vi.mock('../db/schema', () => ({
  organizationUsers: {},
}));

vi.mock('../services/userRiskScoring', () => ({
  appendUserRiskSignalEvent: vi.fn(),
  computeAndPersistUserRiskForUser: vi.fn(),
  computeAndPersistOrgUserRisk: vi.fn(),
  publishUserRiskScoreEvents: vi.fn(),
}));

import {
  enqueueUserRiskSignalEvent,
  shutdownUserRiskJobs,
  triggerUserRiskRecompute,
} from './userRiskJobs';

describe('triggerUserRiskRecompute', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownUserRiskJobs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for org recompute requests', async () => {
    await triggerUserRiskRecompute('org-1');

    expect(addMock).toHaveBeenCalledWith(
      'compute-org',
      expect.objectContaining({ orgId: 'org-1' }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^user-risk-recompute:org-1:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active recompute job for the same org within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('delayed'),
    });

    const jobId = await triggerUserRiskRecompute('org-1');

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });

  it('caps signal-event payload strings and drops oversized details', async () => {
    await enqueueUserRiskSignalEvent({
      orgId: 'org-1',
      userId: 'user-1',
      eventType: 'e'.repeat(300),
      description: 'd'.repeat(2000),
      details: { oversized: 'x'.repeat(20 * 1024) },
    });

    expect(addMock).toHaveBeenCalledTimes(1);
    const queued = addMock.mock.calls[0]?.[1];
    expect(queued.eventType).toHaveLength(128);
    expect(queued.description).toHaveLength(1024);
    expect(queued.details).toBeUndefined();
  });
});
