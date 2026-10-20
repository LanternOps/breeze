import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addBulkMock, listPartnersMock, listOrgsMock, reconcileMock } = vi.hoisted(() => ({
  addBulkMock: vi.fn(async (..._args: unknown[]) => []),
  listPartnersMock: vi.fn(async () => [] as string[]),
  listOrgsMock: vi.fn(async (_partnerId: string) => [] as string[]),
  reconcileMock: vi.fn(async (orgId: string) => ({ orgId })),
}));

vi.mock('bullmq', () => ({
  Queue: class { addBulk = addBulkMock; add = vi.fn(); getRepeatableJobs = vi.fn(async () => []); close = vi.fn(); },
  Worker: class { on = vi.fn(); close = vi.fn(); },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../services/securityAgents/coverageReconcileRun', () => ({
  listCoveragePartners: listPartnersMock,
  listCoverageOrgsForPartner: listOrgsMock,
  reconcileOrgCoverage: reconcileMock,
}));

import { processSecurityAgentCoverageJob } from './securityAgentCoverageWorker';

type BulkJob = { name: string; data: Record<string, unknown>; opts: { jobId: string } };
const bulk = (call = 0) => addBulkMock.mock.calls[call]![0] as BulkJob[];

describe('security agent coverage worker — partner → org fan-out', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scan enqueues one reconcile-partner job per partner, with colon-free slot ids', async () => {
    listPartnersMock.mockResolvedValueOnce(['p1', 'p2']);
    await expect(processSecurityAgentCoverageJob({ type: 'scan' })).resolves.toEqual({ partners: 2 });
    const jobs = bulk();
    expect(jobs.map((j) => [j.name, j.data])).toEqual([
      ['reconcile-partner', { type: 'reconcile-partner', partnerId: 'p1' }],
      ['reconcile-partner', { type: 'reconcile-partner', partnerId: 'p2' }],
    ]);
    for (const job of jobs) {
      // BullMQ rejects custom ids whose colon-split length !== 3 (#1101).
      expect(job.opts.jobId).not.toContain(':');
      expect(job.opts.jobId).toMatch(/^sa-coverage-partner-p\d-[0-9a-z]+$/);
    }
  });

  it('reconcile-partner enqueues one reconcile-org job per org of that partner', async () => {
    listOrgsMock.mockResolvedValueOnce(['o1', 'o2']);
    await expect(processSecurityAgentCoverageJob({ type: 'reconcile-partner', partnerId: 'p1' })).resolves.toEqual({ orgs: 2 });
    expect(listOrgsMock).toHaveBeenCalledWith('p1');
    expect(bulk().map((j) => j.data)).toEqual([
      { type: 'reconcile-org', partnerId: 'p1', orgId: 'o1' },
      { type: 'reconcile-org', partnerId: 'p1', orgId: 'o2' },
    ]);
    expect(bulk()[0]!.opts.jobId).toMatch(/^sa-coverage-org-o1-[0-9a-z]+$/);
  });

  it('empty partner / org lists enqueue nothing', async () => {
    await processSecurityAgentCoverageJob({ type: 'scan' });
    await processSecurityAgentCoverageJob({ type: 'reconcile-partner', partnerId: 'p1' });
    expect(addBulkMock).not.toHaveBeenCalled();
  });

  it('reconcile-org reconciles exactly that org', async () => {
    await processSecurityAgentCoverageJob({ type: 'reconcile-org', partnerId: 'p1', orgId: 'o9' });
    expect(reconcileMock).toHaveBeenCalledWith('o9');
  });

  it('an unknown job type throws', async () => {
    await expect(processSecurityAgentCoverageJob({ type: 'bogus' } as never)).rejects.toThrow(/Unknown security agent coverage job/);
  });
});
