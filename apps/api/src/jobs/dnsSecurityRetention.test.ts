import { PgDialect } from 'drizzle-orm/pg-core';
import { type SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  upsertJobSchedulerMock: vi.fn(),
  addMock: vi.fn(),
  getJobsMock: vi.fn(),
  attachMock: vi.fn(),
  recordRetentionRunMock: vi.fn(),
  pruneMock: vi.fn(),
  warnMock: vi.fn(),
  integrations: [] as Array<Record<string, unknown>>,
  lockedRows: [] as Array<{ id: string }>,
  deletes: [] as string[],
}));

vi.mock('bullmq', () => ({
  Queue: class {
    upsertJobScheduler = h.upsertJobSchedulerMock;
    add = h.addMock;
    getJobs = h.getJobsMock;
    close = vi.fn();
  },
  Worker: class {
    constructor(public name: string, public processor: unknown, public opts: unknown) {}
    on = vi.fn();
    close = vi.fn();
  },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: h.attachMock }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: h.recordRetentionRunMock }));
vi.mock('./retentionBatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./retentionBatch')>();
  return { ...actual, pruneInCtidBatches: h.pruneMock, warnOnRetentionBacklog: h.warnMock };
});
vi.mock('../db/schema', () => ({
  dnsFilterIntegrations: {
    id: 'dfi.id', orgId: 'dfi.org_id', config: 'dfi.config',
    isActive: 'dfi.is_active', lastSyncStatus: 'dfi.last_sync_status',
  },
  dnsPolicies: { integrationId: 'dp.integration_id' },
}));
vi.mock('../db', () => {
  const selectChain = () => {
    const chain: any = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      for: vi.fn(() => Promise.resolve(h.lockedRows)),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(h.integrations).then(resolve, reject),
    };
    return chain;
  };
  return {
    db: {
      execute: vi.fn(),
      select: vi.fn(() => selectChain()),
      delete: vi.fn((table: Record<string, string>) => ({
        where: vi.fn(async () => {
          h.deletes.push(table.integrationId ? 'dns_policies' : 'dns_filter_integrations');
          return [];
        }),
      })),
    },
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  };
});

import { jobSchedule } from './scheduleRegistry';
import {
  __testOnly,
  DNS_INTEGRATION_DELETING_STATUS,
  enqueueDnsIntegrationDelete,
  initializeDnsSecurityRetention,
  runDnsIntegrationDelete,
  runDnsSecurityRetention,
} from './dnsSecurityRetention';

const DAY_MS = 86_400_000;
const ORG = '11111111-1111-1111-1111-111111111111';
const INT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const INT_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const INT_DEL = 'dddddddd-0000-0000-0000-000000000003';
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const render = (where: SQL) => {
  const q = new PgDialect().sqlToQuery(where);
  return { sql: flat(q.sql), params: q.params };
};
const pruneCalls = () => h.pruneMock.mock.calls.map((c) => c[0] as { table: string; where: SQL; batchSize: number; maxBatches: number });

describe('dns security retention sweep (#10020)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.integrations = [];
    h.lockedRows = [];
    h.deletes = [];
    h.pruneMock.mockResolvedValue({ deleted: 0, batches: 1, hasMore: false });
    h.getJobsMock.mockResolvedValue([]);
    h.addMock.mockResolvedValue({ id: 'job-1' });
  });

  it('defaults to 90 days when an integration has no retentionDays', () => {
    expect(__testOnly.DEFAULT_DNS_SECURITY_RETENTION_DAYS).toBe(90);
    expect(__testOnly.MAX_RETENTION_DAYS).toBe(365);
  });

  it('prunes BOTH events and aggregations per integration, using its retentionDays or the default', async () => {
    h.integrations = [
      { id: INT_A, orgId: ORG, config: { retentionDays: 7 }, isActive: true, lastSyncStatus: 'success' },
      { id: INT_B, orgId: ORG, config: { organizationId: 'x' }, isActive: true, lastSyncStatus: 'success' },
    ];
    const before = Date.now();
    await runDnsSecurityRetention({});

    const calls = pruneCalls();
    const forA = calls.filter((c) => render(c.where).params.includes(INT_A));
    const forB = calls.filter((c) => render(c.where).params.includes(INT_B));
    expect(forA.map((c) => c.table).sort()).toEqual(['dns_event_aggregations', 'dns_security_events']);
    expect(forB.map((c) => c.table).sort()).toEqual(['dns_event_aggregations', 'dns_security_events']);

    const evA = render(forA.find((c) => c.table === 'dns_security_events')!.where);
    expect(evA.sql).toContain('"timestamp" <');
    expect(evA.sql).toContain('org_id =');
    const cutoffA = Date.parse(evA.params.find((p) => typeof p === 'string' && p.includes('T')) as string);
    expect(cutoffA).toBeGreaterThanOrEqual(before - 7 * DAY_MS - 1000);
    expect(cutoffA).toBeLessThanOrEqual(Date.now() - 7 * DAY_MS + 1000);

    const evB = render(forB.find((c) => c.table === 'dns_security_events')!.where);
    const cutoffB = Date.parse(evB.params.find((p) => typeof p === 'string' && p.includes('T')) as string);
    expect(cutoffB).toBeLessThanOrEqual(Date.now() - 90 * DAY_MS + 1000);
    expect(cutoffB).toBeGreaterThanOrEqual(before - 90 * DAY_MS - 1000);

    const aggA = render(forA.find((c) => c.table === 'dns_event_aggregations')!.where);
    expect(aggA.sql).toContain('"date" <');
    expect(aggA.params).toContain(new Date(cutoffA).toISOString().slice(0, 10));
  });

  it('also prunes legacy aggregation rows with no integration at the default window', async () => {
    await runDnsSecurityRetention({});
    const legacy = pruneCalls().find((c) => c.table === 'dns_event_aggregations' && render(c.where).sql.includes('integration_id IS NULL'));
    expect(legacy).toBeDefined();
  });

  it('uses the configured batch size and batch cap on every prune', async () => {
    h.integrations = [{ id: INT_A, orgId: ORG, config: {}, isActive: true, lastSyncStatus: null }];
    await runDnsSecurityRetention({ batchSize: 50, maxBatches: 3 });
    for (const c of pruneCalls()) {
      expect(c.batchSize).toBe(50);
      expect(c.maxBatches).toBe(3);
    }
  });

  it('skips integrations being deleted and re-enqueues a stranded delete', async () => {
    h.integrations = [
      { id: INT_DEL, orgId: ORG, config: {}, isActive: false, lastSyncStatus: DNS_INTEGRATION_DELETING_STATUS },
    ];
    await runDnsSecurityRetention({});
    expect(pruneCalls().some((c) => render(c.where).params.includes(INT_DEL))).toBe(false);
    expect(h.addMock).toHaveBeenCalledWith(
      __testOnly.DELETE_JOB_NAME,
      { integrationId: INT_DEL },
      expect.any(Object),
    );
  });

  it('does not re-enqueue a delete that is already queued', async () => {
    h.integrations = [
      { id: INT_DEL, orgId: ORG, config: {}, isActive: false, lastSyncStatus: DNS_INTEGRATION_DELETING_STATUS },
    ];
    h.getJobsMock.mockResolvedValue([{ name: __testOnly.DELETE_JOB_NAME, data: { integrationId: INT_DEL } }]);
    await runDnsSecurityRetention({});
    expect(h.addMock).not.toHaveBeenCalled();
  });

  it('still applies retention to an integration that is merely inactive', async () => {
    h.integrations = [{ id: INT_A, orgId: ORG, config: {}, isActive: false, lastSyncStatus: 'error' }];
    await runDnsSecurityRetention({});
    expect(pruneCalls().filter((c) => render(c.where).params.includes(INT_A))).toHaveLength(2);
    expect(h.addMock).not.toHaveBeenCalled();
  });

  it('reports the backlog and an incomplete run when a prune hits its cap', async () => {
    h.integrations = [{ id: INT_A, orgId: ORG, config: {}, isActive: true, lastSyncStatus: null }];
    h.pruneMock.mockImplementation(async (opts: { table: string }) =>
      opts.table === 'dns_security_events'
        ? { deleted: 10, batches: 2, hasMore: true }
        : { deleted: 1, batches: 1, hasMore: false },
    );
    const result = await runDnsSecurityRetention({});
    expect(result.hasMore).toBe(true);
    expect(h.warnMock).toHaveBeenCalledWith(
      expect.any(String), 'dns_security_events', { deleted: 10, batches: 2, hasMore: true }, expect.stringContaining(INT_A),
    );
    expect(h.recordRetentionRunMock).toHaveBeenCalledWith('dns_security_retention', { rowsDeleted: result.deleted, incomplete: true });
  });

  it('registers a daily cron slot from the schedule registry', async () => {
    await initializeDnsSecurityRetention();
    expect(h.attachMock).toHaveBeenCalledWith(expect.anything(), 'dnsSecurityRetention');
    expect(h.upsertJobSchedulerMock.mock.calls[0]![1]).toEqual({ pattern: jobSchedule('dns-security-retention') });
  });
});

describe('dns integration background delete (#10019)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.integrations = [];
    h.lockedRows = [];
    h.deletes = [];
    h.pruneMock.mockResolvedValue({ deleted: 0, batches: 1, hasMore: false });
    h.getJobsMock.mockResolvedValue([]);
    h.addMock.mockResolvedValue({ id: 'job-1' });
  });

  it('enqueues a delete job carrying only the integration id', async () => {
    await enqueueDnsIntegrationDelete(INT_DEL);
    expect(h.addMock).toHaveBeenCalledWith(
      __testOnly.DELETE_JOB_NAME,
      { integrationId: INT_DEL },
      expect.objectContaining({ attempts: expect.any(Number) }),
    );
  });

  it('refuses to delete anything for an integration that is still active', async () => {
    h.integrations = [{ id: INT_A, isActive: true, lastSyncStatus: 'success' }];
    const result = await runDnsIntegrationDelete({ integrationId: INT_A });
    expect(result.status).toBe('skipped_active');
    expect(h.pruneMock).not.toHaveBeenCalled();
    expect(h.deletes).toEqual([]);
  });

  it('is a no-op when the integration is already gone', async () => {
    h.integrations = [];
    const result = await runDnsIntegrationDelete({ integrationId: INT_A });
    expect(result.status).toBe('gone');
    expect(h.pruneMock).not.toHaveBeenCalled();
  });

  it('drains aggregations then events in batches, then deletes policies and the integration row', async () => {
    h.integrations = [{ id: INT_DEL, isActive: false, lastSyncStatus: DNS_INTEGRATION_DELETING_STATUS }];
    h.lockedRows = [{ id: INT_DEL }];
    h.pruneMock.mockResolvedValue({ deleted: 3, batches: 1, hasMore: false });

    const result = await runDnsIntegrationDelete({ integrationId: INT_DEL });

    expect(pruneCalls().map((c) => c.table)).toEqual(['dns_event_aggregations', 'dns_security_events']);
    for (const c of pruneCalls()) {
      const r = render(c.where);
      expect(r.sql).toBe('integration_id = $1');
      expect(r.params).toEqual([INT_DEL]);
    }
    expect(h.deletes).toEqual(['dns_policies', 'dns_filter_integrations']);
    expect(result).toMatchObject({ status: 'deleted', eventsDeleted: 3, aggregationsDeleted: 3 });
    expect(h.addMock).not.toHaveBeenCalled();
  });

  it('enqueues a continuation instead of deleting the row when a table still has rows past the batch cap', async () => {
    h.integrations = [{ id: INT_DEL, isActive: false, lastSyncStatus: DNS_INTEGRATION_DELETING_STATUS }];
    h.pruneMock.mockResolvedValueOnce({ deleted: 100, batches: 2, hasMore: true });

    const result = await runDnsIntegrationDelete({ integrationId: INT_DEL, batchSize: 50, maxBatches: 2 });

    expect(result.status).toBe('continuing');
    expect(pruneCalls()).toHaveLength(1);
    expect(h.deletes).toEqual([]);
    expect(h.addMock).toHaveBeenCalledWith(
      __testOnly.DELETE_JOB_NAME,
      { integrationId: INT_DEL, batchSize: 50, maxBatches: 2 },
      expect.any(Object),
    );
  });

  it('leaves the row alone if it was reactivated between the drain and the final delete', async () => {
    h.integrations = [{ id: INT_DEL, isActive: false, lastSyncStatus: DNS_INTEGRATION_DELETING_STATUS }];
    h.lockedRows = [];
    const result = await runDnsIntegrationDelete({ integrationId: INT_DEL });
    expect(result.status).toBe('skipped_active');
    expect(h.deletes).toEqual([]);
  });
});
