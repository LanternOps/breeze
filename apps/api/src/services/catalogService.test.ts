import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock (invoiceService.test.ts pattern): every
// builder method returns the same chain; awaiting the chain yields the next
// queued result. These tests lock the price-map / resolver / lock-order logic
// of catalogService; the data path is proven by catalogService.integration.test.ts.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }
/** Queue a REJECTION for the next awaited chain — the transient-failure shape
 *  (40001 serialization failure, 40P01 deadlock, dropped connection) that a
 *  locking read can now raise. */
function queueRejection(err: unknown) { results.push(err as never); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = [
      'select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set',
      'delete', 'for', 'innerJoin', 'leftJoin', 'onConflictDoNothing', 'onConflictDoUpdate', '$dynamic', 'execute'
    ];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      if (rows instanceof Error) return Promise.reject(rows).then(resolve, reject);
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  (db as { transaction?: unknown }).transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { db };
});

vi.mock('./catalogEvents', () => ({ emitCatalogEvent: vi.fn().mockResolvedValue(undefined) }));

import type { Mock } from 'vitest';
import * as svc from './catalogService';
import { db } from '../db';
import { catalogItems, catalogItemOrgPricing, catalogItemPrices } from '../db/schema';
import { emitCatalogEvent } from './catalogEvents';

type ChainMocks = Record<'select' | 'from' | 'insert' | 'values' | 'update' | 'set' | 'delete' | 'for' | 'onConflictDoUpdate' | 'transaction', Mock>;
const mock = db as unknown as ChainMocks;
const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };

const baseCreate = {
  itemType: 'service' as const,
  name: 'Widget',
  billingType: 'one_time' as const,
  unitOfMeasure: 'each',
  taxable: true,
  isBundle: false,
  attributes: {},
};

/** Queue the partner-currency read + the item insert for a createCatalogItem call. */
function queueCreate(partnerCurrency: string) {
  queueResult([{ currencyCode: partnerCurrency }]); // partners.currencyCode
  queueResult([{ id: 'i1', partnerId: 'p1', name: 'Widget' }]); // catalog_items insert ... returning
}

function priceRowsWritten(): Array<{ currencyCode: string; unitPrice: string }> {
  // values() call 0 = the catalog_items row, call 1 = the price-book rows.
  const call = mock.values.mock.calls[1];
  return (call?.[0] ?? []) as Array<{ currencyCode: string; unitPrice: string }>;
}

describe('createCatalogItem price map (buildPriceMap)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('explicit prices only → one row per currency, mirror = partner-currency row', async () => {
    queueCreate('USD');
    await svc.createCatalogItem({ ...baseCreate, prices: [{ currencyCode: 'EUR', unitPrice: 10 }, { currencyCode: 'USD', unitPrice: 12 }] }, actor);
    expect(priceRowsWritten()).toEqual([
      expect.objectContaining({ itemId: 'i1', partnerId: 'p1', currencyCode: 'EUR', unitPrice: '10.00' }),
      expect.objectContaining({ itemId: 'i1', partnerId: 'p1', currencyCode: 'USD', unitPrice: '12.00' }),
    ]);
    expect(mock.values.mock.calls[0]?.[0]).toMatchObject({ unitPrice: '12.00', costCurrency: 'USD' });
  });

  it('legacy unitPrice lands in the partner currency', async () => {
    queueCreate('GBP');
    await svc.createCatalogItem({ ...baseCreate, unitPrice: 99.5 }, actor);
    expect(priceRowsWritten()).toEqual([expect.objectContaining({ currencyCode: 'GBP', unitPrice: '99.50' })]);
    expect(mock.values.mock.calls[0]?.[0]).toMatchObject({ unitPrice: '99.50', costCurrency: 'GBP' });
  });

  it('no price in the partner currency → mirror falls back to 0.00', async () => {
    queueCreate('USD');
    await svc.createCatalogItem({ ...baseCreate, prices: [{ currencyCode: 'EUR', unitPrice: 10 }] }, actor);
    expect(mock.values.mock.calls[0]?.[0]).toMatchObject({ unitPrice: '0.00' });
  });

  it('cost+markup derives into costCurrency only when no explicit price exists there', async () => {
    queueCreate('USD');
    await svc.createCatalogItem({ ...baseCreate, costBasis: 400, markupPercent: 25 }, actor);
    expect(priceRowsWritten()).toEqual([expect.objectContaining({ currencyCode: 'USD', unitPrice: '500.00' })]);

    vi.clearAllMocks(); results.length = 0;
    queueCreate('USD');
    await svc.createCatalogItem({ ...baseCreate, costBasis: 400, markupPercent: 25, prices: [{ currencyCode: 'USD', unitPrice: 700 }] }, actor);
    expect(priceRowsWritten()).toEqual([expect.objectContaining({ currencyCode: 'USD', unitPrice: '700.00' })]);
  });

  it('costCurrency CAD under a USD partner with unitPrice → USD explicit + CAD derived (never converts)', async () => {
    queueCreate('USD');
    await svc.createCatalogItem({ ...baseCreate, unitPrice: 120, costBasis: 100, markupPercent: 10, costCurrency: 'CAD' }, actor);
    const rows = priceRowsWritten();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ currencyCode: 'USD', unitPrice: '120.00' }),
      expect.objectContaining({ currencyCode: 'CAD', unitPrice: '110.00' }),
    ]));
    expect(mock.values.mock.calls[0]?.[0]).toMatchObject({ unitPrice: '120.00', costCurrency: 'CAD' });
  });

  it('nothing at all → PRICE_REQUIRED (400) before any insert', async () => {
    queueResult([{ currencyCode: 'USD' }]);
    await expect(svc.createCatalogItem({ ...baseCreate }, actor))
      .rejects.toMatchObject({ status: 400, code: 'PRICE_REQUIRED' });
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it('JPY 100.5 → PRICE_NOT_REPRESENTABLE (400)', async () => {
    queueResult([{ currencyCode: 'USD' }]);
    await expect(svc.createCatalogItem({ ...baseCreate, prices: [{ currencyCode: 'JPY', unitPrice: 100.5 }] }, actor))
      .rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it('JPY cost 1000 + 33.3% markup derives a whole-yen price', async () => {
    queueCreate('USD');
    await svc.createCatalogItem({ ...baseCreate, costBasis: 1000, markupPercent: 33.3, costCurrency: 'JPY' }, actor);
    expect(priceRowsWritten()).toEqual([expect.objectContaining({ currencyCode: 'JPY', unitPrice: '1333.00' })]);
  });

  it('a cost that is not representable in costCurrency → PRICE_NOT_REPRESENTABLE', async () => {
    queueResult([{ currencyCode: 'USD' }]);
    await expect(svc.createCatalogItem({ ...baseCreate, unitPrice: 10, costBasis: 10.5, costCurrency: 'JPY' }, actor))
      .rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
  });

  it('duplicate SKU → 409 DUPLICATE_SKU, no price rows written', async () => {
    queueResult([{ currencyCode: 'USD' }]);
    queueResult([]); // onConflictDoNothing returned nothing
    await expect(svc.createCatalogItem({ ...baseCreate, sku: 'X', unitPrice: 1 }, actor))
      .rejects.toMatchObject({ status: 409, code: 'DUPLICATE_SKU' });
    expect(mock.values).toHaveBeenCalledTimes(1);
    expect(emitCatalogEvent).not.toHaveBeenCalled();
  });
});

describe('resolvePrice', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const item = { id: 'i1', partnerId: 'p1', name: 'Widget', costBasis: '5.00', costCurrency: 'USD', taxable: true, taxCategory: null, unitPrice: '999.00' };

  it('queries item → override → price book and returns the book row', async () => {
    queueResult([item]);
    queueResult([]); // no override
    queueResult([{ unitPrice: '10.00' }]);
    const resolved = await svc.resolvePrice('i1', 'EUR', 'org1', actor);
    expect(resolved).toMatchObject({ unitPrice: '10.00', currencyCode: 'EUR', source: 'price_book', marginAvailable: false });
    const tables = mock.from.mock.calls.map((c) => c[0]);
    expect(tables).toEqual([catalogItems, catalogItemOrgPricing, catalogItemPrices]);
    expect(mock.for).not.toHaveBeenCalled(); // plain SELECTs on the document path
  });

  it('skips the override query when orgId is null', async () => {
    queueResult([item]);
    queueResult([{ unitPrice: '10.00' }]);
    const resolved = await svc.resolvePrice('i1', 'USD', null, actor);
    expect(resolved).toMatchObject({ unitPrice: '10.00', source: 'price_book', marginAvailable: true });
    expect(mock.from.mock.calls.map((c) => c[0])).toEqual([catalogItems, catalogItemPrices]);
  });

  it('NO_PRICE_FOR_CURRENCY (409) when the book select returns []', async () => {
    queueResult([item]);
    queueResult([]);
    queueResult([]);
    await expect(svc.resolvePrice('i1', 'GBP', 'org1', actor))
      .rejects.toMatchObject({ status: 409, code: 'NO_PRICE_FOR_CURRENCY' });
  });

  it('override in another currency is ignored (never converts)', async () => {
    queueResult([item]);
    queueResult([{ unitPrice: '9.00', currencyCode: 'EUR' }]);
    queueResult([{ unitPrice: '12.00' }]);
    const resolved = await svc.resolvePrice('i1', 'USD', 'org1', actor);
    expect(resolved).toMatchObject({ unitPrice: '12.00', source: 'price_book' });
  });

  it('ORG_DENIED before any query when the actor cannot access the org', async () => {
    await expect(svc.resolvePrice('i1', 'USD', 'org1', { ...actor, accessibleOrgIds: ['other'] }))
      .rejects.toMatchObject({ status: 403, code: 'ORG_DENIED' });
    expect(mock.select).not.toHaveBeenCalled();
  });
});

describe('setItemPrice / removeItemPrice lock order', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('setItemPrice locks catalog_items FOR UPDATE before the price upsert, mirrors the partner currency last', async () => {
    queueResult([{ id: 'i1', partnerId: 'p1', name: 'Widget' }]); // lock
    queueResult([{ currencyCode: 'USD' }]); // partner currency
    queueResult([{ id: 'pr1', itemId: 'i1', currencyCode: 'USD', unitPrice: '8.00' }]); // upsert returning
    queueResult([]); // mirror update
    const row = await svc.setItemPrice('i1', 'USD', { unitPrice: 8 }, actor);
    expect(row).toMatchObject({ unitPrice: '8.00' });
    expect(mock.transaction).toHaveBeenCalledTimes(1);
    const lockOrder = mock.for.mock.invocationCallOrder[0]!;
    const upsertOrder = mock.onConflictDoUpdate.mock.invocationCallOrder[0]!;
    const mirrorOrder = mock.update.mock.invocationCallOrder[0]!;
    expect(lockOrder).toBeLessThan(upsertOrder);
    expect(upsertOrder).toBeLessThan(mirrorOrder);
    expect(mock.set).toHaveBeenCalledWith(expect.objectContaining({ unitPrice: '8.00' }));
    expect(emitCatalogEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'catalog.item.price_changed', catalogItemId: 'i1' }));
  });

  it('setItemPrice in a non-partner currency does not touch the mirror', async () => {
    queueResult([{ id: 'i1', partnerId: 'p1', name: 'Widget' }]);
    queueResult([{ currencyCode: 'USD' }]);
    queueResult([{ id: 'pr1', itemId: 'i1', currencyCode: 'EUR', unitPrice: '8.00' }]);
    await svc.setItemPrice('i1', 'EUR', { unitPrice: 8 }, actor);
    expect(mock.update).not.toHaveBeenCalled();
  });

  it('setItemPrice refuses an unrepresentable amount (JPY 10.5) after the lock, before the upsert', async () => {
    queueResult([{ id: 'i1', partnerId: 'p1', name: 'Widget' }]);
    queueResult([{ currencyCode: 'USD' }]);
    await expect(svc.setItemPrice('i1', 'JPY', { unitPrice: 10.5 }, actor))
      .rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it('setItemPrice 404s an item the partner does not own', async () => {
    queueResult([]);
    await expect(svc.setItemPrice('nope', 'USD', { unitPrice: 8 }, actor))
      .rejects.toMatchObject({ status: 404, code: 'ITEM_NOT_FOUND' });
  });

  it('removeItemPrice locks first, deletes, and zeroes the mirror only for the partner currency', async () => {
    queueResult([{ id: 'i1', partnerId: 'p1', name: 'Widget' }]);
    queueResult([{ currencyCode: 'USD' }]);
    queueResult([]); // delete
    queueResult([]); // mirror
    await svc.removeItemPrice('i1', 'USD', actor);
    expect(mock.for.mock.invocationCallOrder[0]!).toBeLessThan(mock.delete.mock.invocationCallOrder[0]!);
    expect(mock.set).toHaveBeenCalledWith(expect.objectContaining({ unitPrice: '0.00' }));

    vi.clearAllMocks(); results.length = 0;
    queueResult([{ id: 'i1', partnerId: 'p1', name: 'Widget' }]);
    queueResult([{ currencyCode: 'USD' }]);
    queueResult([]);
    await svc.removeItemPrice('i1', 'EUR', actor);
    expect(mock.update).not.toHaveBeenCalled();
  });
});

describe('setOrgPriceOverride', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('locks the item, stamps the org currency + partner_id, upserts', async () => {
    queueResult([{ currencyCode: 'EUR' }]); // org SHARE barrier FIRST (#3778)
    queueResult([{ id: 'i1', partnerId: 'p1', name: 'Widget' }]); // item lock
    queueResult([{ partnerId: 'p1' }]); // org partner membership
    queueResult([{ id: 'ov1', unitPrice: '9.00', currencyCode: 'EUR' }]);
    const row = await svc.setOrgPriceOverride('i1', 'org1', { unitPrice: 9 }, actor);
    expect(row).toMatchObject({ unitPrice: '9.00' });
    // Lock order (#3778): organizations FOR SHARE, THEN the catalog item FOR
    // UPDATE, then the upsert — the org lock is the transaction's first statement.
    expect(mock.for.mock.calls.map((c) => c[0])).toEqual(['share', 'update']);
    expect(mock.for.mock.invocationCallOrder[1]!).toBeLessThan(mock.onConflictDoUpdate.mock.invocationCallOrder[0]!);
    expect(mock.values).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'p1', orgId: 'org1', currencyCode: 'EUR', unitPrice: '9.00' }));
  });

  it('ORG_DENIED (403) when the org belongs to another partner', async () => {
    queueResult([{ currencyCode: 'EUR' }]); // org SHARE barrier (#3778)
    queueResult([{ id: 'i1', partnerId: 'p1', name: 'Widget' }]);
    queueResult([{ partnerId: 'p2' }]);
    await expect(svc.setOrgPriceOverride('i1', 'org1', { unitPrice: 9 }, actor))
      .rejects.toMatchObject({ status: 403, code: 'ORG_DENIED' });
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it('a transient failure on the org barrier is rethrown, not masked as 403 ORG_DENIED (#3778 finding 5)', async () => {
    // The barrier's `.catch(() => ORG_DENIED)` used to swallow EVERY rejection:
    // a 40001/40P01 raised by the new row lock (it contends with
    // changeOrgCurrency's FOR UPDATE) was reported to the caller as a permanent
    // authorization failure instead of a retriable error, and helper bugs hid.
    const serialization = Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
    queueRejection(serialization);
    await expect(svc.setOrgPriceOverride('i1', 'org1', { unitPrice: 9 }, actor))
      .rejects.toBe(serialization);
    expect(mock.insert).not.toHaveBeenCalled();
  });

  it('a missing org on the barrier still maps to 403 ORG_DENIED', async () => {
    queueResult([]); // org SHARE barrier finds no row
    await expect(svc.setOrgPriceOverride('i1', 'org1', { unitPrice: 9 }, actor))
      .rejects.toMatchObject({ status: 403, code: 'ORG_DENIED' });
  });

  it('explicit JPY 10.5 → PRICE_NOT_REPRESENTABLE', async () => {
    queueResult([{ currencyCode: 'USD' }]); // org SHARE barrier (#3778)
    queueResult([{ id: 'i1', partnerId: 'p1', name: 'Widget' }]);
    queueResult([{ partnerId: 'p1' }]);
    await expect(svc.setOrgPriceOverride('i1', 'org1', { unitPrice: 10.5, currencyCode: 'JPY' }, actor))
      .rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
  });
});

describe('createCatalogItem return shape', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('returns the created row with its price-book rows (no second fetch for import-and-add flows)', async () => {
    queueCreate('USD');
    const created = await svc.createCatalogItem({ ...baseCreate, unitPrice: 10, costBasis: 8, markupPercent: 50, costCurrency: 'EUR' }, actor);
    expect(created).toMatchObject({ id: 'i1' });
    expect(created.prices).toEqual([
      { currencyCode: 'EUR', unitPrice: '12.00' },
      { currencyCode: 'USD', unitPrice: '10.00' },
    ]);
  });
});

describe('updateCatalogItem price drivers', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const existing = {
    id: 'i1', partnerId: 'p1', sku: 'W-1', name: 'Widget', isBundle: false,
    costBasis: '50.00', markupPercent: '20.00', costCurrency: 'USD',
  };

  it('a PATCH that merely echoes the stored cost does NOT re-derive over an explicit price', async () => {
    queueResult([existing]); // lock
    queueResult([{ currencyCode: 'USD' }]); // partner currency
    queueResult([{ ...existing, name: 'Renamed' }]); // update returning
    const row = await svc.updateCatalogItem('i1', { name: 'Renamed', costBasis: 50 }, actor);
    expect(row).toMatchObject({ name: 'Renamed' });
    expect(mock.onConflictDoUpdate).not.toHaveBeenCalled(); // no price-book write
    expect(mock.update).toHaveBeenCalledTimes(1); // item patch only, no mirror
  });

  it('a changed cost re-derives cost × markup into the cost-currency row', async () => {
    queueResult([existing]); // lock
    queueResult([{ currencyCode: 'USD' }]); // partner currency
    queueResult([{ ...existing, costBasis: '60.00' }]); // update returning
    queueResult([{ id: 'pr1', currencyCode: 'USD', unitPrice: '72.00' }]); // price upsert returning
    queueResult([{ ...existing, costBasis: '60.00', unitPrice: '72.00' }]); // mirror
    await svc.updateCatalogItem('i1', { costBasis: 60 }, actor);
    expect(mock.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(mock.values).toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'USD', unitPrice: '72.00' }));
  });

  it('a changed markup re-derives; an unchanged markup echo does not', async () => {
    queueResult([existing]); queueResult([{ currencyCode: 'USD' }]); queueResult([existing]);
    await svc.updateCatalogItem('i1', { markupPercent: 20 }, actor);
    expect(mock.onConflictDoUpdate).not.toHaveBeenCalled();

    vi.clearAllMocks(); results.length = 0;
    queueResult([existing]); queueResult([{ currencyCode: 'USD' }]); queueResult([existing]);
    queueResult([{ id: 'pr1' }]); queueResult([existing]);
    await svc.updateCatalogItem('i1', { markupPercent: 30 }, actor);
    expect(mock.values).toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'USD', unitPrice: '65.00' }));
  });
});

describe('applyImportedPricingBySku (#3775 review #9 — importer duplicate-SKU recovery)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('locks the owned item by SKU FOR UPDATE, upserts the requested sell-currency row + cost, mirrors last, returns item + full price book', async () => {
    queueResult([{ id: 'i1', partnerId: 'p1', sku: 'CFQ7', costBasis: '10.00', costCurrency: 'USD' }]); // lock by sku
    queueResult([{ currencyCode: 'USD' }]); // partner currency
    queueResult([{ currencyCode: 'USD' }]); // existing price-book codes (no EUR row yet)
    queueResult([{ id: 'pr-eur', itemId: 'i1', currencyCode: 'EUR', unitPrice: '22.00' }]); // EUR upsert
    queueResult([{ id: 'i1', partnerId: 'p1', sku: 'CFQ7', costBasis: '18.50', costCurrency: 'EUR' }]); // item cost update
    queueResult([{ currencyCode: 'EUR', unitPrice: '22.00' }, { currencyCode: 'USD', unitPrice: '30.00' }]); // price book read
    const res = await svc.applyImportedPricingBySku('CFQ7', { prices: [{ currencyCode: 'EUR', unitPrice: 22 }], costBasis: 18.5, costCurrency: 'EUR' }, actor);
    expect(mock.transaction).toHaveBeenCalledTimes(1);
    expect(mock.for).toHaveBeenCalledWith('update');
    expect(mock.for.mock.invocationCallOrder[0]!).toBeLessThan(mock.onConflictDoUpdate.mock.invocationCallOrder[0]!);
    expect(mock.values).toHaveBeenCalledWith(expect.objectContaining({ itemId: 'i1', partnerId: 'p1', currencyCode: 'EUR', unitPrice: '22.00' }));
    expect(mock.set).toHaveBeenCalledWith(expect.objectContaining({ costBasis: '18.50', costCurrency: 'EUR' }));
    // Non-partner currency → the deprecated unit_price mirror is untouched.
    expect(mock.set).not.toHaveBeenCalledWith(expect.objectContaining({ unitPrice: expect.anything() }));
    expect(res).toMatchObject({ id: 'i1', costBasis: '18.50', costCurrency: 'EUR' });
    expect(res.prices).toEqual([{ currencyCode: 'EUR', unitPrice: '22.00' }, { currencyCode: 'USD', unitPrice: '30.00' }]);
    expect(res.pricingApplied).toEqual({ added: ['EUR'], preserved: [] });
    expect(emitCatalogEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'catalog.item.price_changed', catalogItemId: 'i1' }));
  });

  it('legacy unitPrice lands in the partner currency and rewrites the mirror LAST', async () => {
    queueResult([{ id: 'i1', partnerId: 'p1', sku: 'CFQ7', costBasis: null, costCurrency: 'USD' }]);
    queueResult([{ currencyCode: 'USD' }]);
    queueResult([]); // existing price-book codes — none, so the USD row is ADDED
    queueResult([{ id: 'pr-usd', itemId: 'i1', currencyCode: 'USD', unitPrice: '22.00' }]); // upsert
    queueResult([{ id: 'i1', partnerId: 'p1', unitPrice: '22.00' }]); // mirror update
    queueResult([{ currencyCode: 'USD', unitPrice: '22.00' }]);
    const res = await svc.applyImportedPricingBySku('CFQ7', { unitPrice: 22 }, actor);
    expect(mock.onConflictDoUpdate.mock.invocationCallOrder[0]!).toBeLessThan(mock.update.mock.invocationCallOrder[0]!);
    expect(mock.set).toHaveBeenCalledWith(expect.objectContaining({ unitPrice: '22.00' }));
    // No cost supplied → the stored cost is left alone (no cost update statement).
    expect(mock.set).not.toHaveBeenCalledWith(expect.objectContaining({ costBasis: expect.anything() }));
    expect(res.prices).toEqual([{ currencyCode: 'USD', unitPrice: '22.00' }]);
  });

  it('an unknown-currency cost (costBasis null) never clobbers the stored cost', async () => {
    queueResult([{ id: 'i1', partnerId: 'p1', sku: 'CFQ7', costBasis: '10.00', costCurrency: 'USD' }]);
    queueResult([{ currencyCode: 'USD' }]);
    queueResult([{ currencyCode: 'USD' }]); // existing codes
    queueResult([{ id: 'pr-eur', itemId: 'i1', currencyCode: 'EUR', unitPrice: '22.00' }]);
    queueResult([{ currencyCode: 'EUR', unitPrice: '22.00' }]);
    await svc.applyImportedPricingBySku('CFQ7', { prices: [{ currencyCode: 'EUR', unitPrice: 22 }], costBasis: null, costCurrency: undefined }, actor);
    expect(mock.update).not.toHaveBeenCalled();
  });

  // #3775 review #3: the feed is authoritative for COST, never for the partner's
  // sell price. A re-import of a SKU already in the catalog must not reset a
  // hand-adjusted price-book row back to distributor MSRP.
  it('never overwrites an existing price-book row — the currency is preserved and reported, cost still updates', async () => {
    queueResult([{ id: 'i1', partnerId: 'p1', sku: 'CFQ7', costBasis: '10.00', costCurrency: 'USD' }]); // lock
    queueResult([{ currencyCode: 'USD' }]); // partner currency
    queueResult([{ currencyCode: 'EUR' }, { currencyCode: 'USD' }]); // EUR row already exists
    queueResult([{ id: 'i1', partnerId: 'p1', sku: 'CFQ7', costBasis: '18.50', costCurrency: 'EUR' }]); // cost update
    queueResult([{ currencyCode: 'EUR', unitPrice: '99.00' }, { currencyCode: 'USD', unitPrice: '30.00' }]);
    const res = await svc.applyImportedPricingBySku('CFQ7', { prices: [{ currencyCode: 'EUR', unitPrice: 22 }], costBasis: 18.5, costCurrency: 'EUR' }, actor);

    // No price write at all — not the upsert, not the mirror.
    expect(mock.onConflictDoUpdate).not.toHaveBeenCalled();
    expect(mock.values).not.toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'EUR' }));
    // The operator's 99.00 survives; the feed cost (real feed truth) is applied.
    expect(res.prices).toEqual([{ currencyCode: 'EUR', unitPrice: '99.00' }, { currencyCode: 'USD', unitPrice: '30.00' }]);
    expect(mock.set).toHaveBeenCalledWith(expect.objectContaining({ costBasis: '18.50', costCurrency: 'EUR' }));
    expect(res.pricingApplied).toEqual({ added: [], preserved: ['EUR'] });
  });

  it('adds only the currencies with no row and preserves the rest in one re-import', async () => {
    queueResult([{ id: 'i1', partnerId: 'p1', sku: 'CFQ7', costBasis: null, costCurrency: 'USD' }]);
    queueResult([{ currencyCode: 'USD' }]);
    queueResult([{ currencyCode: 'USD' }]); // USD exists, EUR does not
    queueResult([{ id: 'pr-eur', itemId: 'i1', currencyCode: 'EUR', unitPrice: '22.00' }]); // EUR upsert only
    queueResult([{ currencyCode: 'EUR', unitPrice: '22.00' }, { currencyCode: 'USD', unitPrice: '30.00' }]);
    const res = await svc.applyImportedPricingBySku(
      'CFQ7', { prices: [{ currencyCode: 'EUR', unitPrice: 22 }, { currencyCode: 'USD', unitPrice: 25 }] }, actor);

    expect(mock.values).toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'EUR', unitPrice: '22.00' }));
    expect(mock.values).not.toHaveBeenCalledWith(expect.objectContaining({ currencyCode: 'USD' }));
    // The partner-currency row was PRESERVED, so the deprecated mirror is not rewritten either.
    expect(mock.set).not.toHaveBeenCalledWith(expect.objectContaining({ unitPrice: expect.anything() }));
    expect(res.pricingApplied).toEqual({ added: ['EUR'], preserved: ['USD'] });
  });

  it('refuses an unrepresentable price (JPY 22.5) after the lock and before any write', async () => {
    queueResult([{ id: 'i1', partnerId: 'p1', sku: 'CFQ7', costBasis: null, costCurrency: 'USD' }]);
    queueResult([{ currencyCode: 'USD' }]);
    await expect(svc.applyImportedPricingBySku('CFQ7', { prices: [{ currencyCode: 'JPY', unitPrice: 22.5 }] }, actor))
      .rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
    expect(mock.insert).not.toHaveBeenCalled();
    expect(mock.update).not.toHaveBeenCalled();
  });

  it('404s when the partner owns no item with that SKU', async () => {
    queueResult([]);
    await expect(svc.applyImportedPricingBySku('nope', { unitPrice: 1 }, actor))
      .rejects.toMatchObject({ status: 404, code: 'ITEM_NOT_FOUND' });
  });
});
