import { beforeEach, describe, expect, it, vi } from 'vitest';

const { schedule, attach, refresh, retention, workers } = vi.hoisted(() => ({
  schedule: vi.fn(), attach: vi.fn(), refresh: vi.fn(), retention: vi.fn(),
  workers: [] as Array<{ processor: (job: { name: string }) => Promise<unknown> }>,
}));
vi.mock('bullmq', () => ({
  Queue: class { upsertJobScheduler = schedule; close = vi.fn(); },
  Worker: class {
    on = vi.fn(); close = vi.fn();
    constructor(_name: string, processor: (job: { name: string }) => Promise<unknown>) { workers.push({ processor }); }
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: attach }));
vi.mock('../services/learnedNetworks/maintenance', () => ({
  refreshLearnedNetworkLastSeen: refresh, runLearnedNetworkRetention: retention,
}));

import { initializeLearnedNetworkMaintenance, shutdownLearnedNetworkMaintenance } from './learnedNetworkMaintenance';
import { jobSchedule } from './scheduleRegistry';

describe('learned network maintenance job', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    workers.length = 0;
    await shutdownLearnedNetworkMaintenance();
    refresh.mockResolvedValue({ gateways: 0, networks: 0, devices: 0, wan: 0 });
    retention.mockResolvedValue({ networksDeleted: 0, deviceRowsDeleted: 0 });
  });

  it('uses the registry slots: hourly at :16 and daily at 17:33', () => {
    expect(jobSchedule('learned-network-last-seen')).toBe('16 * * * *');
    expect(jobSchedule('learned-network-retention')).toBe('33 17 * * *');
  });

  it('registers both schedulers on their registry slots', async () => {
    await initializeLearnedNetworkMaintenance();
    expect(schedule).toHaveBeenCalledWith('learned-network-last-seen',
      { pattern: jobSchedule('learned-network-last-seen') }, expect.objectContaining({ name: 'refresh-last-seen' }));
    expect(schedule).toHaveBeenCalledWith('learned-network-retention',
      { pattern: jobSchedule('learned-network-retention') }, expect.objectContaining({ name: 'retention' }));
    expect(attach).toHaveBeenCalledWith(expect.anything(), 'learnedNetworkMaintenance');
  });

  it('dispatches each job name to its service function and rethrows a failure', async () => {
    await initializeLearnedNetworkMaintenance();
    const processor = workers[0]!.processor;

    await processor({ name: 'refresh-last-seen' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]![0]).toBeInstanceOf(Date);
    expect(retention).not.toHaveBeenCalled();

    await processor({ name: 'retention' });
    expect(retention).toHaveBeenCalledTimes(1);
    expect(retention.mock.calls[0]![0]).toBeInstanceOf(Date);

    refresh.mockRejectedValueOnce(new Error('refresh failed'));
    await expect(processor({ name: 'refresh-last-seen' })).rejects.toThrow('refresh failed');
    retention.mockRejectedValueOnce(new Error('retention failed'));
    await expect(processor({ name: 'retention' })).rejects.toThrow('retention failed');
  });

  it('rejects an unknown job name', async () => {
    await initializeLearnedNetworkMaintenance();
    await expect(workers[0]!.processor({ name: 'nope' })).rejects.toThrow(/unknown job/);
  });
});
