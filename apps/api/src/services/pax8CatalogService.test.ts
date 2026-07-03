import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), insert: vi.fn() },
  createPax8ClientForIntegration: vi.fn(),
  createCatalogItem: vi.fn(),
  getRedis: vi.fn(() => null),
  enrichDistributorListing: vi.fn(),
  // #2190 — pass-through wrapper; kept as a vi.fn (not an inline arrow) so
  // tests can assert call ORDER relative to enrichDistributorListing.
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../db', () => ({ db: mocks.db, withDbAccessContext: mocks.withDbAccessContext }));
vi.mock('./pax8SyncService', () => ({ createPax8ClientForIntegration: mocks.createPax8ClientForIntegration }));
vi.mock('./catalogService', async (orig) => ({ ...(await orig<typeof import('./catalogService')>()), createCatalogItem: mocks.createCatalogItem }));
vi.mock('./redis', () => ({ getRedis: mocks.getRedis }));
vi.mock('./catalogEnrichmentService', () => ({ enrichDistributorListing: mocks.enrichDistributorListing }));

import { searchPax8Products, importPax8CatalogItem, getPax8CatalogStatus, getPax8ProductPricing, Pax8CatalogError } from './pax8CatalogService';
import { CatalogServiceError } from './catalogService';

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
  mocks.createPax8ClientForIntegration.mockReset(); mocks.createCatalogItem.mockReset();
  mocks.getRedis.mockReturnValue(null);
  mocks.enrichDistributorListing.mockReset();
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

  it('throws Pax8CatalogError when no active integration', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([]));
    await expect(searchPax8Products({ q: 'x', limit: 20 }, actor)).rejects.toBeInstanceOf(Pax8CatalogError);
  });
});

describe('importPax8CatalogItem', () => {
  it('is idempotent on DUPLICATE_SKU: resolves existing item and still upserts mapping', async () => {
    mocks.db.select
      .mockReturnValueOnce(selectChain([integration]))   // getActiveIntegration
      .mockReturnValueOnce(selectChain([{ id: 'existing-1', name: 'Microsoft 365 Business Premium' }])); // fallback lookup
    mocks.createCatalogItem.mockRejectedValueOnce(new CatalogServiceError('dup', 409, 'DUPLICATE_SKU'));
    mocks.db.insert.mockReturnValueOnce(insertChain());
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', currency: 'USD', raw: {} };
    const item = await importPax8CatalogItem({ product, item: { name: product.name, sku: 'CFQ7', unitPrice: 22 } }, actor, dbCtx);
    expect(item.id).toBe('existing-1');
    expect(mocks.db.insert).toHaveBeenCalled();
  });

  it('creates a recurring software catalog item and upserts the product mapping', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createCatalogItem.mockResolvedValue({ id: 'item-1', name: 'Microsoft 365 Business Premium' });
    mocks.db.insert.mockReturnValueOnce(insertChain());
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', currency: 'USD', raw: {} };
    const item = await importPax8CatalogItem({ product, item: { name: product.name, sku: 'CFQ7', unitPrice: 22, costBasis: 18.5, taxable: true } }, actor, dbCtx);
    expect(item.id).toBe('item-1');
    const arg = mocks.createCatalogItem.mock.calls[0]![0];
    expect(arg).toMatchObject({ itemType: 'software', billingType: 'recurring', billingFrequency: 'monthly', unitPrice: 22, costBasis: 18.5 });
    expect((arg.attributes as any).pax8.pax8ProductId).toBe('p1');
    expect(mocks.db.insert).toHaveBeenCalled();
    expect(mocks.enrichDistributorListing).not.toHaveBeenCalled(); // aiCleanup unset → no AI
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
