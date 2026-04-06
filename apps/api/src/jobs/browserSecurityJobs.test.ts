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
}));

vi.mock('../db', () => ({
  db: {},
}));

vi.mock('../db/schema', () => ({
  browserExtensions: {},
  browserPolicies: {},
  browserPolicyViolations: {},
  devices: {},
}));

import {
  shutdownBrowserSecurityJobs,
  triggerBrowserPolicyEvaluation,
} from './browserSecurityJobs';

describe('triggerBrowserPolicyEvaluation', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
    getJobMock.mockReset();
    addMock.mockReset();
    closeMock.mockReset();
    getJobMock.mockResolvedValue(null);
    addMock.mockResolvedValue({ id: 'queue-job-1' });
    await shutdownBrowserSecurityJobs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a stable BullMQ job id for on-demand browser policy evaluation', async () => {
    await triggerBrowserPolicyEvaluation('org-1', 'policy-1');

    expect(addMock).toHaveBeenCalledWith(
      'evaluate',
      expect.objectContaining({ orgId: 'org-1', policyId: 'policy-1' }),
      expect.objectContaining({
        jobId: expect.stringMatching(/^browser-policy-eval:org-1:policy-1:[a-z0-9]+$/),
      }),
    );
  });

  it('reuses an active evaluation job for the same org and policy within the dedupe window', async () => {
    getJobMock.mockResolvedValue({
      id: 'existing-job',
      getState: vi.fn().mockResolvedValue('waiting'),
    });

    const jobId = await triggerBrowserPolicyEvaluation('org-1', 'policy-1');

    expect(jobId).toBe('existing-job');
    expect(addMock).not.toHaveBeenCalled();
  });
});
