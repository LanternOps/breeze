import { beforeEach, describe, expect, it, vi } from 'vitest';

const addMock = vi.fn(async (..._args: unknown[]) => ({ id: 'job-1' }));
const getJobMock = vi.fn(async (..._args: unknown[]) => null);

vi.mock('bullmq', () => ({
  Queue: class { add = addMock; getJob = getJobMock; close = vi.fn(); },
  Worker: class {},
  Job: class {},
  UnrecoverableError: class extends Error {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));

import { enqueueSyncDomain, m365SyncBackoff, SYNC_DOMAIN_JOB_OPTS } from './m365SyncQueue';

const JOB = {
  orgId: '11111111-1111-4111-8111-111111111111', domain: 'users' as const, generation: 3,
  connectionId: '22222222-2222-4222-8222-222222222222', tenantId: 'tenant-1',
  consentGeneration: 1, priority: 10 as const,
};

describe('m365-sync enqueue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enqueues sync-domain under the generation-scoped, colon-free job id', async () => {
    await enqueueSyncDomain(JOB);
    const [name, data, opts] = addMock.mock.calls[0]!;
    expect(name).toBe('sync-domain');
    expect(data).toMatchObject({ orgId: JOB.orgId, domain: 'users', generation: 3 });
    expect((opts as { jobId: string }).jobId).toBe('m365-sync-11111111-1111-4111-8111-111111111111-users-3');
    expect((opts as { jobId: string }).jobId).not.toContain(':');
  });

  it('carries priority, 3 attempts, custom backoff, and the retention policy from the spec', async () => {
    await enqueueSyncDomain(JOB);
    expect(addMock.mock.calls[0]![2]).toMatchObject({
      priority: 10,
      attempts: 3,
      backoff: { type: 'custom' },
      removeOnComplete: true,
      removeOnFail: { count: 100 },
    });
  });

  it('carries the priority-1 lane through unchanged', async () => {
    await enqueueSyncDomain({ ...JOB, priority: 1 });
    expect(addMock.mock.calls[0]![2]).toMatchObject({ priority: 1 });
  });

  it('replaces a STALE retained job rather than being silently discarded by BullMQ dedup', async () => {
    const remove = vi.fn(async () => undefined);
    getJobMock.mockResolvedValueOnce({ id: 'old', getState: async () => 'failed', remove } as never);
    await enqueueSyncDomain(JOB);
    expect(remove).toHaveBeenCalled();
    expect(addMock).toHaveBeenCalled();
  });

  it('reuses a genuinely in-flight job instead of restarting it underneath itself', async () => {
    getJobMock.mockResolvedValueOnce({ id: 'live', getState: async () => 'active', remove: vi.fn() } as never);
    await enqueueSyncDomain(JOB);
    expect(addMock).not.toHaveBeenCalled();
  });

  it('backoff ladder is 30s / 120s / 480s and clamps beyond the ladder', () => {
    expect(m365SyncBackoff(1)).toBe(30_000);
    expect(m365SyncBackoff(2)).toBe(120_000);
    expect(m365SyncBackoff(3)).toBe(480_000);
    expect(m365SyncBackoff(9)).toBe(480_000);
    expect(m365SyncBackoff(0)).toBe(30_000);
  });

  it('never returns -1 (a -1 would stop retries and break reportOnlyWhenExhausted)', () => {
    for (let i = -2; i < 12; i++) expect(m365SyncBackoff(i)).toBeGreaterThan(0);
  });

  it('exports job opts with no jobId or priority baked in', () => {
    expect(SYNC_DOMAIN_JOB_OPTS).not.toHaveProperty('jobId');
    expect(SYNC_DOMAIN_JOB_OPTS).not.toHaveProperty('priority');
  });
});
