import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { M365SyncJobData } from '../services/m365Sync/types';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    counts: vi.fn(), add: vi.fn(async () => ({ id: 'j' })), getRepeatables: vi.fn(async () => [] as unknown[]),
    removeRepeatable: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => 0),
    claim: vi.fn(async (): Promise<M365SyncJobData[]> => []),
    countDue: vi.fn(async () => 0),
    enqueue: vi.fn(async (_data: M365SyncJobData) => 'job-1'), run: vi.fn(async () => 'success'),
    metricDepth: vi.fn(), metricUtil: vi.fn(), metricSkipped: vi.fn(), metricBacklog: vi.fn(),
    order: [] as string[],
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJobCounts = mocks.counts; add = mocks.add;
    getRepeatableJobs = mocks.getRepeatables; removeRepeatableByKey = mocks.removeRepeatable;
    getJob = vi.fn(async () => null); close = vi.fn();
  },
  Worker: class { on = vi.fn(); close = vi.fn(); },
  Job: class {},
  UnrecoverableError: class UnrecoverableError extends Error {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/m365Sync/claim', () => ({
  reconcileEligibleConnections: mocks.reconcile, claimDueDomains: mocks.claim,
  countDueDomains: mocks.countDue, syncJobId: (d: { orgId: string; domain: string; generation: number }) =>
    `m365-sync-${d.orgId}-${d.domain}-${d.generation}`,
}));
vi.mock('./m365SyncQueue', async (actual) => ({
  ...(await actual<typeof import('./m365SyncQueue')>()),
  enqueueSyncDomain: mocks.enqueue,
}));
vi.mock('../services/m365Sync/run', () => ({ runSyncDomain: mocks.run, logSync: vi.fn() }));
vi.mock('../services/m365Sync/metrics', () => ({
  setM365SyncQueueDepth: mocks.metricDepth, setM365SyncTickerUtilisation: mocks.metricUtil,
  recordM365SyncTickerSkipped: mocks.metricSkipped, setM365SyncDueBacklog: mocks.metricBacklog,
}));

import { classifyM365SyncFailure, M365SyncRetryableError, runM365SyncTick } from './m365SyncWorker';

const CLAIMED = {
  orgId: 'org-1', domain: 'users' as const, generation: 3, connectionId: 'conn-1',
  tenantId: 'tenant-1', consentGeneration: 1, priority: 10 as const,
};

describe('runM365SyncTick (spec §5.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.M365_SYNC_MAX_BACKLOG;
    delete process.env.M365_SYNC_TICK_BATCH;
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    mocks.counts.mockResolvedValue({ waiting: 0, prioritized: 0, delayed: 0, active: 0 });
  });

  it('does nothing at all when the flag is off', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'false';
    await expect(runM365SyncTick()).resolves.toMatchObject({ skipped: 'flag_off', claimed: 0 });
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('counts prioritized AND delayed in the backpressure depth, not just waiting+active', async () => {
    process.env.M365_SYNC_MAX_BACKLOG = '10';
    mocks.counts.mockResolvedValue({ waiting: 3, prioritized: 4, delayed: 4, active: 1 });
    const result = await runM365SyncTick();
    expect(result.depth).toBe(12);
    expect(result.skipped).toBe('backpressure');
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.metricSkipped).toHaveBeenCalledTimes(1);
  });

  it('publishes the queue-depth gauge even on the skipped path', async () => {
    process.env.M365_SYNC_MAX_BACKLOG = '1';
    mocks.counts.mockResolvedValue({ waiting: 9, prioritized: 0, delayed: 0, active: 0 });
    await runM365SyncTick();
    expect(mocks.metricDepth).toHaveBeenCalledWith(9);
  });

  it('reconciles BEFORE claiming, so a newly-consented org is claimable in the same tick', async () => {
    mocks.reconcile.mockImplementation(async () => { mocks.order.push('reconcile'); return 2; });
    mocks.claim.mockImplementation(async () => { mocks.order.push('claim'); return []; });
    mocks.order.length = 0;
    await runM365SyncTick();
    expect(mocks.order).toEqual(['reconcile', 'claim']);
  });

  it('claims the configured batch and enqueues one job per claimed row', async () => {
    process.env.M365_SYNC_TICK_BATCH = '50';
    mocks.claim.mockResolvedValue([CLAIMED, { ...CLAIMED, domain: 'skus' as const }]);
    const result = await runM365SyncTick();
    expect(mocks.claim).toHaveBeenCalledWith({ limit: 50 });
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(result.claimed).toBe(2);
  });

  it('publishes utilisation as claimed/batch (the §5.9 <= 50% target)', async () => {
    process.env.M365_SYNC_TICK_BATCH = '4';
    mocks.claim.mockResolvedValue([CLAIMED, CLAIMED]);
    await runM365SyncTick();
    expect(mocks.metricUtil).toHaveBeenCalledWith(0.5);
  });

  it('publishes the due-backlog gauge from the state table, not from the queue', async () => {
    mocks.countDue.mockResolvedValue(37);
    await expect(runM365SyncTick()).resolves.toMatchObject({ due: 37 });
    expect(mocks.metricBacklog).toHaveBeenCalledWith(37);
  });

  it('the claimed-row fields fed into syncJobId contain no colon', async () => {
    // NOTE (deviation from plan text, and from this test's former name "never
    // enqueues a job id containing a colon"): `enqueueSyncDomain` is mocked at
    // this layer, so no job id is ever actually built or inspected here —
    // renamed to describe what this actually asserts. The real job-id
    // assertions live in claim.test.ts, claim.sql.test.ts, m365SyncQueue.test.ts
    // and the integration test. `JSON.stringify` of any non-empty object always
    // contains `:` (JSON key/value syntax) too, which is why this checks the
    // claimed-row field VALUES that feed `syncJobId`, not a JSON.stringify blob.
    mocks.claim.mockResolvedValue([CLAIMED]);
    await runM365SyncTick();
    expect(Object.values(mocks.enqueue.mock.calls[0]![0]).map(String).join('|')).not.toContain(':');
  });

  it('does not abandon the remaining claims when ONE enqueue fails', async () => {
    mocks.claim.mockResolvedValue([CLAIMED, { ...CLAIMED, domain: 'skus' as const }]);
    mocks.enqueue.mockRejectedValueOnce(new Error('redis blip'));
    const result = await runM365SyncTick();
    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    // The failed row keeps its past next_sync_at and its lease expires in 20
    // minutes, so the next tick reclaims it (spec §5.2 "Recovery").
    expect(result.claimed).toBe(2);
  });
});

describe('classifyM365SyncFailure', () => {
  it('classifies a throttle as a WARNING held until attempts are exhausted', () => {
    expect(classifyM365SyncFailure(undefined, new M365SyncRetryableError('throttled'))).toEqual({
      reason: 'm365_sync_throttled', level: 'warning', reportOnlyWhenExhausted: true,
    });
  });

  it('leaves every other failure at the default error-level report', () => {
    expect(classifyM365SyncFailure(undefined, new Error('pg connection closed'))).toBeNull();
  });
});
