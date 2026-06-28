import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), insert: vi.fn() },
  createPax8ClientForIntegration: vi.fn(),
  createCatalogItem: vi.fn(),
  getRedis: vi.fn(() => null),
}));

vi.mock('../db', () => ({ db: mocks.db }));
vi.mock('./pax8SyncService', () => ({ createPax8ClientForIntegration: mocks.createPax8ClientForIntegration }));
vi.mock('./catalogService', async (orig) => ({ ...(await orig<typeof import('./catalogService')>()), createCatalogItem: mocks.createCatalogItem }));
vi.mock('./redis', () => ({ getRedis: mocks.getRedis }));

import { searchPax8Products, importPax8CatalogItem, getPax8CatalogStatus, getPax8ProductPricing, Pax8CatalogError } from './pax8CatalogService';

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };
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
  it('creates a recurring software catalog item and upserts the product mapping', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([integration]));
    mocks.createCatalogItem.mockResolvedValue({ id: 'item-1', name: 'Microsoft 365 Business Premium' });
    mocks.db.insert.mockReturnValueOnce(insertChain());
    const product = { source: 'pax8' as const, pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', currency: 'USD', raw: {} };
    const item = await importPax8CatalogItem({ product, item: { name: product.name, sku: 'CFQ7', unitPrice: 22, costBasis: 18.5, taxable: true } }, actor);
    expect(item.id).toBe('item-1');
    const arg = mocks.createCatalogItem.mock.calls[0]![0];
    expect(arg).toMatchObject({ itemType: 'software', billingType: 'recurring', billingFrequency: 'monthly', unitPrice: 22, costBasis: 18.5 });
    expect((arg.attributes as any).pax8.pax8ProductId).toBe('p1');
    expect(mocks.db.insert).toHaveBeenCalled();
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
