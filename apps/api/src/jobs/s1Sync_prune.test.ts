/**
 * (#9248) Absent-agent marking. Original header: C2 site-discovery and provisional-mapping reconciliation tests.
 *
 * Tests the DB-touching helpers:
 *   - upsertDiscoveredSites: one row per distinct site, correct agents_count
 *   - reconcileProvisionalSiteMappings: provisional row rewritten to real site id,
 *     org_id preserved, no provisional row survives
 *   - syncAgentsForIntegration: agents whose site is unmapped are SKIPPED (counted)
 *
 * Follows the s1Sync_syncError.test.ts pattern: module-level vi.mock + dynamic
 * import so the DB mock is in place before the module resolves its `db` binding.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── DB mock ─────────────────────────────────────────────────────────────────

const insertedValues: Array<Record<string, unknown>> = [];
const updatedPayloads: Array<Record<string, unknown>> = [];
const deletedWhere: Array<unknown> = [];

/**
 * Tracks args for INSERT ... values(...).onConflictDoUpdate chains.
 * db.insert(table) → chain; chain.values(rows) captures rows and returns chain.
 * Returns a chain whose final `.returning()` resolves to [].
 */
function makeInsertMock() {
  return vi.fn().mockImplementation(() => {
    // db.insert(table) — returns a chain with .values()
    const chain = {
      values: vi.fn().mockImplementation((rows: Record<string, unknown> | Record<string, unknown>[]) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        insertedValues.push(...arr);
        return chain;
      }),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    };
    // make thenable so `await db.insert(t).values(v)` works without explicit .returning()
    (chain as unknown as Record<string, unknown>).then = (resolve: (v: unknown[]) => unknown) => resolve([]);
    return chain;
  });
}

function makeUpdateMock() {
  return vi.fn().mockImplementation(() => ({
    set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      updatedPayloads.push(payload);
      return { where: vi.fn().mockResolvedValue([]) };
    }),
  }));
}

function makeDeleteMock() {
  return vi.fn().mockImplementation(() => ({
    where: vi.fn().mockImplementation((clause: unknown) => {
      deletedWhere.push(clause);
      return Promise.resolve([]);
    }),
  }));
}

// SELECT chain: returns `rows` when awaited.
function selectReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'innerJoin', 'leftJoin']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.limit = vi.fn().mockResolvedValue(rows);
  chain.then = (resolve: (value: unknown[]) => unknown) => resolve(rows);
  return chain;
}

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: <T>(fn: () => Promise<T> | T): Promise<T> | T => fn(),
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
}));

vi.mock('../services/secretCrypto', () => ({
  decryptForColumn: () => 'decrypted-token',
  encryptSecret: (value: string) => `enc:${value}`,
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/sentinelOne/metrics', () => ({
  recordS1ActionDispatch: vi.fn(),
  recordS1ActionPollTransition: vi.fn(),
  recordS1SyncRun: vi.fn(),
}));

// ── Mock SentinelOneClient ───────────────────────────────────────────────────

const listAgentsMock = vi.fn();
const listThreatsMock = vi.fn().mockResolvedValue({ results: [], truncated: false });
const listSitesMock = vi.fn().mockResolvedValue([]);
const getActivityStatusMock = vi.fn();

vi.mock('../services/sentinelOne/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sentinelOne/client')>();
  class MockSentinelOneClient {
    listAgents = listAgentsMock;
    listThreats = listThreatsMock;
    listSites = listSitesMock;
    getActivityStatus = getActivityStatusMock;
  }
  return { ...actual, SentinelOneClient: MockSentinelOneClient };
});

// ── Dynamic import (after mocks) ─────────────────────────────────────────────

const { processSyncIntegration } = await import('./s1Sync');

function agent(id: string) {
  return {
    id, siteId: 'site-mapped', siteName: 'Mapped Site', isActive: true, infected: false,
    activeThreats: 0, policyName: null, lastSeen: null, uuid: null, computerName: id,
    machineType: null, osName: null, updatedAt: null, networkInterfaces: [],
  };
}

function prime(integration: Record<string, unknown>) {
  mockDb.select
    .mockReturnValueOnce(selectReturning([{
      id: 'int-1', partnerId: 'partner-1', managementUrl: 'https://example.sentinelone.net',
      apiTokenEncrypted: 'enc', isActive: true, lastSyncAt: null, lastFullAgentSyncAt: null, ...integration,
    }]))
    .mockReturnValueOnce(selectReturning([]))
    .mockReturnValueOnce(selectReturning([{ s1SiteId: 'site-mapped', orgId: 'org-1' }]))
    .mockReturnValue(selectReturning([]));
}

const run = () => processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1', syncAgents: true, syncThreats: false });
const absentUpdates = () => updatedPayloads.filter((p) => p.status === 'absent');
const fullStamps = () => updatedPayloads.filter((p) => 'lastFullAgentSyncAt' in p);

describe('#9248 s1Sync marks agents the console no longer returns as absent', () => {
  beforeEach(() => {
    insertedValues.length = 0;
    updatedPayloads.length = 0;
    deletedWhere.length = 0;
    mockDb.select.mockReset();
    mockDb.insert = makeInsertMock();
    mockDb.update = makeUpdateMock();
    mockDb.delete = makeDeleteMock();
    listAgentsMock.mockReset();
    listSitesMock.mockResolvedValue([]);
  });

  it('a full, complete listing marks rows missing from it absent and stamps the full-sync time', async () => {
    prime({});
    listAgentsMock.mockResolvedValue({ results: [agent('a1')], truncated: false });
    await run();
    expect(listAgentsMock).toHaveBeenCalledWith(undefined); // full listing, not incremental
    expect(absentUpdates()).toHaveLength(1);
    expect(fullStamps()).toHaveLength(1);
  });

  it('a recent full sync keeps the cheap incremental fetch and never marks absent', async () => {
    const since = new Date(Date.now() - 15 * 60_000);
    prime({ lastSyncAt: since, lastFullAgentSyncAt: new Date(Date.now() - 60 * 60_000) });
    listAgentsMock.mockResolvedValue({ results: [agent('a1')], truncated: false });
    await run();
    expect(listAgentsMock).toHaveBeenCalledWith(since);
    expect(absentUpdates()).toHaveLength(0);
    expect(fullStamps()).toHaveLength(0);
  });

  it('a stale full sync (older than 6h) triggers a full listing again', async () => {
    prime({ lastSyncAt: new Date(), lastFullAgentSyncAt: new Date(Date.now() - 7 * 60 * 60_000) });
    listAgentsMock.mockResolvedValue({ results: [agent('a1')], truncated: false });
    await run();
    expect(listAgentsMock).toHaveBeenCalledWith(undefined);
    expect(absentUpdates()).toHaveLength(1);
  });

  it('a truncated full listing leaves rows untouched', async () => {
    prime({});
    listAgentsMock.mockResolvedValue({ results: [agent('a1')], truncated: true });
    await run();
    expect(absentUpdates()).toHaveLength(0);
    expect(fullStamps()).toHaveLength(0);
  });

  it('a failed listing leaves rows untouched', async () => {
    prime({});
    listAgentsMock.mockRejectedValue(new Error('boom'));
    await expect(run()).rejects.toThrow('boom');
    expect(absentUpdates()).toHaveLength(0);
    expect(fullStamps()).toHaveLength(0);
  });

  it('an empty full listing is not trusted to wipe every row', async () => {
    prime({});
    listAgentsMock.mockResolvedValue({ results: [], truncated: false });
    await run();
    expect(absentUpdates()).toHaveLength(0);
  });
});
