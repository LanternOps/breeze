import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// #1896 — the SentinelOne sync worker must NOT hold a pooled DB connection in an
// open transaction across its external HTTP calls (agent/threat fetch, per-action
// status poll) or its event-bus publishes. Same depth-tracking model as the
// DNS/Huntress sync tests: withSystemDbAccessContext increments depth,
// runOutsideDbContext zeroes it; assert the S1 HTTP + Redis publishes run at
// depth 0 while DB reads/writes run at depth > 0.
// ---------------------------------------------------------------------------

let contextDepth = 0;
const httpDepths: number[] = [];
const publishDepths: number[] = [];
const dbCallDepths: number[] = [];
let selectResults: unknown[][] = [];
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
      return chain([{ id: 'row-1' }]);
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

vi.mock('../services/secretCrypto', () => ({
  decryptForColumn: (_t: string, _c: string, value: unknown) => value ?? 'decrypted',
}));

const listAgentsMock = vi.fn(async () => {
  httpDepths.push(contextDepth);
  return { results: [], truncated: false };
});
const listThreatsMock = vi.fn(async () => {
  httpDepths.push(contextDepth);
  return { results: [], truncated: false };
});
const getActivityStatusMock = vi.fn(async () => {
  httpDepths.push(contextDepth);
  return { status: 'completed', details: null };
});

vi.mock('../services/sentinelOne/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sentinelOne/client')>();
  class MockSentinelOneClient {
    listAgents = listAgentsMock;
    listThreats = listThreatsMock;
    getActivityStatus = getActivityStatusMock;
  }
  return { ...actual, SentinelOneClient: MockSentinelOneClient };
});

vi.mock('../services/sentinelOne/metrics', () => ({
  recordS1ActionDispatch: vi.fn(),
  recordS1ActionPollTransition: vi.fn(),
  recordS1SyncRun: vi.fn(),
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn(async () => {
    publishDepths.push(contextDepth);
  }),
}));

const { processSyncIntegration, processPollActions } = await import('./s1Sync');

describe('s1Sync — DB context boundaries (#1896)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextDepth = 0;
    httpDepths.length = 0;
    publishDepths.length = 0;
    dbCallDepths.length = 0;
    selectResults = [];
    updatePayloads.length = 0;
  });

  it('processSyncIntegration: fetches agents + threats with no DB context held, persists inside one', async () => {
    // Phase 1 integration read.
    selectResults = [
      [{
        id: 'int-1',
        partnerId: 'partner-1',
        managementUrl: 'https://s1.example.com',
        apiTokenEncrypted: 'enc',
        isActive: true,
        lastSyncAt: null,
      }],
    ];

    const result = await processSyncIntegration({
      type: 'sync-integration',
      integrationId: 'int-1',
      syncAgents: true,
      syncThreats: true,
    });

    expect(listAgentsMock).toHaveBeenCalledTimes(1);
    expect(listThreatsMock).toHaveBeenCalledTimes(1);
    // Both provider fetches ran with NO transaction held.
    expect(httpDepths).toEqual([0, 0]);
    // Every DB read/write ran inside a context.
    expect(dbCallDepths.length).toBeGreaterThan(0);
    for (const depth of dbCallDepths) {
      expect(depth).toBeGreaterThan(0);
    }
    // The final status write committed inside a (short) context.
    const statusWrite = updatePayloads.find((u) => u.payload.lastSyncStatus !== undefined);
    expect(statusWrite).toBeDefined();
    expect(statusWrite!.depth).toBeGreaterThan(0);
    expect(result.integrationId).toBe('int-1');
  });

  it('processSyncIntegration: on fetch failure records error status on a fresh context and re-throws the ORIGINAL error', async () => {
    selectResults = [
      [{
        id: 'int-1',
        partnerId: 'partner-1',
        managementUrl: 'https://s1.example.com',
        apiTokenEncrypted: 'enc',
        isActive: true,
        lastSyncAt: null,
      }],
    ];
    const boom = new Error('s1 agents fetch exploded');
    listAgentsMock.mockRejectedValueOnce(boom);

    await expect(
      processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1', syncAgents: true, syncThreats: false }),
    ).rejects.toBe(boom);

    const errorWrite = updatePayloads.find((u) => u.payload.lastSyncStatus === 'error');
    expect(errorWrite).toBeDefined();
    expect(errorWrite!.depth).toBeGreaterThan(0);
  });

  it('processPollActions: polls the provider with no DB context held, writes status inside one', async () => {
    selectResults = [
      // 1. pending actions
      [{
        id: 'action-1',
        orgId: 'org-1',
        deviceId: 'device-1',
        action: 'quarantine',
        payload: {},
        providerActionId: 'provider-act-1',
      }],
      // 2. organizations → partner
      [{ id: 'org-1', partnerId: 'partner-A' }],
      // 3. s1_integrations for partner-A
      [{ partnerId: 'partner-A', managementUrl: 'https://s1.example.com', apiTokenEncrypted: 'enc' }],
    ];

    const result = await processPollActions();

    expect(getActivityStatusMock).toHaveBeenCalledTimes(1);
    expect(httpDepths).toEqual([0]);             // provider poll ran with no txn held
    expect(dbCallDepths.length).toBeGreaterThan(0);
    for (const depth of dbCallDepths) {
      expect(depth).toBeGreaterThan(0);          // reads + status write inside a context
    }
    // The completed-action event published OUTSIDE any held transaction.
    expect(publishDepths).toEqual([0]);
    expect(result.polled).toBe(1);
    expect(result.updated).toBe(1);
  });
});
