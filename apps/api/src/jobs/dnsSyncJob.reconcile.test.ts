/**
 * #8404 — processPolicySync must reconcile the FULL policy domain list, not
 * just the delta queued by the edit. Domains left `pending` before #8337
 * (when sync-policy jobs never enqueued) would otherwise never reach the
 * provider while the policy flips to `synced`. Provider calls are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setCalls: Array<Record<string, unknown>> = [];
const mockDb = { select: vi.fn(), insert: vi.fn(), delete: vi.fn(), update: vi.fn() };

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: <T>(fn: () => T): T => fn(),
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
}));

const createDnsProviderMock = vi.fn();
vi.mock('../services/dnsProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dnsProviders')>();
  return { ...actual, createDnsProvider: createDnsProviderMock };
});
vi.mock('../services/secretCrypto', () => ({
  decryptForColumn: (_t: string, _c: string, v: unknown) => v ?? 'decrypted',
}));
vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
  EVENT_TYPES: { DNS_THREAT_BLOCKED: 'dns.threat.blocked' },
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

const { processPolicySync } = await import('./dnsSyncJob');

function selectReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'innerJoin']) chain[m] = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockResolvedValue(rows);
  return chain;
}

function setup(type: 'blocklist' | 'allowlist', domains: string[]) {
  mockDb.select.mockReturnValue(
    selectReturning([
      {
        policy: { id: 'pol-1', type, domains: domains.map((domain) => ({ domain })) },
        integration: { id: 'int-1', orgId: 'org-1', provider: 'pihole', apiKey: 'k', apiSecret: 's', config: {} },
      },
    ]),
  );
  const provider = {
    addBlocklistDomain: vi.fn().mockResolvedValue(undefined),
    removeBlocklistDomain: vi.fn().mockResolvedValue(undefined),
    addAllowlistDomain: vi.fn().mockResolvedValue(undefined),
    removeAllowlistDomain: vi.fn().mockResolvedValue(undefined),
  };
  createDnsProviderMock.mockReturnValue(provider);
  return provider;
}

beforeEach(() => {
  vi.clearAllMocks();
  setCalls.length = 0;
  mockDb.update.mockImplementation(() => ({
    set: vi.fn().mockImplementation((p: Record<string, unknown>) => {
      setCalls.push(p);
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  }));
});

describe('processPolicySync full reconcile (#8404)', () => {
  it('pushes previously-pending domains even when the job carries only a delta', async () => {
    const provider = setup('blocklist', ['old-pending.example', 'also-pending.example', 'new.example']);

    const res = await processPolicySync({
      type: 'sync-policy',
      policyId: 'pol-1',
      operations: { add: ['new.example'], remove: [] },
    });

    const added = provider.addBlocklistDomain.mock.calls.map((c) => c[0]).sort();
    expect(added).toEqual(['also-pending.example', 'new.example', 'old-pending.example']);
    expect(res.added).toBe(3);
    expect(setCalls.some((p) => p.syncStatus === 'synced')).toBe(true);
  });

  it('still honours removals from the delta and never removes a domain still in the policy', async () => {
    const provider = setup('allowlist', ['keep.example']);

    const res = await processPolicySync({
      type: 'sync-policy',
      policyId: 'pol-1',
      operations: { add: [], remove: ['gone.example', 'keep.example'] },
    });

    expect(provider.addAllowlistDomain.mock.calls.map((c) => c[0])).toEqual(['keep.example']);
    expect(provider.removeAllowlistDomain.mock.calls.map((c) => c[0])).toEqual(['gone.example']);
    expect(res.removed).toBe(1);
  });

  it('does not push a delta domain that is no longer in the policy', async () => {
    const provider = setup('blocklist', ['a.example']);

    await processPolicySync({
      type: 'sync-policy',
      policyId: 'pol-1',
      operations: { add: ['raced-out.example'], remove: [] },
    });

    expect(provider.addBlocklistDomain.mock.calls.map((c) => c[0])).toEqual(['a.example']);
  });
});
