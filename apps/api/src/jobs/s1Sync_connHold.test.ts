/**
 * #1105 / #1896 conn-hold regression: the S1 sync worker must NOT hold a single
 * DB access context (open transaction) across SentinelOne HTTP calls.
 *
 * These tests instrument the DB-context boundary: `withSystemDbAccessContext`
 * increments a depth counter for the duration of its callback, and every mocked
 * primitive records whether it ran while that depth was > 0. The phase-split
 * contract is then asserted directly:
 *
 *   - DB reads/writes run INSIDE a (short) context  → depth > 0
 *   - the SentinelOne HTTP call runs OUTSIDE any context → depth === 0
 *
 * A regression that re-wraps the whole job/loop in one held context (the
 * pre-#1896 shape) makes the HTTP call observe depth > 0 and fails here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tracks the active withSystemDbAccessContext nesting depth so each mocked
// primitive can record whether it ran inside a held context.
let contextDepth = 0;
const inContext = () => contextDepth > 0;

const selectContexts: boolean[] = [];
const updateContexts: boolean[] = [];
const httpContexts: boolean[] = [];

// SELECT chain: awaitable at `.where()` (via .then) and at `.limit()`.
function selectReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'innerJoin', 'leftJoin']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.limit = vi.fn().mockResolvedValue(rows);
  chain.then = (resolve: (value: unknown[]) => unknown) => resolve(rows);
  return chain;
}

// Rows handed back by successive db.select() calls in processPollActions:
//   1) pending s1_actions, 2) organizations (org→partner), 3) active integrations.
let selectRowsQueue: unknown[][] = [];

const mockDb = {
  select: vi.fn().mockImplementation(() => {
    selectContexts.push(inContext());
    const rows = selectRowsQueue.shift() ?? [];
    return selectReturning(rows);
  }),
  update: vi.fn().mockImplementation(() => {
    updateContexts.push(inContext());
    return { set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) };
  }),
  insert: vi.fn(),
  delete: vi.fn(),
};

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => {
    contextDepth += 1;
    try {
      return await fn();
    } finally {
      contextDepth -= 1;
    }
  },
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  hasDbAccessContext: () => contextDepth > 0,
}));

vi.mock('../services/secretCrypto', () => ({
  decryptForColumn: () => 'decrypted-token',
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/sentinelOne/metrics', () => ({
  recordS1ActionDispatch: vi.fn(),
  recordS1ActionPollTransition: vi.fn(),
  recordS1SyncRun: vi.fn(),
}));

const getActivityStatusMock = vi.fn();
const listAgentsMock = vi.fn();
const listThreatsMock = vi.fn();

vi.mock('../services/sentinelOne/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sentinelOne/client')>();
  class MockSentinelOneClient {
    listAgents = listAgentsMock;
    listThreats = listThreatsMock;
    getActivityStatus = getActivityStatusMock;
  }
  return { ...actual, SentinelOneClient: MockSentinelOneClient };
});

const { processPollActions, processSyncIntegration } = await import('./s1Sync');

describe('processPollActions conn-hold phase-split (#1105/#1896)', () => {
  beforeEach(() => {
    contextDepth = 0;
    selectContexts.length = 0;
    updateContexts.length = 0;
    httpContexts.length = 0;
    selectRowsQueue = [
      // 1) pending actions
      [{
        id: 'action-1',
        orgId: 'org-1',
        deviceId: 'device-1',
        action: 'isolate',
        payload: {},
        providerActionId: 'provider-1',
      }],
      // 2) organizations → partner resolution
      [{ id: 'org-1', partnerId: 'partner-1' }],
      // 3) active integration for the partner
      [{ partnerId: 'partner-1', managementUrl: 'https://example.sentinelone.net', apiTokenEncrypted: 'enc' }],
    ];
    getActivityStatusMock.mockReset();
    getActivityStatusMock.mockImplementation(() => {
      // Record the context depth observed at the moment the HTTP call fires.
      httpContexts.push(inContext());
      return Promise.resolve({ status: 'completed', details: null });
    });
  });

  it('runs the SentinelOne getActivityStatus HTTP call OUTSIDE any held DB context', async () => {
    const result = await processPollActions();

    expect(result).toEqual({ polled: 1, updated: 1 });
    // The HTTP poll ran exactly once, and NOT inside a held transaction.
    expect(httpContexts).toEqual([false]);
  });

  it('still performs the status write INSIDE a short DB context', async () => {
    await processPollActions();

    // The s1_actions status update ran, and every such write was wrapped in a context.
    expect(updateContexts.length).toBeGreaterThan(0);
    expect(updateContexts.every((v) => v === true)).toBe(true);
  });

  it('reads the action/org/integration rows INSIDE a DB context', async () => {
    await processPollActions();

    expect(selectContexts.length).toBe(3);
    expect(selectContexts.every((v) => v === true)).toBe(true);
  });
});

describe('processSyncIntegration conn-hold phase-split (#1105/#1896)', () => {
  beforeEach(() => {
    contextDepth = 0;
    selectContexts.length = 0;
    updateContexts.length = 0;
    httpContexts.length = 0;
    // Only the initial integration read returns a row; the agent/threat upserts
    // are skipped (empty results), so remaining selects (mapSiteOrgIds, agentRows)
    // default to [] and the only write is the final s1_integrations status update.
    selectRowsQueue = [
      [{
        id: 'integration-1',
        partnerId: 'partner-1',
        managementUrl: 'https://example.sentinelone.net',
        apiTokenEncrypted: 'enc',
        isActive: true,
        lastSyncAt: null,
      }],
    ];
    for (const mock of [listAgentsMock, listThreatsMock]) {
      mock.mockReset();
      mock.mockImplementation(() => {
        httpContexts.push(inContext());
        return Promise.resolve({ results: [], truncated: false });
      });
    }
  });

  it('runs listAgents and listThreats OUTSIDE any held DB context, writes status INSIDE one', async () => {
    await processSyncIntegration({ type: 'sync-integration', integrationId: 'integration-1', syncAgents: true, syncThreats: true });

    // Both SentinelOne fetches ran, and neither was inside a held transaction.
    expect(httpContexts).toEqual([false, false]);
    // The integration read + the lastSyncAt/status write each ran inside a context.
    expect(selectContexts[0]).toBe(true);
    expect(updateContexts.length).toBeGreaterThan(0);
    expect(updateContexts.every((v) => v === true)).toBe(true);
  });
});
