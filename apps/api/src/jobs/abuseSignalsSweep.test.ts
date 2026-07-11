import { describe, it, expect, beforeEach, vi } from 'vitest';

const queueAdd = vi.fn();
const getRepeatableJobs = vi.fn().mockResolvedValue([
  { name: 'abuse-sweep', key: 'old-key-1' },
  { name: 'unrelated', key: 'other' },
]);
const removeRepeatableByKey = vi.fn();

vi.mock('bullmq', () => ({
  // Function expressions (not arrow functions) so `new Queue()` /
  // `new Worker()` are constructible under vitest's mock implementation
  // (mirrors the pattern in jobs/peripheralJobs.test.ts).
  Queue: vi.fn(function QueueMock() {
    return { add: queueAdd, getRepeatableJobs, removeRepeatableByKey, close: vi.fn() };
  }),
  Worker: vi.fn(function WorkerMock() {
    return { on: vi.fn(), close: vi.fn() };
  }),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/abuseSignals', () => ({ runAbuseSweep: vi.fn(), runAbuseDigest: vi.fn() }));
vi.mock('../services/abuseMetrics', () => ({ recordAbuseSweepRun: vi.fn() }));

import { scheduleAbuseSignalsJobs } from './abuseSignalsSweep';

beforeEach(() => vi.clearAllMocks());

describe('scheduleAbuseSignalsJobs', () => {
  it('clears prior repeatables for its own job names only, then schedules hourly sweep + weekly digest', async () => {
    getRepeatableJobs.mockResolvedValueOnce([
      { name: 'abuse-sweep', key: 'stale-sweep' },
      { name: 'abuse-digest', key: 'stale-digest' },
      { name: 'unrelated', key: 'other' },
    ]);
    await scheduleAbuseSignalsJobs();
    expect(removeRepeatableByKey).toHaveBeenCalledWith('stale-sweep');
    expect(removeRepeatableByKey).toHaveBeenCalledWith('stale-digest');
    expect(removeRepeatableByKey).not.toHaveBeenCalledWith('other');
    expect(queueAdd).toHaveBeenCalledWith(
      'abuse-sweep',
      expect.anything(),
      expect.objectContaining({ jobId: 'abuse-sweep-repeat', repeat: { every: 60 * 60 * 1000 } }),
    );
    expect(queueAdd).toHaveBeenCalledWith(
      'abuse-digest',
      expect.anything(),
      expect.objectContaining({ jobId: 'abuse-digest-repeat', repeat: { pattern: '0 9 * * 1' } }),
    );
  });
});
