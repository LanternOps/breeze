import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), insert: vi.fn() },
  createPax8ClientForIntegration: vi.fn(),
  createCatalogItem: vi.fn(),
  applyImportedPricing: vi.fn(),
  getRedis: vi.fn(() => null),
  enrichDistributorListing: vi.fn(),
  // #2190 — pass-through wrapper; kept as a vi.fn (not an inline arrow) so
  // tests can assert call ORDER relative to enrichDistributorListing.
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../db', () => ({ db: mocks.db, withDbAccessContext: mocks.withDbAccessContext }));
vi.mock('./pax8SyncService', () => ({ createPax8ClientForIntegration: mocks.createPax8ClientForIntegration }));
vi.mock('./catalogService', async (orig) => ({
  ...(await orig<typeof import('./catalogService')>()),
  createCatalogItem: mocks.createCatalogItem,
  applyImportedPricing: mocks.applyImportedPricing,
}));
vi.mock('./redis', () => ({ getRedis: mocks.getRedis }));
vi.mock('./catalogEnrichmentService', () => ({ enrichDistributorListing: mocks.enrichDistributorListing }));

import { searchPax8Products, importPax8CatalogItem, getPax8CatalogStatus, getPax8ProductPricing, Pax8CatalogError } from './pax8CatalogService';
import { CatalogServiceError } from './catalogService';
import { pax8ProductMappings } from '../db/schema/pax8';

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };
// #2190 — the request-scoped DbAccessContext the route rebuilds from `auth` and
// passes into the import function alongside `actor`.
const dbCtx = { scope: 'partner' as const, orgId: null, accessibleOrgIds: null, accessiblePartnerIds: ['p1'], userId: 'u1', currentPartnerId: 'p1' };
const integration = { id: 'int-1', partnerId: 'p1', isActive: true };

function selectChain(rows: unknown[]) {
  return { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue(rows) };
}
function insertChain() {
  return { values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockReturnThis(), returning: vi.fn().mockResolvedValue([{ id: 'map-1' }]) };
}

beforeEach(() => {
  mocks.db.select.mockReset(); mocks.db.insert.mockReset();
  // Any select a test does not queue (the import's product-mapping lookup) finds nothing.
  mocks.db.select.mockReturnValue(selectChain([]));
  mocks.createPax8ClientForIntegration.mockReset(); mocks.createCatalogItem.mockReset();
  mocks.getRedis.mockReturnValue(null);
  mocks.enrichDistributorListing.mockReset();
  mocks.applyImportedPricing.mockReset();
  // mockClear (not mockReset) preserves the pass-through implementation while
  // resetting call history/order between tests.
  mocks.withDbAccessContext.mockClear();
});

describe('searchPax8Products', () => {
  it('filters the partner product list by substring (cache miss path)', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createPax8ClientForIntegration.mockResolvedValue({
      integration,
      client: { listProducts: vi.fn().mockResolvedValue([
        { pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', shortDescription: null, raw: {} },
        { pax8ProductId: 'p2', name: 'Acronis Backup', vendorName: 'Acronis', vendorSku: 'ACR', shortDescription: null, raw: {} },
      ]) },
    });
    const res = await searchPax8Products({ q: 'microsoft', limit: 20 }, actor);
    expect(res).toHaveLength(1);
    expect(res[0]!.pax8ProductId).toBe('p1');
  });

  it('matches on the Pax8 product id (#12322)', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createPax8ClientForIntegration.mockResolvedValue({
      integration,
      client: { listProducts: vi.fn().mockResolvedValue([
        { pax8ProductId: 'ABC-123-XYZ', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'MST-1', shortDescription: null, raw: {} },
        { pax8ProductId: 'def-456', name: 'Acronis Backup', vendorName: 'Acronis', vendorSku: 'ACR', shortDescription: null, raw: {} },
      ]) },
    });
    const res = await searchPax8Products({ q: 'c-123', limit: 20 }, actor);
    expect(res.map((p) => p.pax8ProductId)).toEqual(['ABC-123-XYZ']);
  });

  it('throws Pax8CatalogError when no active integration', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([]));
    await expect(searchPax8Products({ q: 'x', limit: 20 }, actor)).rejects.toBeInstanceOf(Pax8CatalogError);
  });
});

describe('importPax8CatalogItem', () => {
  it('on DUPLICATE_SKU applies the requested sell-currency price + feed cost to the existing item and returns item + price book (#3775 review #9)', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration])); // getActiveIntegration
    mocks.createCatalogItem.mockRejectedValueOnce(new CatalogServiceError('dup', 409, 'DUPLICATE_SKU'));
    const merged = { id: 'existing-1', name: 'Microsoft 365 Business Premium', costBasis: '18.50', costCurrency: 'USD', prices: [{ currencyCode: 'EUR', unitPrice: '22.00' }, { currencyCode: 'USD', unitPrice: '30.00' }] };
    mocks.applyImportedPricing.mockResolvedValueOnce(merged);
    mocks.db.insert.mockReturnValueOnce(insertChain());
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', currency: 'USD', raw: {} };
    const item = await importPax8CatalogItem({ product, item: { name: product.name, sku: 'CFQ7', unitPrice: 22, sellCurrency: 'EUR' } }, actor, dbCtx);
    expect(mocks.applyImportedPricing).toHaveBeenCalledWith(
      { sku: 'CFQ7' },
      expect.objectContaining({ prices: [{ currencyCode: 'EUR', unitPrice: 22 }], costBasis: 18.5, costCurrency: 'USD' }),
      actor,
    );
    expect(item).toBe(merged); // same shape as creation — includes the price book
    // Integration + product-mapping lookups only (no mapping, so the SKU path ran).
    // No raw catalog_items lookup: the service resolves + locks the row itself.
    expect(mocks.db.select).toHaveBeenCalledTimes(2);
    expect(mocks.db.insert).toHaveBeenCalled(); // mapping upsert still happens
    const mapping = (mocks.db.insert.mock.results[0]!.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0]![0];
    expect(mapping).toMatchObject({ catalogItemId: 'existing-1', pax8ProductId: 'p1' });
  });

  // #12527: items imported before #12524 carry Pax8's JSON-string vendorSku as
  // their SKU, so a re-import with the real SKU never hits DUPLICATE_SKU.
  it('re-importing a product first imported under its JSON-string SKU updates that item instead of creating a second one (#12527)', async () => {
    const catalog: Array<{ id: string; sku: string | null }> = [];
    let mappedItemId: string | null = null;
    mocks.db.select.mockImplementation(() => {
      let table: unknown;
      const chain = {
        from: vi.fn((t: unknown) => { table = t; return chain; }),
        where: vi.fn(() => chain),
        limit: vi.fn(async () => (table === pax8ProductMappings ? (mappedItemId ? [{ catalogItemId: mappedItemId }] : []) : [integration])),
      };
      return chain;
    });
    mocks.db.insert.mockImplementation(() => {
      const chain = {
        values: vi.fn((v: { catalogItemId: string }) => { mappedItemId = v.catalogItemId; return chain; }),
        onConflictDoUpdate: vi.fn(() => chain),
      };
      return chain;
    });
    mocks.createCatalogItem.mockImplementation(async (p: { sku: string | null }) => {
      const created = { id: `item-${catalog.length + 1}`, sku: p.sku };
      catalog.push(created);
      return created;
    });
    mocks.applyImportedPricing.mockImplementation(async (target: { itemId: string; sku: string | null; replacesSku: string | null }) => {
      const found = catalog.find((i) => i.id === target.itemId)!;
      if (target.sku && found.sku === target.replacesSku) found.sku = target.sku;
      return found;
    });
    // Pax8 sends both: the plain sku, and the JSON-string vendorSku the importer used before #12524.
    const raw = { sku: 'CFQ7', vendorSku: '{"sku":"CFQ7"}' };
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', currency: 'USD', raw };

    await importPax8CatalogItem({ product, item: { name: product.name, sku: '{"sku":"CFQ7"}', unitPrice: 22 } }, actor, dbCtx);
    await importPax8CatalogItem({ product, item: { name: product.name, sku: 'CFQ7', unitPrice: 25, sellCurrency: 'EUR' } }, actor, dbCtx);

    expect(catalog).toEqual([{ id: 'item-1', sku: 'CFQ7' }]);
    expect(mappedItemId).toBe('item-1');
    expect(mocks.applyImportedPricing).toHaveBeenCalledWith(
      { itemId: 'item-1', sku: 'CFQ7', replacesSku: '{"sku":"CFQ7"}' },
      expect.objectContaining({ prices: [{ currencyCode: 'EUR', unitPrice: 25 }], costBasis: 18.5, costCurrency: 'USD' }),
      actor,
    );
  });

  it('falls back to create when the mapping no longer points at an item (catalog item deleted)', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration])).mockReturnValueOnce(selectChain([{ catalogItemId: null }]));
    mocks.createCatalogItem.mockResolvedValueOnce({ id: 'item-9', name: 'M' });
    mocks.db.insert.mockReturnValueOnce(insertChain());
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'M', vendorName: null, vendorSku: 'CFQ7', commitmentTerm: null, billingTerm: null, partnerBuyRate: null, currency: null, raw: {} };
    const item = await importPax8CatalogItem({ product, item: { name: 'M', sku: 'CFQ7', unitPrice: 22 } }, actor, dbCtx);
    expect(item.id).toBe('item-9');
    expect(mocks.createCatalogItem).toHaveBeenCalledTimes(1);
    expect(mocks.applyImportedPricing).not.toHaveBeenCalled();
    const mapping = (mocks.db.insert.mock.results[0]!.value as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0]![0];
    expect(mapping).toMatchObject({ catalogItemId: 'item-9', pax8ProductId: 'p1' });
  });

  it('re-throws a non-duplicate createCatalogItem error without touching the existing item', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createCatalogItem.mockRejectedValueOnce(new CatalogServiceError('bad', 400, 'PRICE_NOT_REPRESENTABLE'));
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'M', vendorName: null, vendorSku: 'CFQ7', commitmentTerm: null, billingTerm: null, partnerBuyRate: null, currency: null, raw: {} };
    await expect(importPax8CatalogItem({ product, item: { name: 'M', sku: 'CFQ7', unitPrice: 22.5, sellCurrency: 'JPY' } }, actor, dbCtx))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE' });
    expect(mocks.applyImportedPricing).not.toHaveBeenCalled();
    expect(mocks.db.insert).not.toHaveBeenCalled();
  });

  it('creates a recurring software catalog item and upserts the product mapping', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createCatalogItem.mockResolvedValue({ id: 'item-1', name: 'Microsoft 365 Business Premium' });
    mocks.db.insert.mockReturnValueOnce(insertChain());
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', currency: 'eur', raw: {} };
    const item = await importPax8CatalogItem({ product, item: { name: product.name, sku: 'CFQ7', unitPrice: 22, costBasis: 18.5, taxable: true } }, actor, dbCtx);
    expect(item.id).toBe('item-1');
    const arg = mocks.createCatalogItem.mock.calls[0]![0];
    expect(arg).toMatchObject({ itemType: 'software', billingType: 'recurring', billingFrequency: 'monthly', unitPrice: 22, costBasis: 18.5, costCurrency: 'EUR' });
    expect((arg.attributes as any).pax8.pax8ProductId).toBe('p1');
    expect(mocks.db.insert).toHaveBeenCalled();
    expect(mocks.enrichDistributorListing).not.toHaveBeenCalled(); // aiCleanup unset → no AI
  });

  it('stores a sell price entered in a document currency as that price-book row', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createCatalogItem.mockResolvedValue({ id: 'item-3', name: 'Microsoft 365 Business Premium' });
    mocks.db.insert.mockReturnValueOnce(insertChain());
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', currency: 'USD', raw: {} };
    await importPax8CatalogItem({ product, item: { name: product.name, sku: 'CFQ7', unitPrice: 22, sellCurrency: 'EUR' } }, actor, dbCtx);
    const arg = mocks.createCatalogItem.mock.calls[0]![0];
    expect(arg.prices).toEqual([{ currencyCode: 'EUR', unitPrice: 22 }]);
    expect(arg).not.toHaveProperty('unitPrice');
  });

  it('stores the cost as NULL (not partner currency) when the Pax8 feed currency is null (#3775 review #2)', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createCatalogItem.mockResolvedValue({ id: 'item-2', name: 'Microsoft 365 Business Premium' });
    mocks.db.insert.mockReturnValueOnce(insertChain());
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', currency: null, raw: {} };
    // item.costBasis is the web form's echo of partnerBuyRate — same unknown currency.
    await importPax8CatalogItem({ product, item: { name: product.name, sku: 'CFQ7', unitPrice: 22, costBasis: 18.5 } }, actor, dbCtx);
    const arg = mocks.createCatalogItem.mock.calls[0]![0];
    expect(arg.costBasis).toBeNull();
    expect(arg.costCurrency).toBeUndefined();
  });

  it('web-enriches name + description when aiCleanup is set', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createCatalogItem.mockResolvedValue({ id: 'item-2', name: 'x' });
    mocks.db.insert.mockReturnValueOnce(insertChain());
    mocks.enrichDistributorListing.mockResolvedValueOnce({
      name: 'Microsoft 365 Business Premium (annual)',
      description: 'Office apps + Teams + Intune + Defender, per user / month.',
      itemType: 'software',
      priceGuidance: null,
      provenance: { source: 'ai_enrich', model: 'm', query: 'q', suggestion: {}, enrichedAt: 't', enrichedBy: 'u1' },
    });
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'M365 BP', vendorName: 'Microsoft', vendorSku: 'CFQ7', commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', currency: 'USD', raw: {} };
    await importPax8CatalogItem({ product, item: { name: 'M365 BP', sku: 'CFQ7', unitPrice: 22 }, aiCleanup: true }, actor, dbCtx);
    const [query, hint] = mocks.enrichDistributorListing.mock.calls[0]!;
    expect(query).toContain('Microsoft');
    expect(hint).toBe('software');
    const arg = mocks.createCatalogItem.mock.calls[0]![0];
    expect(arg.name).toBe('Microsoft 365 Business Premium (annual)');
    expect(arg.description).toMatch(/Defender/);
    expect((arg.attributes as any).pax8.aiEnriched).toBe(true);
    expect((arg.attributes as any).pax8.rawName).toBe('M365 BP');

    // #2190 — enrichDistributorListing must run BEFORE the short DB context that
    // wraps createCatalogItem + the pax8ProductMappings upsert, so the
    // (potentially 12s) call never runs inside a held transaction. The
    // getActiveIntegration read (first withDbAccessContext call) legitimately
    // happens before enrichment; the write context (second call) must come after.
    const enrichOrder = mocks.enrichDistributorListing.mock.invocationCallOrder[0]!;
    const ctxOrders = mocks.withDbAccessContext.mock.invocationCallOrder;
    expect(ctxOrders).toHaveLength(2);
    expect(ctxOrders[1]).toBeGreaterThan(enrichOrder);
  });

  it('keeps raw values and marks aiEnriched=false when enrichment is unavailable', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createCatalogItem.mockResolvedValue({ id: 'item-3', name: 'x' });
    mocks.db.insert.mockReturnValueOnce(insertChain());
    mocks.enrichDistributorListing.mockResolvedValueOnce(null); // budget/rate/timeout
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'M365 BP', vendorName: 'Microsoft', vendorSku: 'CFQ7', commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', currency: 'USD', raw: {} };
    await importPax8CatalogItem({ product, item: { name: 'M365 BP', sku: 'CFQ7', unitPrice: 22, description: 'raw desc' }, aiCleanup: true }, actor, dbCtx);
    const arg = mocks.createCatalogItem.mock.calls[0]![0];
    expect(arg.name).toBe('M365 BP'); // unchanged
    expect(arg.description).toBe('raw desc');
    expect((arg.attributes as any).pax8.aiEnriched).toBe(false);
    expect((arg.attributes as any).pax8.aiProvenance).toBeUndefined();
  });
});

describe('getPax8CatalogStatus', () => {
  it('reports configured + enabled from the active integration', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    expect(await getPax8CatalogStatus(actor)).toEqual({ configured: true, enabled: true });
  });
});

describe('getPax8ProductPricing', () => {
  it('returns pricing array for a product from the Pax8 client', async () => {
    const pricingRecord = { sku: 'CFQ7', price: 22.5, currency: 'USD', term: 'Monthly', minimumQuantity: 1 };
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createPax8ClientForIntegration.mockResolvedValue({
      integration,
      client: { getProductPricing: vi.fn().mockResolvedValue([pricingRecord]) },
    });
    const res = await getPax8ProductPricing('p1', actor);
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual(pricingRecord);
  });

  it('throws Pax8CatalogError when no active integration', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([]));
    await expect(getPax8ProductPricing('p1', actor)).rejects.toBeInstanceOf(Pax8CatalogError);
  });
});
