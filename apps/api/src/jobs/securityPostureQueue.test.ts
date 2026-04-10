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

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: undefined,
}));

vi.mock('../db/schema', () => ({
  devices: {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/securityPosture', () => ({
  computeAndPersistOrgSecurityPosture: vi.fn(),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn(),
}));

import {
  shutdownSecurityPostureWorker,
  triggerSecurityPostureRecompute,
} from './securityPostureWorker';

describe('triggerSecurityPostureRecompute', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownSecurityPostureWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for posture recompute requests', async () => {
    await triggerSecurityPostureRecompute('org-1');

    expect(addMock).toHaveBeenCalledWith(
      'compute-org',
      expect.objectContaining({ orgId: 'org-1' }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^security-posture-recompute:org-1:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active posture recompute job within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('delayed'),
    });

    const jobId = await triggerSecurityPostureRecompute('org-1');

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });
});
