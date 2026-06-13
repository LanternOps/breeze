/**
 * SentinelOne sync catch-block wiring — SSRF read-oracle invariant (#1035 item
 * 2, follow-up to #1025).
 *
 * The helpers (`truncateError`, `logSyncFailureServerSide`) are unit-tested in
 * s1Sync.test.ts, but nothing proved the *catch block* in `processSyncIntegration`
 * actually calls them correctly. A regression swapping the tenant-visible
 * `s1_integrations.lastSyncError` write back to `redactLogMessage(error.responseBody)`
 * would have passed every existing test, re-opening the partial-read oracle.
 *
 * This drives the (now exported) processor with a chainable DB mock and an S1
 * client stubbed to throw a `SentinelOneHttpError` carrying a distinctive
 * upstream-body marker, then asserts:
 *   (a) the value written to `lastSyncError` is the body-free status line and
 *       NEVER contains the upstream body marker;
 *   (b) the full (redacted) body IS captured in the server-side console.error.
 *
 * Pure unit test — runs in the standard `test-api` CI job (no live DB needed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SentinelOneHttpError } from '../services/sentinelOne/client';

const UPSTREAM_BODY_MARKER = 'UPSTREAM_S1_BODY_MARKER_must_not_reach_tenant';
const UPSTREAM_BODY_SECRET = 'Authorization: Bearer s1_leaked_token';

// Capture every `db.update(...).set(<payload>)` payload.
const setCalls: Array<Record<string, unknown>> = [];

const mockDb = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: undefined,
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
}));

vi.mock('../services/secretCrypto', () => ({
  decryptForColumn: () => 'decrypted-token',
}));

// Stub the S1 client so listAgents throws an upstream HTTP error, but keep the
// REAL SentinelOneHttpError (processSyncIntegration / logSyncFailureServerSide
// use `instanceof`) and S1_THREAT_ACTIONS. A real mock class is used so `new
// SentinelOneClient(...)` constructs correctly (a vi.fn() impl returning an
// object does not behave as a constructor here).
const listAgentsMock = vi.fn();
vi.mock('../services/sentinelOne/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sentinelOne/client')>();
  class MockSentinelOneClient {
    listAgents = listAgentsMock;
    listThreats = vi.fn().mockResolvedValue({ results: [], truncated: false });
    getActivityStatus = vi.fn();
  }
  return {
    ...actual,
    SentinelOneClient: MockSentinelOneClient,
  };
});

vi.mock('../services/sentinelOne/metrics', () => ({
  recordS1ActionDispatch: vi.fn(),
  recordS1ActionPollTransition: vi.fn(),
  recordS1SyncRun: vi.fn(),
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }));

const { processSyncIntegration } = await import('./s1Sync');

/** A single-result SELECT chain returning `rows`. */
function selectReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'innerJoin', 'leftJoin']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.limit = vi.fn().mockResolvedValue(rows);
  // Some selects in the sync path are awaited directly (no .limit()); make the
  // chain itself thenable so `await db.select()...where()` resolves to [].
  chain.then = (resolve: (value: unknown[]) => unknown) => resolve(rows);
  return chain;
}

function makeUpdateMock() {
  return vi.fn().mockImplementation(() => ({
    set: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
      setCalls.push(payload);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  setCalls.length = 0;
  mockDb.update.mockImplementation(makeUpdateMock());
  // syncAgentsForIntegration runs mapSiteOrgIds / mapDeviceCandidatesByOrg first
  // (both empty), then listAgents throws. Default every SELECT to empty rows;
  // the integration lookup is overridden per-test.
  mockDb.select.mockReturnValue(selectReturning([]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('s1 processSyncIntegration catch block — lastSyncError is body-free (#1035)', () => {
  function primeIntegrationLookup() {
    // First .select() is the integration row; the rest (site mappings, device
    // candidates) come back empty via the default mock.
    mockDb.select
      .mockReturnValueOnce(
        selectReturning([
          {
            id: 'int-1',
            orgId: 'org-1',
            managementUrl: 'https://example.sentinelone.net',
            apiTokenEncrypted: 'enc',
            isActive: true,
            lastSyncAt: null,
          },
        ]),
      )
      .mockReturnValue(selectReturning([]));
  }

  it('stores only the status line, never the upstream body, and logs the redacted body server-side', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    primeIntegrationLookup();

    listAgentsMock.mockRejectedValue(
      new SentinelOneHttpError(
        'GET',
        '/web/api/v2.1/agents',
        500,
        `${UPSTREAM_BODY_MARKER} ${UPSTREAM_BODY_SECRET}`,
      ),
    );

    await expect(
      processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1', syncAgents: true, syncThreats: false }),
    ).rejects.toBeInstanceOf(SentinelOneHttpError);

    const errorUpdate = setCalls.find((payload) => payload.lastSyncStatus === 'error');
    expect(errorUpdate).toBeDefined();
    const stored = String(errorUpdate!.lastSyncError);

    // (a) body-free status line; upstream body + header secret absent.
    expect(stored).toBe('SentinelOne API GET /web/api/v2.1/agents failed (500)');
    expect(stored).not.toContain(UPSTREAM_BODY_MARKER);
    expect(stored).not.toContain('s1_leaked_token');

    // (b) the (redacted) body is captured server-side only.
    const logged = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(logged).toContain(UPSTREAM_BODY_MARKER);
    expect(logged).toContain('[REDACTED]');
    expect(logged).not.toContain('s1_leaked_token');
  });

  it('redacts a header-shaped secret from a non-HTTP transport error in the stored column', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    primeIntegrationLookup();
    listAgentsMock.mockRejectedValue(new Error('socket hangup Authorization: Bearer s1_leaked_token'));

    await expect(
      processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1', syncAgents: true, syncThreats: false }),
    ).rejects.toThrow();

    const stored = String(setCalls.find((p) => p.lastSyncStatus === 'error')!.lastSyncError);
    expect(stored).not.toContain('s1_leaked_token');
    expect(stored).toContain('[REDACTED]');
  });
});
