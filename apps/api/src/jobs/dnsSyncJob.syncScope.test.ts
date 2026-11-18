import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// #10054 — DNS sync stores blocked + redirected events by default. Allowed
// queries (~99% of a provider's log, ~1M rows/day on one tenant) are dropped
// before insert unless the integration opted in with
// `config.storeAllowedTraffic: true`. Every provider reports an action per
// event (Cloudflare per sampled group), so the filter is provider-agnostic.
// ---------------------------------------------------------------------------

let selectResults: unknown[][] = [];
const insertedValues: unknown[] = [];

function chain(result: unknown, onValues?: (v: unknown) => void) {
  const c: Record<string, unknown> = {};
  for (const m of [
    'from', 'where', 'limit', 'returning', 'set',
    'onConflictDoNothing', 'onConflictDoUpdate', 'innerJoin', 'leftJoin',
  ]) {
    c[m] = vi.fn(() => c);
  }
  c.values = vi.fn((v: unknown) => {
    onValues?.(v);
    return c;
  });
  (c as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

let insertCall = 0;
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => chain(selectResults.shift() ?? [])),
    // First insert per persist = dns_security_events (record its rows);
    // later inserts are aggregation upserts.
    insert: vi.fn(() => {
      insertCall += 1;
      return chain([], insertCall === 1 ? (v) => insertedValues.push(...(v as unknown[])) : undefined);
    }),
    update: vi.fn(() => chain(undefined)),
    delete: vi.fn(() => chain(undefined)),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
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

const { processSyncIntegration } = await import('./dnsSyncJob');

const TS = new Date('2026-10-28T12:00:00.000Z');
const EVENTS = (['allowed', 'blocked', 'redirected'] as const).map((action) => ({
  timestamp: TS,
  domain: `${action}.example.com`,
  action,
  category: 'malware',
  sourceIp: '10.0.0.5',
  providerEventId: `evt-${action}`,
}));

async function syncWithConfig(config: Record<string, unknown>) {
  selectResults = [
    [{ id: 'int-1', orgId: 'org-1', provider: 'pihole', apiKey: 'k', apiSecret: null, isActive: true, config, lastSync: null }],
    [], // mapDevicesByIp
  ];
  createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(async () => EVENTS) });
  return processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });
}

function storedActions(): string[] {
  return (insertedValues as Array<{ action: string }>).map((row) => row.action).sort();
}

describe('dnsSyncJob — sync scope (#10054)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
    insertedValues.length = 0;
    insertCall = 0;
  });

  it('stores blocked and redirected events and drops allowed ones by default', async () => {
    const result = await syncWithConfig({});
    expect(storedActions()).toEqual(['blocked', 'redirected']);
    // `fetched` still reports what the provider returned.
    expect(result.fetched).toBe(3);
  });

  it('drops allowed events when the opt-in is explicitly off', async () => {
    await syncWithConfig({ storeAllowedTraffic: false });
    expect(storedActions()).toEqual(['blocked', 'redirected']);
  });

  it('stores allowed events too when the integration opted in', async () => {
    await syncWithConfig({ storeAllowedTraffic: true });
    expect(storedActions()).toEqual(['allowed', 'blocked', 'redirected']);
  });
});
