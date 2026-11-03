import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// #10020 — retention is the daily batched sweep's job (dnsSecurityRetention.ts).
// A successful sync slice must not issue its own unbatched DELETE of old
// events any more, even when the integration sets retentionDays. Mock harness
// trimmed from dnsSyncJob.slices.test.ts.
// ---------------------------------------------------------------------------

let selectResults: unknown[][] = [];
const updatePayloads: Array<Record<string, unknown>> = [];
const insertedBatches: Array<Array<Record<string, unknown>>> = [];

function chain(result: unknown, onValues?: (rows: Array<Record<string, unknown>>) => void) {
  const c: Record<string, unknown> = {};
  for (const m of [
    'from', 'where', 'limit', 'returning',
    'onConflictDoNothing', 'onConflictDoUpdate', 'innerJoin', 'leftJoin',
  ]) {
    c[m] = vi.fn(() => c);
  }
  c.values = vi.fn((rows: Array<Record<string, unknown>>) => {
    onValues?.(rows);
    return c;
  });
  c.set = vi.fn((payload: Record<string, unknown>) => {
    updatePayloads.push(payload);
    return c;
  });
  (c as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => chain(selectResults.shift() ?? [])),
    insert: vi.fn(() => chain([], (rows) => insertedBatches.push(rows))),
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
const { db } = await import('../db');

describe('dnsSyncJob — no inline retention prune (#10020)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
    updatePayloads.length = 0;
    insertedBatches.length = 0;
  });

  it('persists a slice for an integration with retentionDays without deleting anything', async () => {
    // Phase 1 integration read, then the mapDevicesByIp read.
    selectResults = [[{
      id: 'int-1', orgId: 'org-1', provider: 'umbrella', apiKey: 'k', apiSecret: 's',
      isActive: true, config: { retentionDays: 1 }, lastSync: new Date('2026-08-01T00:00:00.000Z'),
    }], []];
    createDnsProviderMock.mockReturnValue({
      syncEvents: vi.fn(async () => [
        { timestamp: new Date('2026-08-01T01:00:00.000Z'), domain: 'one.example', queryType: 'A', action: 'blocked' },
      ]),
    });

    await processSyncIntegration({ integrationId: 'int-1' } as never);

    expect(insertedBatches.length).toBeGreaterThan(0);
    expect(updatePayloads.some((u) => u.lastSyncStatus === 'success')).toBe(true);
    expect(db.delete).not.toHaveBeenCalled();
  });
});
