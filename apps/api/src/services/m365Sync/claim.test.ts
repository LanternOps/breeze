import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimAndEnqueue, claimDueDomains, syncJobId } from './claim';
import type { M365SyncJobData } from './types';

describe('syncJobId', () => {
  const D = { orgId: '11111111-1111-4111-8111-111111111111', domain: 'users' as const, generation: 7 };

  it('contains NO colon — BullMQ rejects custom job ids that do', () => {
    expect(syncJobId(D)).not.toContain(':');
  });

  it('is `m365-sync-<org>-<domain>-<generation>`', () => {
    expect(syncJobId(D)).toBe('m365-sync-11111111-1111-4111-8111-111111111111-users-7');
  });

  it('changes with the generation, so a new claim is never blocked by a retained old job', () => {
    expect(syncJobId({ ...D, generation: 8 })).not.toBe(syncJobId(D));
  });

  it('is stable for the same (org, domain, generation), so a duplicate enqueue collapses', () => {
    expect(syncJobId(D)).toBe(syncJobId({ ...D }));
  });

  it('separates domains within one org', () => {
    expect(syncJobId({ ...D, domain: 'skus' })).not.toBe(syncJobId(D));
  });
});

const { dbMocks, queueMocks } = vi.hoisted(() => ({
  dbMocks: { execute: vi.fn(), systemDepth: 0 },
  queueMocks: { enqueue: vi.fn(async (_data: M365SyncJobData) => 'job-1') },
}));

vi.mock('../../db', () => ({
  db: { execute: dbMocks.execute },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    dbMocks.systemDepth += 1;
    try { return await fn(); } finally { dbMocks.systemDepth -= 1; }
  }),
}));
vi.mock('../../jobs/m365SyncQueue', () => ({ enqueueSyncDomain: queueMocks.enqueue }));

describe('claimDueDomains', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.systemDepth = 0; });

  it('runs inside a SYSTEM db context — a cross-org scheduler read is denied without one', async () => {
    dbMocks.execute.mockImplementation(async () => {
      expect(dbMocks.systemDepth).toBeGreaterThan(0);
      return { rows: [] };
    });
    await claimDueDomains({ limit: 10 });
    expect(dbMocks.execute).toHaveBeenCalledTimes(1);
  });

  it('maps claimed rows into fully-formed job payloads at priority 10 by default', async () => {
    dbMocks.execute.mockResolvedValue({ rows: [{
      org_id: 'org-1', domain: 'users', run_generation: 4,
      connection_id: 'conn-1', tenant_id: 'tenant-1', consent_generation: 2,
    }] });
    await expect(claimDueDomains({ limit: 10 })).resolves.toEqual([{
      orgId: 'org-1', domain: 'users', generation: 4,
      connectionId: 'conn-1', tenantId: 'tenant-1', consentGeneration: 2, priority: 10,
    }]);
  });

  it('stamps priority 1 when the caller asks for the on-demand lane', async () => {
    dbMocks.execute.mockResolvedValue({ rows: [{
      org_id: 'org-1', domain: 'skus', run_generation: 1,
      connection_id: 'conn-1', tenant_id: 'tenant-1', consent_generation: 0,
    }] });
    const [job] = await claimDueDomains({ limit: 10, priority: 1 });
    expect(job!.priority).toBe(1);
  });

  it('returns [] on an empty claim without enqueuing anything', async () => {
    dbMocks.execute.mockResolvedValue({ rows: [] });
    await expect(claimDueDomains({ limit: 10 })).resolves.toEqual([]);
    expect(queueMocks.enqueue).not.toHaveBeenCalled();
  });
});

describe('claimAndEnqueue', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sets next_sync_at = now BEFORE claiming, then enqueues each claimed row', async () => {
    const calls: string[] = [];
    dbMocks.execute.mockImplementation(async (statement: unknown) => {
      calls.push(String((statement as { queryChunks?: unknown[] }).queryChunks ? 'sql' : 'sql'));
      return calls.length === 1
        ? { rows: [] }
        : { rows: [{ org_id: 'org-1', domain: 'users', run_generation: 3,
            connection_id: 'conn-1', tenant_id: 'tenant-1', consent_generation: 1 }] };
    });
    await claimAndEnqueue('org-1', ['users'], 1);
    expect(dbMocks.execute).toHaveBeenCalledTimes(2);   // the due-now update, then the claim
    expect(queueMocks.enqueue).toHaveBeenCalledTimes(1);
    expect(queueMocks.enqueue.mock.calls[0]![0]).toMatchObject({ orgId: 'org-1', domain: 'users', priority: 1 });
  });

  it('enqueues OUTSIDE the db context, never with a pooled connection held (#1105)', async () => {
    dbMocks.execute.mockResolvedValue({ rows: [{ org_id: 'org-1', domain: 'users', run_generation: 3,
      connection_id: 'conn-1', tenant_id: 'tenant-1', consent_generation: 1 }] });
    queueMocks.enqueue.mockImplementation(async () => {
      expect(dbMocks.systemDepth).toBe(0);
      return 'job-1';
    });
    await claimAndEnqueue('org-1', ['users'], 1);
    expect(queueMocks.enqueue).toHaveBeenCalled();
  });

  it('a failing enqueue does NOT abandon the rest of an already-claimed batch, but rejects with the FIRST error', async () => {
    let call = 0;
    dbMocks.execute.mockImplementation(async () => {
      call += 1;
      if (call === 1) return { rows: [] };   // the "make due" update
      return { rows: [
        { org_id: 'org-1', domain: 'users', run_generation: 1, connection_id: 'c', tenant_id: 't', consent_generation: 0 },
        { org_id: 'org-1', domain: 'skus', run_generation: 1, connection_id: 'c', tenant_id: 't', consent_generation: 0 },
        { org_id: 'org-1', domain: 'ca_policies', run_generation: 1, connection_id: 'c', tenant_id: 't', consent_generation: 0 },
      ] };
    });
    const boom = new Error('redis blip');
    queueMocks.enqueue
      .mockResolvedValueOnce('job-1')
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce('job-3');

    await expect(claimAndEnqueue('org-1', ['users', 'skus', 'ca_policies'], 1)).rejects.toBe(boom);
    // Every claimed row was already leased — abandoning the ones after the
    // failure would strand them until the 20-minute lease expires.
    expect(queueMocks.enqueue).toHaveBeenCalledTimes(3);
  });
});
