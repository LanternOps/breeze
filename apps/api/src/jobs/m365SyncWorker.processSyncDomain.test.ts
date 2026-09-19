/**
 * PR #5695 review finding 5 — `processSyncDomain` (jobs/m365SyncWorker.ts) had
 * ZERO coverage: its own flag-off check, the UnrecoverableError on a malformed
 * payload, the isFinalAttempt computation, and the throttled-and-non-final
 * re-throw. `runM365SyncTick`'s suite (m365SyncWorker.test.ts) never exercises
 * this function at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job, UnrecoverableError as UnrecoverableErrorType } from 'bullmq';
import type { M365SyncJobData } from '../services/m365Sync/types';
import type { M365SyncQueueJobData } from './m365SyncQueue';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    run: vi.fn(async (): Promise<string> => 'success'),
  },
}));

vi.mock('bullmq', () => ({
  Queue: class { getJobCounts = vi.fn(); add = vi.fn(); getRepeatableJobs = vi.fn(async () => []); removeRepeatableByKey = vi.fn(); getJob = vi.fn(async () => null); close = vi.fn(); },
  Worker: class { on = vi.fn(); close = vi.fn(); },
  Job: class {},
  UnrecoverableError: class UnrecoverableError extends Error {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/m365Sync/claim', () => ({
  reconcileEligibleConnections: vi.fn(async () => 0), claimDueDomains: vi.fn(async () => []),
  countDueDomains: vi.fn(async () => 0),
  syncJobId: (d: { orgId: string; domain: string; generation: number }) =>
    `m365-sync-${d.orgId}-${d.domain}-${d.generation}`,
}));
vi.mock('./m365SyncQueue', async (actual) => ({
  ...(await actual<typeof import('./m365SyncQueue')>()),
  enqueueSyncDomain: vi.fn(async () => 'job-1'),
}));
vi.mock('../services/m365Sync/run', () => ({ runSyncDomain: mocks.run, logSync: vi.fn() }));
vi.mock('../services/m365Sync/metrics', () => ({
  setM365SyncQueueDepth: vi.fn(), setM365SyncTickerUtilisation: vi.fn(),
  recordM365SyncTickerSkipped: vi.fn(), setM365SyncDueBacklog: vi.fn(),
}));

import { UnrecoverableError } from 'bullmq';
import { M365SyncRetryableError, processSyncDomain } from './m365SyncWorker';

const VALID_DATA: M365SyncJobData = {
  orgId: '11111111-1111-4111-8111-111111111111',
  domain: 'users',
  generation: 1,
  connectionId: '22222222-2222-4222-8222-222222222222',
  tenantId: 'tenant-1',
  consentGeneration: 0,
  priority: 10,
};

function makeJob(data: unknown, attemptsMade: number, attempts = 3): Job<M365SyncQueueJobData> {
  return { data, attemptsMade, opts: { attempts } } as unknown as Job<M365SyncQueueJobData>;
}

describe('processSyncDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    mocks.run.mockResolvedValue('success');
  });

  it('returns noop WITHOUT calling runSyncDomain when the flag is off', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'false';
    await expect(processSyncDomain(makeJob(VALID_DATA, 1))).resolves.toBe('noop');
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('throws UnrecoverableError on a payload that fails schema validation', async () => {
    await expect(processSyncDomain(makeJob({ notEvenClose: true }, 1)))
      .rejects.toThrow(UnrecoverableError as unknown as typeof UnrecoverableErrorType);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('isFinalAttempt is false one attempt short of the limit, true exactly AT it', async () => {
    await processSyncDomain(makeJob(VALID_DATA, 2, 3));
    expect(mocks.run).toHaveBeenLastCalledWith(VALID_DATA, { isFinalAttempt: false });

    await processSyncDomain(makeJob(VALID_DATA, 3, 3));
    expect(mocks.run).toHaveBeenLastCalledWith(VALID_DATA, { isFinalAttempt: true });
  });

  it('throttled on a NON-final attempt throws M365SyncRetryableError so BullMQ retries', async () => {
    mocks.run.mockResolvedValue('throttled');
    await expect(processSyncDomain(makeJob(VALID_DATA, 1, 3))).rejects.toThrow(M365SyncRetryableError);
  });

  it('throttled on the FINAL attempt returns normally — runSyncDomain already recorded it terminally', async () => {
    mocks.run.mockResolvedValue('throttled');
    await expect(processSyncDomain(makeJob(VALID_DATA, 3, 3))).resolves.toBe('throttled');
  });

  it('a non-throttled outcome never throws, even on a non-final attempt', async () => {
    mocks.run.mockResolvedValue('error');
    await expect(processSyncDomain(makeJob(VALID_DATA, 1, 3))).resolves.toBe('error');
  });
});
