import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// #1697 — the DNS sync worker must NOT hold a pooled DB connection in an open
// transaction across its external provider HTTP (event fetch + domain
// mutations). Same depth-tracking model as the Huntress/Pax8 sync tests:
// withSystemDbAccessContext increments depth, runOutsideDbContext zeroes it;
// assert the provider calls run at depth 0 while DB reads/writes run at depth
// > 0, for both the event-sync and policy-sync paths.
// ---------------------------------------------------------------------------

let contextDepth = 0;
const fetchDepths: number[] = [];
const dbCallDepths: number[] = [];
let selectResults: unknown[][] = [];
// `.set(payload)` calls (update writes) with the context depth at call time.
const updatePayloads: Array<{ depth: number; payload: Record<string, unknown> }> = [];

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of [
    'from', 'where', 'limit', 'values', 'returning',
    'onConflictDoNothing', 'onConflictDoUpdate', 'innerJoin', 'leftJoin',
  ]) {
    c[m] = vi.fn(() => c);
  }
  c.set = vi.fn((payload: Record<string, unknown>) => {
    updatePayloads.push({ depth: contextDepth, payload });
    return c;
  });
  (c as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain(selectResults.shift() ?? []);
    }),
    insert: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain([]);
    }),
    update: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain(undefined);
    }),
    delete: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain(undefined);
    }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    contextDepth += 1;
    try {
      return await fn();
    } finally {
      contextDepth -= 1;
    }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    const saved = contextDepth;
    contextDepth = 0;
    try {
      return fn();
    } finally {
      contextDepth = saved;
    }
  }),
}));

const createDnsProviderMock = vi.fn();
vi.mock('../services/dnsProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dnsProviders')>();
  return { ...actual, createDnsProvider: createDnsProviderMock };
});

vi.mock('../services/secretCrypto', () => ({
  decryptForColumn: (_t: string, _c: string, value: unknown) => value ?? 'decrypted',
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
  EVENT_TYPES: { DNS_THREAT_BLOCKED: 'dns.threat.blocked' },
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

const { processSyncIntegration, processPolicySync } = await import('./dnsSyncJob');

describe('dnsSyncJob — DB context boundaries (#1697)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextDepth = 0;
    fetchDepths.length = 0;
    dbCallDepths.length = 0;
    selectResults = [];
    updatePayloads.length = 0;
  });

  it('processSyncIntegration: fetches events with no DB context held, persists inside one', async () => {
    // Phase 1 integration read, then mapDevicesByIp's device read.
    selectResults = [
      [{ id: 'int-1', orgId: 'org-1', provider: 'pihole', apiKey: 'k', apiSecret: null, isActive: true, config: {}, lastSync: null }],
      [],
    ];
    const syncEvents = vi.fn(async () => {
      fetchDepths.push(contextDepth);
      return [];
    });
    createDnsProviderMock.mockReturnValue({ syncEvents });

    const result = await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });

    expect(syncEvents).toHaveBeenCalledTimes(1);
    expect(fetchDepths).toEqual([0]);            // fetch ran with no txn held
    expect(dbCallDepths.length).toBeGreaterThan(0);
    for (const depth of dbCallDepths) {
      expect(depth).toBeGreaterThan(0);          // reads/writes ran inside a context
    }
    expect(result.integrationId).toBe('int-1');
  });

  it('processPolicySync: pushes domain mutations with no DB context held, writes status inside one', async () => {
    selectResults = [
      [{
        policy: { id: 'pol-1', type: 'blocklist', domains: [{ domain: 'evil.example.com' }] },
        integration: { id: 'int-1', orgId: 'org-1', provider: 'adguard_home', apiKey: 'k', apiSecret: 's', config: {} },
      }],
    ];
    const addBlocklistDomain = vi.fn(async () => {
      fetchDepths.push(contextDepth);
    });
    createDnsProviderMock.mockReturnValue({
      addBlocklistDomain,
      removeBlocklistDomain: vi.fn(async () => {}),
    });

    const result = await processPolicySync({ type: 'sync-policy', policyId: 'pol-1' });

    expect(addBlocklistDomain).toHaveBeenCalledWith('evil.example.com');
    expect(fetchDepths).toEqual([0]);            // provider mutation ran with no txn held
    expect(dbCallDepths.length).toBeGreaterThan(0);
    for (const depth of dbCallDepths) {
      expect(depth).toBeGreaterThan(0);
    }
    expect(result.added).toBe(1);
  });

  it('processSyncIntegration: on fetch failure records error status on a fresh context and re-throws the ORIGINAL error', async () => {
    selectResults = [
      [{ id: 'int-1', orgId: 'org-1', provider: 'pihole', apiKey: 'k', apiSecret: null, isActive: true, config: {}, lastSync: null }],
    ];
    const boom = new Error('dns fetch exploded');
    createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn().mockRejectedValue(boom) });

    await expect(
      processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' }),
    ).rejects.toBe(boom);

    const errorWrite = updatePayloads.find((u) => u.payload.lastSyncStatus === 'error');
    expect(errorWrite).toBeDefined();
    expect(errorWrite!.depth).toBeGreaterThan(0);
  });

  it('processSyncIntegration: a failing error-status write does not mask the original sync error', async () => {
    selectResults = [
      [{ id: 'int-1', orgId: 'org-1', provider: 'pihole', apiKey: 'k', apiSecret: null, isActive: true, config: {}, lastSync: null }],
    ];
    const boom = new Error('dns fetch exploded');
    createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn().mockRejectedValue(boom) });
    const dbm = await import('../db');
    // Make the error-status bookkeeping write itself throw (e.g. pool exhausted).
    (dbm.db.update as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('pool exhausted');
    });

    // The ORIGINAL provider error must still propagate, not the bookkeeping failure.
    await expect(
      processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' }),
    ).rejects.toBe(boom);
  });
});
