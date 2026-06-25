/**
 * C2 site-discovery and provisional-mapping reconciliation tests.
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
  // #1896: the sync functions now open a short system context per DB touch, so
  // the mock must provide a passthrough (run fn against the mocked db immediately).
  withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
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

// ── Mock SentinelOneClient ───────────────────────────────────────────────────

const listAgentsMock = vi.fn();
const listThreatsMock = vi.fn().mockResolvedValue({ results: [], truncated: false });
const getActivityStatusMock = vi.fn();

vi.mock('../services/sentinelOne/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sentinelOne/client')>();
  class MockSentinelOneClient {
    listAgents = listAgentsMock;
    listThreats = listThreatsMock;
    getActivityStatus = getActivityStatusMock;
  }
  return { ...actual, SentinelOneClient: MockSentinelOneClient };
});

// ── Dynamic import (after mocks) ─────────────────────────────────────────────

const {
  upsertDiscoveredSites,
  reconcileProvisionalSiteMappings,
  processSyncIntegration,
  processPollActions,
} = await import('./s1Sync');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Prime a single integration SELECT returning one row with partnerId. */
function primeIntegration(extra: Partial<Record<string, unknown>> = {}) {
  mockDb.select
    .mockReturnValueOnce(
      selectReturning([{
        id: 'int-1',
        partnerId: 'partner-1',
        managementUrl: 'https://example.sentinelone.net',
        apiTokenEncrypted: 'enc',
        isActive: true,
        lastSyncAt: null,
        ...extra,
      }])
    )
    .mockReturnValue(selectReturning([]));
}

beforeEach(() => {
  vi.clearAllMocks();
  insertedValues.length = 0;
  updatedPayloads.length = 0;
  deletedWhere.length = 0;
  mockDb.insert.mockImplementation(makeInsertMock());
  mockDb.update.mockImplementation(makeUpdateMock());
  mockDb.delete.mockImplementation(makeDeleteMock());
  mockDb.select.mockReturnValue(selectReturning([]));
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('upsertDiscoveredSites', () => {
  it('upserts one row per distinct site with correct agents_count', async () => {
    await upsertDiscoveredSites({
      integrationId: 'int-1',
      partnerId: 'partner-1',
      sites: [
        { siteId: 'site-123', siteName: 'Acme', count: 3 },
        { siteId: 'site-456', siteName: 'Beta Corp', count: 7 },
      ],
    });

    // Two inserts (one per site)
    expect(insertedValues).toHaveLength(2);
    const site123 = insertedValues.find((v) => v.s1SiteId === 'site-123');
    const site456 = insertedValues.find((v) => v.s1SiteId === 'site-456');
    expect(site123).toBeDefined();
    expect(site123!.agentsCount).toBe(3);
    expect(site123!.s1SiteName).toBe('Acme');
    expect(site123!.integrationId).toBe('int-1');
    expect(site123!.partnerId).toBe('partner-1');
    expect(site456).toBeDefined();
    expect(site456!.agentsCount).toBe(7);
  });

  it('is a no-op when there are no sites', async () => {
    await upsertDiscoveredSites({ integrationId: 'int-1', partnerId: 'partner-1', sites: [] });
    expect(insertedValues).toHaveLength(0);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});

describe('reconcileProvisionalSiteMappings', () => {
  it('rewrites provisional row to real site id and preserves org_id (collision rule: UPDATE wins)', async () => {
    // Provisional row found for this integration + name
    mockDb.select.mockReturnValueOnce(
      selectReturning([{
        id: 'mapping-prov-1',
        s1SiteId: 'name:Acme',
        s1SiteName: 'Acme',
        orgId: 'org-O1',
        metadata: { provisional: true },
      }])
    );

    // No existing real row for site-123 (no conflict)
    mockDb.select.mockReturnValue(selectReturning([]));

    await reconcileProvisionalSiteMappings('int-1', [
      { siteId: 'site-123', siteName: 'Acme' },
    ]);

    // Should UPDATE the provisional row with the real site id
    expect(updatedPayloads.length).toBeGreaterThan(0);
    const rewrite = updatedPayloads.find((p) => p.s1SiteId === 'site-123');
    expect(rewrite).toBeDefined();
    // org_id must be preserved — the update does NOT null it out
    expect(rewrite!.orgId).toBe('org-O1');
  });

  it('deletes provisional row when a real row already exists for that siteId', async () => {
    // First SELECT: find provisional row matching 'name:Acme'
    mockDb.select
      .mockReturnValueOnce(
        selectReturning([{
          id: 'mapping-prov-1',
          s1SiteId: 'name:Acme',
          s1SiteName: 'Acme',
          orgId: 'org-O1',
          metadata: { provisional: true },
        }])
      )
      // Second SELECT: existing real row already present for site-123
      .mockReturnValueOnce(
        selectReturning([{
          id: 'mapping-real-1',
          s1SiteId: 'site-123',
          orgId: 'org-real',
          metadata: null,
        }])
      )
      .mockReturnValue(selectReturning([]));

    await reconcileProvisionalSiteMappings('int-1', [
      { siteId: 'site-123', siteName: 'Acme' },
    ]);

    // Provisional row must be deleted (real row wins)
    expect(deletedWhere.length).toBeGreaterThan(0);
    // Should NOT have written a rewrite update (real row stays)
    const rewrite = updatedPayloads.find((p) => p.s1SiteId === 'site-123');
    expect(rewrite).toBeUndefined();
  });

  it('is a no-op when there are no discovered sites', async () => {
    await reconcileProvisionalSiteMappings('int-1', []);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('C2 sync: unmapped agents are skipped (not written to a fallback org)', () => {
  it('agents whose site has no mapped org are skipped; no s1_agents row is written for them', async () => {
    primeIntegration();

    // Two agents: siteId 'site-mapped' has org-1 mapped, 'site-unmapped' has no mapping
    listAgentsMock.mockResolvedValue({
      results: [
        {
          id: 'agent-mapped',
          siteId: 'site-mapped',
          siteName: 'Mapped Site',
          isActive: true,
          infected: false,
          activeThreats: 0,
          policyName: null,
          lastSeen: null,
          uuid: null,
          computerName: 'desktop-a',
          machineType: null,
          osName: null,
          updatedAt: null,
          networkInterfaces: [],
        },
        {
          id: 'agent-unmapped',
          siteId: 'site-unmapped',
          siteName: 'Unmapped Site',
          isActive: true,
          infected: false,
          activeThreats: 0,
          policyName: null,
          lastSeen: null,
          uuid: null,
          computerName: 'desktop-b',
          machineType: null,
          osName: null,
          updatedAt: null,
          networkInterfaces: [],
        },
      ],
      truncated: false,
    });

    // Mock SELECT call sequence for processSyncIntegration:
    //  1. integration row
    //  2. reconcileProvisionalSiteMappings: provisional lookup for 'name:Mapped Site' → empty
    //  3. reconcileProvisionalSiteMappings: provisional lookup for 'name:Unmapped Site' → empty
    //  4. mapSiteOrgIds: s1OrgMappings rows (site-mapped → org-1)
    //  5. mapDeviceCandidatesByOrg: empty devices
    //  6+. update s1Integrations lastSyncAt → handled by update mock
    mockDb.select
      .mockReturnValueOnce(
        selectReturning([{
          id: 'int-1',
          partnerId: 'partner-1',
          managementUrl: 'https://example.sentinelone.net',
          apiTokenEncrypted: 'enc',
          isActive: true,
          lastSyncAt: null,
        }])
      )
      // reconcileProvisionalSiteMappings: no provisional rows for either site
      .mockReturnValueOnce(selectReturning([]))
      .mockReturnValueOnce(selectReturning([]))
      // mapSiteOrgIds: one mapped org (site-mapped → org-1)
      .mockReturnValueOnce(
        selectReturning([{
          s1SiteId: 'site-mapped',
          orgId: 'org-1',
        }])
      )
      // mapDeviceCandidatesByOrg: empty devices
      .mockReturnValue(selectReturning([]));

    await processSyncIntegration({
      type: 'sync-integration',
      integrationId: 'int-1',
      syncAgents: true,
      syncThreats: false,
    });

    // Check which agent rows were inserted
    const agentInserts = insertedValues.filter(
      (v) => 's1AgentId' in v || 'integrationId' in v
    );

    // Only the mapped agent should be inserted; unmapped must NOT appear
    const unmappedInsert = agentInserts.find((v) => v.s1AgentId === 'agent-unmapped');
    const mappedInsert = agentInserts.find((v) => v.s1AgentId === 'agent-mapped');
    expect(unmappedInsert).toBeUndefined();
    expect(mappedInsert).toBeDefined();
    expect(mappedInsert!.orgId).toBe('org-1');
  });
});

describe('processPollActions — partner-axis integration resolution', () => {
  /**
   * Fix 1 regression guard: processPollActions must resolve integrations via
   * org → partner → active integration, NOT via legacyOrgId. A partner-wide
   * integration with legacyOrgId NULL was previously missed, causing pending
   * actions to be permanently marked failed.
   *
   * SELECT call sequence inside processPollActions:
   *   1. s1_actions WHERE status IN ('queued','in_progress') AND providerActionId IS NOT NULL
   *   2. organizations WHERE id IN (orgIds) → partner_id lookup
   *   3. s1_integrations WHERE partner_id IN (partnerIds) AND is_active = true
   *   4. client.getActivityStatus() is called for each action
   */

  it('resolves a partner-wide integration (legacyOrgId NULL) and polls the action — not marked failed', async () => {
    // Pending action under org-1
    mockDb.select
      // 1. pending actions
      .mockReturnValueOnce(
        selectReturning([{
          id: 'action-1',
          orgId: 'org-1',
          deviceId: 'device-1',
          action: 'quarantine',
          payload: {},
          providerActionId: 'provider-act-1',
          status: 'queued',
        }])
      )
      // 2. organizations lookup: org-1 → partner-A
      .mockReturnValueOnce(
        selectReturning([{ id: 'org-1', partnerId: 'partner-A' }])
      )
      // 3. s1_integrations: partner-A has active integration with legacyOrgId NULL
      .mockReturnValueOnce(
        selectReturning([{
          partnerId: 'partner-A',
          managementUrl: 'https://s1.example.com',
          apiTokenEncrypted: 'enc',
          legacyOrgId: null, // partner-wide: no legacy org_id
        }])
      )
      .mockReturnValue(selectReturning([]));

    // Client returns a successful poll result
    getActivityStatusMock.mockResolvedValue({
      status: 'completed',
      details: null,
    });

    const result = await processPollActions();

    // Action was polled (not skipped as "no integration")
    expect(result.polled).toBe(1);
    expect(result.updated).toBe(1);

    // The DB update must have been called with 'completed', NOT 'failed'
    const failedUpdate = updatedPayloads.find(
      (p) => p.status === 'failed' && String(p.error ?? '').includes('no active SentinelOne integration')
    );
    expect(failedUpdate).toBeUndefined();

    const completedUpdate = updatedPayloads.find((p) => p.status === 'completed');
    expect(completedUpdate).toBeDefined();
  });

  it('marks an action failed when the org partner genuinely has no active integration', async () => {
    // Pending action under org-2
    mockDb.select
      // 1. pending actions
      .mockReturnValueOnce(
        selectReturning([{
          id: 'action-2',
          orgId: 'org-2',
          deviceId: 'device-2',
          action: 'quarantine',
          payload: {},
          providerActionId: 'provider-act-2',
          status: 'queued',
        }])
      )
      // 2. organizations lookup: org-2 → partner-B
      .mockReturnValueOnce(
        selectReturning([{ id: 'org-2', partnerId: 'partner-B' }])
      )
      // 3. s1_integrations: no active integration for partner-B
      .mockReturnValueOnce(selectReturning([]))
      .mockReturnValue(selectReturning([]));

    const result = await processPollActions();

    expect(result.polled).toBe(1);
    expect(result.updated).toBe(1);

    // The action must be marked failed with the "no integration" message
    const failedUpdate = updatedPayloads.find(
      (p) => p.status === 'failed' && String(p.error ?? '').includes('no active SentinelOne integration')
    );
    expect(failedUpdate).toBeDefined();
  });
});
