import { beforeEach, describe, expect, it, vi } from 'vitest';

const queueMock = {
  add: vi.fn(),
  getJob: vi.fn(),
};

vi.mock('bullmq', () => ({
  Queue: vi.fn(function QueueMock() {
    return queueMock;
  }),
  Worker: vi.fn(function WorkerMock() {
    return {
    on: vi.fn(),
    close: vi.fn()
    };
  }),
  Job: class {}
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({}))
}));

vi.mock('../db', () => ({
  db: {}
}));

vi.mock('../db/schema', () => ({
  devices: {},
  peripheralEvents: {},
  peripheralPolicies: {}
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn()
}));

vi.mock('../services/commandQueue', () => ({
  CommandTypes: { PERIPHERAL_POLICY_SYNC: 'peripheral_policy_sync' },
  queueCommand: vi.fn(),
  queueCommandForExecution: vi.fn()
}));

import { schedulePeripheralPolicyDistribution } from './peripheralJobs';

describe('schedulePeripheralPolicyDistribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueMock.add.mockResolvedValue({ id: 'job-new' });
  });

  it('coalesces into existing waiting job and merges changed policy IDs', async () => {
    const updateData = vi.fn().mockResolvedValue(undefined);
    const getState = vi.fn().mockResolvedValue('waiting');
    queueMock.getJob.mockResolvedValue({
      id: 'job-existing',
      data: {
        type: 'policy-distribution',
        orgId: 'org-1',
        changedPolicyIds: ['p1'],
        reason: 'prior',
        queuedAt: '2026-02-26T00:00:00.000Z'
      },
      getState,
      updateData
    });

    const jobId = await schedulePeripheralPolicyDistribution('org-1', ['p1', 'p2'], 'new-reason');

    expect(jobId).toBe('job-existing');
    expect(updateData).toHaveBeenCalledTimes(1);
    const merged = updateData.mock.calls[0]?.[0];
    expect(merged.changedPolicyIds).toEqual(expect.arrayContaining(['p1', 'p2']));
    expect(queueMock.add).not.toHaveBeenCalled();
  });

  it('creates a new queue job with stable jobId when no active job exists', async () => {
    queueMock.getJob.mockResolvedValue(null);

    const jobId = await schedulePeripheralPolicyDistribution('org-2', ['pA', 'pA', 'pB'], 'policy-updated');

    expect(jobId).toBe('job-new');
    expect(queueMock.add).toHaveBeenCalledTimes(1);
    const addCall = queueMock.add.mock.calls[0];
    expect(addCall?.[0]).toBe('policy-distribution');
    expect(addCall?.[1]?.changedPolicyIds).toEqual(['pA', 'pB']);
    expect(addCall?.[2]?.jobId).toBe('policy-distribution:org-2');
  });

  it('removes stale completed job before creating a new one', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const getState = vi.fn().mockResolvedValue('completed');
    queueMock.getJob.mockResolvedValue({
      id: 'job-stale',
      data: {
        type: 'policy-distribution',
        orgId: 'org-3',
        changedPolicyIds: ['p-old'],
        reason: 'prior',
        queuedAt: '2026-02-25T00:00:00.000Z'
      },
      getState,
      remove
    });

    const jobId = await schedulePeripheralPolicyDistribution('org-3', ['p-new'], 'policy-updated');

    expect(remove).toHaveBeenCalledTimes(1);
    expect(queueMock.add).toHaveBeenCalledTimes(1);
    expect(jobId).toBe('job-new');
    const addCall = queueMock.add.mock.calls[0];
    expect(addCall?.[1]?.changedPolicyIds).toEqual(['p-new']);
    expect(addCall?.[2]?.jobId).toBe('policy-distribution:org-3');
  });

  it('still creates a new job when stale job removal fails', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('Redis unavailable'));
    const getState = vi.fn().mockResolvedValue('completed');
    queueMock.getJob.mockResolvedValue({
      id: 'job-stale-fail',
      data: {
        type: 'policy-distribution',
        orgId: 'org-4',
        changedPolicyIds: ['p-old'],
        reason: 'prior',
        queuedAt: '2026-02-25T00:00:00.000Z'
      },
      getState,
      remove
    });

    const jobId = await schedulePeripheralPolicyDistribution('org-4', ['p-fresh'], 'policy-updated');

    expect(remove).toHaveBeenCalledTimes(1);
    expect(queueMock.add).toHaveBeenCalledTimes(1);
    expect(jobId).toBe('job-new');
    const addCall = queueMock.add.mock.calls[0];
    expect(addCall?.[1]?.changedPolicyIds).toEqual(['p-fresh']);
  });

  it('deduplicates policy IDs in input', async () => {
    queueMock.getJob.mockResolvedValue(null);

    await schedulePeripheralPolicyDistribution('org-5', ['p1', 'p1', 'p2'], 'dedup-test');

    expect(queueMock.add).toHaveBeenCalledTimes(1);
    const addCall = queueMock.add.mock.calls[0];
    expect(addCall?.[1]?.changedPolicyIds).toEqual(['p1', 'p2']);
  });
});
