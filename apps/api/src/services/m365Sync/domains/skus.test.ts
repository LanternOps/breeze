import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMocks } = vi.hoisted(() => ({
  dbMocks: { inserted: [] as unknown[], setPayloads: [] as Record<string, unknown>[], updates: [] as unknown[] },
}));

vi.mock('../../../db', () => ({
  db: {
    insert: () => ({
      values: (rows: unknown[]) => {
        dbMocks.inserted.push(...rows);
        return { onConflictDoUpdate: (cfg: { set: Record<string, unknown> }) => {
          dbMocks.setPayloads.push(cfg.set);
          return Promise.resolve();
        } };
      },
    }),
    update: () => ({ set: () => ({ where: () => { dbMocks.updates.push(true); return Promise.resolve(); } }) }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { persistSkus } from './skus';

const ctx = (existing: Array<[string, { coreHash: string; isStale: boolean }]> = []) => ({
  orgId: 'org-1', tenantId: 'tenant-1', connectionId: 'conn-1', generation: 2,
  existing: new Map(existing), now: new Date('2026-09-08T00:00:00.000Z'),
});
const sku = (over = {}) => ({
  skuId: '33333333-3333-4333-8333-333333333333', skuPartNumber: 'ENTERPRISEPACK',
  consumedUnits: 12, prepaidUnits: { enabled: 25, suspended: 0, warning: 1 },
  capabilityStatus: 'Enabled', appliesTo: 'User', ...over,
});
const okResult = (items: unknown[], over = {}) => ({
  success: true as const, kind: 'sync' as const, items: items as Record<string, unknown>[],
  truncated: false, fetchedAt: '2026-09-08T00:00:00.000Z',
  sources: { subscribedSkus: 'ok' as const }, ...over,
});

describe('persistSkus', () => {
  beforeEach(() => { vi.clearAllMocks(); dbMocks.inserted = []; dbMocks.setPayloads = []; dbMocks.updates = []; });

  it('keys the row on graph_id = the Graph skuId, and writes NO sku_id column', async () => {
    await persistSkus(ctx(), okResult([sku()]));
    expect(dbMocks.inserted[0]).toMatchObject({
      graphId: '33333333-3333-4333-8333-333333333333',
      skuPartNumber: 'ENTERPRISEPACK',
    });
    // m365_license_skus has no sku_id column — writing one is a 42703 that a
    // mocked db would happily accept, so pin its absence here.
    expect(dbMocks.inserted[0]).not.toHaveProperty('skuId');
    expect(dbMocks.setPayloads[0]).not.toHaveProperty('skuId');
  });

  it('flattens prepaidUnits into three integer columns', async () => {
    await persistSkus(ctx(), okResult([sku()]));
    expect(dbMocks.inserted[0]).toMatchObject({
      consumedUnits: 12, prepaidEnabled: 25, prepaidSuspended: 0, prepaidWarning: 1,
    });
  });

  it('defaults a missing prepaidUnits to zeros rather than writing NULL seat counts', async () => {
    await persistSkus(ctx(), okResult([sku({ prepaidUnits: undefined })]));
    expect(dbMocks.inserted[0]).toMatchObject({ prepaidEnabled: 0, prepaidSuspended: 0, prepaidWarning: 0 });
  });

  it('sums seats_purchased and seats_consumed across every sku', async () => {
    const out = await persistSkus(ctx(), okResult([
      sku(),
      sku({ skuId: '44444444-4444-4444-8444-444444444444', consumedUnits: 3, prepaidUnits: { enabled: 10, suspended: 2, warning: 0 } }),
    ]));
    expect(out.counts).toEqual({ seats_purchased: 35, seats_consumed: 15 });   // rollup column names only
  });

  it('does not let a non-numeric unit count poison the sums', async () => {
    const out = await persistSkus(ctx(), okResult([sku({ consumedUnits: null, prepaidUnits: { enabled: 'x' } })]));
    expect(out.counts.seats_consumed).toBe(0);
    expect(out.counts.seats_purchased).toBe(0);
  });

  it('writes nothing on an identical second run', async () => {
    await persistSkus(ctx(), okResult([sku()]));
    const coreHash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    const out = await persistSkus(
      ctx([['33333333-3333-4333-8333-333333333333', { coreHash, isStale: false }]]),
      okResult([sku()]),
    );
    expect(dbMocks.inserted).toEqual([]);
    expect(out.unchanged).toBe(1);
  });

  it('a seat-count change IS a change', async () => {
    await persistSkus(ctx(), okResult([sku()]));
    const coreHash = (dbMocks.inserted[0] as { coreHash: string }).coreHash;
    dbMocks.inserted = [];
    const out = await persistSkus(
      ctx([['33333333-3333-4333-8333-333333333333', { coreHash, isStale: false }]]),
      okResult([sku({ consumedUnits: 13 })]),
    );
    expect(out.updated).toBe(1);
  });

  it('marks a removed subscription stale on a complete run', async () => {
    const out = await persistSkus(ctx([['gone', { coreHash: 'h', isStale: false }]]), okResult([sku()]));
    expect(out.stale).toBe(1);
  });
});
