/**
 * DNS sync catch-block wiring — SSRF read-oracle invariant (#1035 item 2,
 * follow-up to #1025).
 *
 * The pure helpers (`tenantVisibleSyncError`, `logSyncFailureServerSide`) are
 * unit-tested in dnsSyncJob.test.ts, but nothing proved the *catch blocks* in
 * `processSyncIntegration` / `processPolicySync` actually call them correctly.
 * A regression that swapped the tenant-visible column write back to
 * `redactLogMessage(error.responseBody)` (the pre-#1025 behavior) would have
 * passed every existing test, re-opening the partial-read oracle for
 * tenant-controlled Pi-hole / AdGuard endpoints.
 *
 * These tests drive the (now exported) processors with a chainable DB mock and
 * a provider stubbed to throw a `DnsProviderHttpError` carrying a distinctive
 * upstream-body marker, then assert:
 *   (a) the value written to the tenant column (`lastSyncError` / `syncError`)
 *       contains the body-free status line and NEVER the upstream body marker;
 *   (b) the full (redacted) body IS captured in the server-side console.error.
 *
 * Pure unit test — runs in the standard `test-api` CI job (no live DB needed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Distinctive markers planted in the upstream response body. Neither may ever
// reach the tenant-visible DB column; the secret-shaped one must additionally
// be redacted even in the server-side log.
const UPSTREAM_BODY_MARKER = 'UPSTREAM_PIHOLE_BODY_MARKER_must_not_reach_tenant';
const UPSTREAM_BODY_SECRET = 'auth=SUPERSECRETPIHOLEKEY';

// Capture every payload passed to `db.update(...).set(<payload>)` so we can
// inspect what would be persisted to the tenant-visible columns.
const setCalls: Array<Record<string, unknown>> = [];

const mockDb = {
  // SELECT chain — `processSyncIntegration` does `.select().from().where().limit()`
  // and `processPolicySync` does `.select().from().innerJoin().where().limit()`.
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  update: vi.fn(),
};

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: undefined,
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
}));

// Keep the REAL DnsProviderHttpError (the processors use `instanceof`), but stub
// the factory so we can make the provider throw on demand.
const createDnsProviderMock = vi.fn();
vi.mock('../services/dnsProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dnsProviders')>();
  return {
    ...actual,
    createDnsProvider: createDnsProviderMock,
  };
});

// The decrypt step runs before the provider is built — make it a no-op pass-through.
vi.mock('../services/secretCrypto', () => ({
  decryptForColumn: (_table: string, _column: string, value: unknown) => value ?? 'decrypted',
}));

// Event-bus publish is best-effort and irrelevant to the error path.
vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
  EVENT_TYPES: { DNS_THREAT_BLOCKED: 'dns.threat.blocked' },
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

const { processSyncIntegration, processPolicySync } = await import('./dnsSyncJob');
const { DnsProviderHttpError } = await import('../services/dnsProviders');

/** A single-result SELECT chain returning `rows`. */
function selectReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const method of ['from', 'where', 'innerJoin']) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.limit = vi.fn().mockResolvedValue(rows);
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('processSyncIntegration catch block — tenant-visible lastSyncError is body-free (#1035)', () => {
  it('stores only the HTTP status line, never the upstream body, and logs the redacted body server-side', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // SELECT the integration row.
    mockDb.select.mockReturnValue(
      selectReturning([
        {
          id: 'int-1',
          orgId: 'org-1',
          provider: 'pihole',
          apiKey: 'enc-key',
          apiSecret: null,
          isActive: true,
          config: {},
          lastSync: null,
        },
      ]),
    );

    // The provider's syncEvents throws an upstream HTTP error whose body carries
    // a secret + a distinctive marker — the read-oracle payload.
    createDnsProviderMock.mockReturnValue({
      syncEvents: vi.fn().mockRejectedValue(
        new DnsProviderHttpError(
          502,
          'Bad Gateway',
          `${UPSTREAM_BODY_MARKER} ${UPSTREAM_BODY_SECRET}`,
        ),
      ),
    });

    await expect(
      processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' }),
    ).rejects.toBeInstanceOf(DnsProviderHttpError);

    // The catch block must have written the error status to the tenant column.
    const errorUpdate = setCalls.find((payload) => payload.lastSyncStatus === 'error');
    expect(errorUpdate).toBeDefined();
    const stored = String(errorUpdate!.lastSyncError);

    // (a) status line present, upstream body absent.
    expect(stored).toBe('HTTP 502 Bad Gateway');
    expect(stored).not.toContain(UPSTREAM_BODY_MARKER);
    expect(stored).not.toContain('SUPERSECRETPIHOLEKEY');

    // (b) the full (redacted) body lands in the server-side log only.
    const logged = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(logged).toContain(UPSTREAM_BODY_MARKER);
    expect(logged).toContain('[REDACTED]');
    // ...and the secret is NOT echoed verbatim even server-side.
    expect(logged).not.toContain('SUPERSECRETPIHOLEKEY');
  });

  it('redacts a transport-error secret (Pi-hole ?auth=<key>) in the stored column', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDb.select.mockReturnValue(
      selectReturning([
        { id: 'int-2', orgId: 'org-1', provider: 'pihole', apiKey: 'k', apiSecret: null, isActive: true, config: {}, lastSync: null },
      ]),
    );
    createDnsProviderMock.mockReturnValue({
      syncEvents: vi.fn().mockRejectedValue(
        new Error('connect ECONNREFUSED https://pihole.local/admin/api.php?auth=SUPERSECRETPIHOLEKEY'),
      ),
    });

    await expect(
      processSyncIntegration({ type: 'sync-integration', integrationId: 'int-2' }),
    ).rejects.toThrow();

    const stored = String(setCalls.find((p) => p.lastSyncStatus === 'error')!.lastSyncError);
    expect(stored).not.toContain('SUPERSECRETPIHOLEKEY');
    expect(stored).toContain('[REDACTED]');
  });
});

describe('processPolicySync catch block — tenant-visible syncError is body-free (#1035)', () => {
  it('stores only the HTTP status line in dns_policies.syncError, never the upstream body', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // SELECT the policy joined to its integration.
    mockDb.select.mockReturnValue(
      selectReturning([
        {
          policy: { id: 'pol-1', type: 'blocklist', domains: [{ domain: 'evil.example.com' }] },
          integration: { id: 'int-1', orgId: 'org-1', provider: 'adguard_home', apiKey: 'k', apiSecret: 's', config: {} },
        },
      ]),
    );

    // addBlocklistDomain throws an upstream HTTP error with the marker body.
    createDnsProviderMock.mockReturnValue({
      addBlocklistDomain: vi.fn().mockRejectedValue(
        new DnsProviderHttpError(403, 'Forbidden', `${UPSTREAM_BODY_MARKER} ${UPSTREAM_BODY_SECRET}`),
      ),
      removeBlocklistDomain: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      processPolicySync({ type: 'sync-policy', policyId: 'pol-1' }),
    ).rejects.toBeInstanceOf(DnsProviderHttpError);

    const errorUpdate = setCalls.find((payload) => payload.syncStatus === 'error');
    expect(errorUpdate).toBeDefined();
    const stored = String(errorUpdate!.syncError);

    expect(stored).toBe('HTTP 403 Forbidden');
    expect(stored).not.toContain(UPSTREAM_BODY_MARKER);
    expect(stored).not.toContain('SUPERSECRETPIHOLEKEY');

    const logged = errorSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(logged).toContain(UPSTREAM_BODY_MARKER);
    expect(logged).toContain('[REDACTED]');
  });
});
