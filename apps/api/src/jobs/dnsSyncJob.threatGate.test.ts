import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// #6692 — the DNS sync job must publish `dns.threat.blocked` only for blocked
// queries in a THREAT category. Content-policy blocks (social_media,
// streaming, gambling, adult_content) and `unknown` are not threats; before
// the fix every categorized block became a severity=high "DNS threat" alert.
// ---------------------------------------------------------------------------

let selectResults: unknown[][] = [];
let insertResults: unknown[][] = [];

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of [
    'from', 'where', 'limit', 'values', 'returning', 'set',
    'onConflictDoNothing', 'onConflictDoUpdate', 'innerJoin', 'leftJoin',
  ]) {
    c[m] = vi.fn(() => c);
  }
  (c as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => chain(selectResults.shift() ?? [])),
    insert: vi.fn(() => chain(insertResults.shift() ?? [])),
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

const publishEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/eventBus', () => ({
  publishEvent: (...args: unknown[]) => publishEventMock(...args),
  EVENT_TYPES: { DNS_THREAT_BLOCKED: 'dns.threat.blocked' },
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

const { processSyncIntegration } = await import('./dnsSyncJob');

const TS = new Date('2026-09-22T12:00:00.000Z');

async function syncOneBlockedEvent(category: string, action: 'blocked' | 'allowed' = 'blocked') {
  selectResults = [
    [{ id: 'int-1', orgId: 'org-1', provider: 'pihole', apiKey: 'k', apiSecret: null, isActive: true, config: {}, lastSync: null }],
    [], // mapDevicesByIp
  ];
  // First insert = dns_security_events ... RETURNING; the aggregation upsert
  // afterwards falls back to [].
  insertResults = [[{
    orgId: 'org-1',
    integrationId: 'int-1',
    deviceId: 'dev-1',
    timestamp: TS,
    domain: 'example.com',
    category,
    action,
  }]];
  createDnsProviderMock.mockReturnValue({
    syncEvents: vi.fn(async () => [{
      timestamp: TS,
      domain: 'example.com',
      action,
      category,
      sourceIp: '10.0.0.5',
      providerEventId: `evt-${category}`,
    }]),
  });
  await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });
}

describe('dnsSyncJob — dns.threat.blocked category gate (#6692)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
    insertResults = [];
  });

  it.each(['phishing', 'malware', 'botnet', 'ransomware', 'cryptomining', 'spam', 'adware'])(
    'publishes dns.threat.blocked for a blocked %s query',
    async (category) => {
      await syncOneBlockedEvent(category);
      expect(publishEventMock).toHaveBeenCalledTimes(1);
      expect(publishEventMock).toHaveBeenCalledWith(
        'dns.threat.blocked',
        'org-1',
        expect.objectContaining({ category, deviceId: 'dev-1', domain: 'example.com' }),
        'dns-sync-job',
        { priority: 'high' },
      );
    },
  );

  it.each(['social_media', 'streaming', 'gambling', 'adult_content'])(
    'does NOT publish for a blocked content-policy category (%s)',
    async (category) => {
      await syncOneBlockedEvent(category);
      expect(publishEventMock).not.toHaveBeenCalled();
    },
  );

  it('does NOT publish for a blocked query in the unknown category', async () => {
    await syncOneBlockedEvent('unknown');
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('does NOT publish for an allowed threat-category query', async () => {
    await syncOneBlockedEvent('phishing', 'allowed');
    expect(publishEventMock).not.toHaveBeenCalled();
  });
});
