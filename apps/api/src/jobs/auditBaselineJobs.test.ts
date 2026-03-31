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
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {},
}));

vi.mock('../db/schema', () => ({
  auditBaselines: {},
  devices: {},
}));

vi.mock('../services/commandQueue', () => ({
  queueCommandForExecution: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
}));

vi.mock('../services/auditBaselineService', () => ({
  evaluateAuditBaselineDrift: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import {
  enqueueAuditDriftEvaluation,
  enqueueAuditPolicyCollection,
  shutdownAuditBaselineJobs,
} from './auditBaselineJobs';

describe('audit baseline queue helpers', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownAuditBaselineJobs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for audit policy collection requests', async () => {
    await enqueueAuditPolicyCollection('org-1');

    expect(addMock).toHaveBeenCalledWith(
      'audit-policy-collection',
      expect.objectContaining({ orgId: 'org-1' }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^audit-policy-collection:org-1:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active audit drift evaluation job within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    const jobId = await enqueueAuditDriftEvaluation('org-1');

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });
});
