/**
 * #8404 — processPolicySync must push domains the provider has never seen
 * (never-synced / failed-last-sync policy), not just the queued delta, but a
 * healthy policy edit stays delta-only (no re-adds). Unsynced = addedAt after
 * last_synced (sync_status is reset to pending by every edit, so unusable).
 * Provider calls are mocked.
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

const T0 = new Date('2026-10-01T00:00:00.000Z');
const BEFORE = '2026-09-30T00:00:00.000Z'; // already synced at T0
const AFTER = '2026-10-02T00:00:00.000Z'; // added after last sync

function setup(
  type: 'blocklist' | 'allowlist',
  domains: Array<string | { domain: string; addedAt: string }>,
  lastSynced: Date | null = null
) {
  mockDb.select.mockReturnValue(
    selectReturning([
      {
        policy: { id: 'pol-1', type, domains: domains.map((d) => (typeof d === 'string' ? { domain: d } : d)), lastSynced },
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

describe('processPolicySync reconcile (#8404)', () => {
  it('never-synced policy: pushes previously-pending domains even when the job carries only a delta', async () => {
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
  it('normalizes the removal filter (case/whitespace) so an in-policy domain is never removed', async () => {
    const provider = setup('blocklist', ['keep.example']);

    await processPolicySync({
      type: 'sync-policy',
      policyId: 'pol-1',
      operations: { add: [], remove: ['KEEP.Example '] },
    });

    expect(provider.removeBlocklistDomain).not.toHaveBeenCalled();
  });

  it('leaves the policy in error (not synced) when a previously-pending domain fails to push', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = setup('blocklist', ['old-pending.example', 'new.example']);
    provider.addBlocklistDomain.mockRejectedValueOnce(new Error('provider down'));

    await expect(
      processPolicySync({ type: 'sync-policy', policyId: 'pol-1', operations: { add: ['new.example'], remove: [] } }),
    ).rejects.toThrow();

    expect(setCalls.some((p) => p.syncStatus === 'error')).toBe(true);
    expect(setCalls.some((p) => p.syncStatus === 'synced')).toBe(false);
  });

  it('healthy policy edit (all other domains synced) pushes the delta only — no re-adds', async () => {
    const provider = setup(
      'blocklist',
      [
        { domain: 'old-1.example', addedAt: BEFORE },
        { domain: 'old-2.example', addedAt: BEFORE },
        { domain: 'new.example', addedAt: AFTER },
      ],
      T0
    );

    const res = await processPolicySync({
      type: 'sync-policy',
      policyId: 'pol-1',
      operations: { add: ['new.example'], remove: [] },
    });

    expect(provider.addBlocklistDomain.mock.calls.map((c) => c[0])).toEqual(['new.example']);
    expect(res.added).toBe(1);
  });

  it('domains added after last_synced (failed/pending backlog) are reconciled with the delta', async () => {
    const provider = setup(
      'blocklist',
      [
        { domain: 'synced.example', addedAt: BEFORE },
        { domain: 'backlog.example', addedAt: AFTER },
        { domain: 'new.example', addedAt: AFTER },
      ],
      T0
    );

    await processPolicySync({
      type: 'sync-policy',
      policyId: 'pol-1',
      operations: { add: ['new.example'], remove: [] },
    });

    expect(provider.addBlocklistDomain.mock.calls.map((c) => c[0]).sort()).toEqual(['backlog.example', 'new.example']);
  });

  it('stamps last_synced with the run start so a domain added mid-run stays unsynced', async () => {
    setup('blocklist', [{ domain: 'a.example', addedAt: BEFORE }], T0);
    const before = Date.now();
    await processPolicySync({ type: 'sync-policy', policyId: 'pol-1', operations: { add: ['a.example'], remove: [] } });
    const synced = setCalls.find((p) => p.syncStatus === 'synced');
    expect((synced?.lastSynced as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect((synced?.lastSynced as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });
});
