import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock } = vi.hoisted(() => ({
  addMock: vi.fn(async () => ({ id: 'queued-job-1' })),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    getRepeatableJobs = vi.fn(async () => []);
    removeRepeatableByKey = vi.fn(async () => undefined);
  },
  Worker: class {
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
}));

vi.mock('../db', () => ({
  db: {},
  withSystemDbAccessContext: vi.fn(),
}));

vi.mock('../db/schema', () => ({
  discoveryJobs: {},
  discoveryProfiles: {},
  networkBaselines: {},
  networkChangeEvents: {},
}));

vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/networkBaseline', () => ({
  compareBaselineScan: vi.fn(),
  normalizeBaselineScanSchedule: vi.fn(),
}));
vi.mock('./discoveryWorker', () => ({ enqueueDiscoveryScan: vi.fn() }));
vi.mock('../services/discoveryJobCreation', () => ({ createDiscoveryJobIfIdle: vi.fn() }));

import { enqueueBaselineScan } from './networkBaselineWorker';

describe('networkBaselineWorker.enqueueBaselineScan jobId', () => {
  beforeEach(() => {
    addMock.mockClear();
    addMock.mockResolvedValue({ id: 'queued-job-1' });
  });

  // Regression for "Custom Id cannot contain :" — BullMQ rejects a custom
  // jobId whose colon-split length !== 3. `baseline-scan:<id>` is 2 parts and
  // would throw, silently dropping the baseline-scan enqueue.
  it('does not use a colon in the enqueued BullMQ job id', async () => {
    await enqueueBaselineScan('baseline-1', 'org-1', 'site-1', '10.0.0.0/24');

    expect(addMock).toHaveBeenCalled();
    const [, , opts] = addMock.mock.calls[0] as unknown as [string, unknown, { jobId: string }];
    expect(String(opts.jobId)).not.toContain(':');
    expect(String(opts.jobId)).toBe('baseline-scan-baseline-1');
  });
});
