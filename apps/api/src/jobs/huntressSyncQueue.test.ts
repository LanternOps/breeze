import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1736 — a transient US-pool connection drop (CONNECTION_CLOSED) was failing
// the whole per-integration sync with no retry, leaving agents/incidents
// unpersisted. The enqueue must carry attempts + backoff so a transient drop
// recovers without operator intervention. The upserts are idempotent, so retry
// is safe.

const addMock = vi.fn(async (..._args: unknown[]) => ({ id: 'job-1' }));
const getJobMock = vi.fn(async (..._args: unknown[]) => null);

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    getJob = getJobMock;
  },
  Worker: class {},
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
}));

vi.mock('../services/bullmqUtils', () => ({
  isReusableState: vi.fn(() => false),
}));

import { scheduleHuntressSync } from './huntressSync';

describe('huntress sync enqueue resilience (#1736)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues a per-integration sync with retry attempts and exponential backoff', async () => {
    await scheduleHuntressSync('integration-1');

    expect(addMock).toHaveBeenCalledTimes(1);
    const [name, data, opts] = addMock.mock.calls[0]!;
    expect(name).toBe('sync-integration');
    expect(data).toMatchObject({ type: 'sync-integration', integrationId: 'integration-1' });
    expect(opts).toMatchObject({
      jobId: 'huntress-sync-integration-integration-1',
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
  });
});
