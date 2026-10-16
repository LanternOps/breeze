import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { dbMock, ctx } = vi.hoisted(() => ({
  dbMock: { execute: vi.fn() },
  ctx: { withSystemDbAccessContext: vi.fn(), withDbAccessContext: vi.fn(), runOutsideDbContext: vi.fn() },
}));
vi.mock('../../db', () => ({ db: dbMock, ...ctx }));

import { readConnectionOfferingRate } from './connectionOfferingRate';

const dialect = new PgDialect();
const BASE = { partnerId: 'p1', connectionId: 'c1', connectionKind: 'anthropic_byok' as const, model: 'claude-sonnet-4-6' };
const row = (over: Record<string, unknown> = {}) => ({
  offering_id: 'off-1',
  price_input_cents_per_m: null, price_output_cents_per_m: null, price_cache_read_cents_per_m: null, price_cache_write_cents_per_m: null,
  linked_input_cents_per_m: null, linked_output_cents_per_m: null, linked_cache_read_cents_per_m: null, linked_cache_write_cents_per_m: null,
  ...over,
});
const OWN = { price_input_cents_per_m: '300.0000', price_output_cents_per_m: '1500.0000', price_cache_read_cents_per_m: '30.0000', price_cache_write_cents_per_m: '375.0000' };
const LINKED = { linked_input_cents_per_m: '250.0000', linked_output_cents_per_m: '1250.0000', linked_cache_read_cents_per_m: '25.0000', linked_cache_write_cents_per_m: '312.5000' };

beforeEach(() => { vi.clearAllMocks(); });

describe('readConnectionOfferingRate (#7773)', () => {
  it('reads the enabled offering of THAT model on THAT connection of THAT partner, through the ambient db only', async () => {
    dbMock.execute.mockResolvedValueOnce([row(OWN)]);
    await readConnectionOfferingRate(BASE);
    expect(dbMock.execute).toHaveBeenCalledTimes(1);
    const q = dialect.sqlToQuery(dbMock.execute.mock.calls[0]![0] as SQL);
    expect(q.sql).toMatch(/FROM partner_ai_models[\s\S]*LEFT JOIN ai_platform_models/);
    expect(q.sql).toMatch(/partner_id = \$\d[\s\S]*connection_id = \$\d[\s\S]*model_id = \$\d[\s\S]*enabled/);
    expect(q.params).toEqual(expect.arrayContaining(['p1', 'c1', 'claude-sonnet-4-6']));
    // Never opens a context (and so never a second pooled connection) of its own.
    expect(ctx.withSystemDbAccessContext).not.toHaveBeenCalled();
    expect(ctx.withDbAccessContext).not.toHaveBeenCalled();
    expect(ctx.runOutsideDbContext).not.toHaveBeenCalled();
  });

  it('the offering\'s own price wins (source offering), like the candidate loader', async () => {
    dbMock.execute.mockResolvedValueOnce([row({ ...OWN, ...LINKED })]);
    await expect(readConnectionOfferingRate(BASE)).resolves.toEqual({
      rate: { source: 'offering', standard: { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 } },
      offeringId: 'off-1',
    });
  });

  it('an anthropic_byok offering with no own price takes its linked platform row\'s rate (source linked_platform)', async () => {
    dbMock.execute.mockResolvedValueOnce([row(LINKED)]);
    await expect(readConnectionOfferingRate(BASE)).resolves.toEqual({
      rate: { source: 'linked_platform', standard: { inputCentsPerM: 250, outputCentsPerM: 1250, cacheReadCentsPerM: 25, cacheWriteCentsPerM: 312.5 } },
      offeringId: 'off-1',
    });
  });

  it('a gateway offering never inherits a linked platform rate (own price only, as gatewayCandidate)', async () => {
    dbMock.execute.mockResolvedValueOnce([row(LINKED)]);
    await expect(readConnectionOfferingRate({ ...BASE, connectionKind: 'openai_compatible' as never }))
      .resolves.toEqual({ rate: null, reason: 'unpriced_offering' });
  });

  it('a partly priced offering is unpriced (all four rates or none)', async () => {
    dbMock.execute.mockResolvedValueOnce([row({ ...OWN, price_cache_write_cents_per_m: null })]);
    await expect(readConnectionOfferingRate(BASE)).resolves.toEqual({ rate: null, reason: 'unpriced_offering' });
  });

  it('no enabled offering for that model on the connection → a miss with its reason', async () => {
    dbMock.execute.mockResolvedValueOnce([]);
    await expect(readConnectionOfferingRate(BASE)).resolves.toEqual({ rate: null, reason: 'no_enabled_offering' });
  });

  it('a catalog connection is not read (its usage key is a provider id; its rate is the catalog revision\'s)', async () => {
    await expect(readConnectionOfferingRate({ ...BASE, connectionKind: 'catalog' }))
      .resolves.toEqual({ rate: null, reason: 'catalog_connection' });
    expect(dbMock.execute).not.toHaveBeenCalled();
  });

  it('no partner or connection on the binding → a miss, no query', async () => {
    await expect(readConnectionOfferingRate({ ...BASE, connectionId: null }))
      .resolves.toEqual({ rate: null, reason: 'no_connection' });
    await expect(readConnectionOfferingRate({ ...BASE, partnerId: null }))
      .resolves.toEqual({ rate: null, reason: 'no_connection' });
    expect(dbMock.execute).not.toHaveBeenCalled();
  });
});
