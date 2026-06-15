import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — routes are thin; we assert wiring, validation, error mapping.
vi.mock('../../services/catalogService', () => ({
  createCatalogItem: vi.fn(),
  updateCatalogItem: vi.fn(),
  archiveCatalogItem: vi.fn(),
  listCatalogItems: vi.fn(),
  getCatalogItem: vi.fn(),
  setOrgPriceOverride: vi.fn(),
  removeOrgPriceOverride: vi.fn(),
  setBundleComponents: vi.fn(),
  computeBundleEconomics: vi.fn(),
  CatalogServiceError: class CatalogServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  }
}));

// Mock auth middleware to inject a partner-scoped actor with catalog perms.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next()
}));

import { catalogRoutes } from './index';
import * as svc from '../../services/catalogService';

function app() {
  // catalogRoutes already applies authMiddleware internally
  return catalogRoutes;
}

describe('catalog routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POST /catalog creates an item', async () => {
    (svc.createCatalogItem as any).mockResolvedValue({ id: 'c1', name: 'X' });
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'service', name: 'Onsite hour', unitPrice: 150 })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('c1');
    expect(svc.createCatalogItem).toHaveBeenCalledOnce();
  });

  it('POST /catalog rejects invalid body (negative price)', async () => {
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'service', name: 'X', unitPrice: -1 })
    });
    expect(res.status).toBe(400);
    expect(svc.createCatalogItem).not.toHaveBeenCalled();
  });

  it('GET /catalog lists items', async () => {
    (svc.listCatalogItems as any).mockResolvedValue([{ id: 'c1' }]);
    const res = await app().request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
  });

  it('maps CatalogServiceError to its status code', async () => {
    (svc.createCatalogItem as any).mockRejectedValue(new (svc as any).CatalogServiceError('dupe', 409, 'DUPLICATE_SKU'));
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemType: 'service', name: 'X', unitPrice: 1 })
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('DUPLICATE_SKU');
  });
});

const ITEM_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';

describe('catalog pricing routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PUT /:id/pricing/:orgId sets an override', async () => {
    (svc.setOrgPriceOverride as any).mockResolvedValue({ id: 'pr1', orgId: ORG_ID, unitPrice: '99.00' });
    const res = await app().request(`/${ITEM_ID}/pricing/${ORG_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unitPrice: 99 })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.unitPrice).toBe('99.00');
    expect(svc.setOrgPriceOverride).toHaveBeenCalledWith(ITEM_ID, ORG_ID, { unitPrice: 99 }, expect.anything());
  });

  it('PUT /:id/pricing/:orgId rejects a non-UUID id param (400, no service call)', async () => {
    const res = await app().request(`/not-a-uuid/pricing/${ORG_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unitPrice: 99 })
    });
    expect(res.status).toBe(400);
    expect(svc.setOrgPriceOverride).not.toHaveBeenCalled();
  });

  it('PUT /:id/pricing/:orgId rejects a negative unitPrice body (400, no service call)', async () => {
    const res = await app().request(`/${ITEM_ID}/pricing/${ORG_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unitPrice: -5 })
    });
    expect(res.status).toBe(400);
    expect(svc.setOrgPriceOverride).not.toHaveBeenCalled();
  });

  it('maps an ORG_DENIED CatalogServiceError to 403 through handleServiceError', async () => {
    (svc.setOrgPriceOverride as any).mockRejectedValue(
      new (svc as any).CatalogServiceError('Organization not accessible', 403, 'ORG_DENIED')
    );
    const res = await app().request(`/${ITEM_ID}/pricing/${ORG_ID}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unitPrice: 99 })
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('ORG_DENIED');
  });

  it('DELETE /:id/pricing/:orgId removes an override', async () => {
    (svc.removeOrgPriceOverride as any).mockResolvedValue({ ok: true });
    const res = await app().request(`/${ITEM_ID}/pricing/${ORG_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ok).toBe(true);
    expect(svc.removeOrgPriceOverride).toHaveBeenCalledWith(ITEM_ID, ORG_ID, expect.anything());
  });

  it('DELETE /:id/pricing/:orgId rejects a non-UUID orgId param (400)', async () => {
    const res = await app().request(`/${ITEM_ID}/pricing/not-a-uuid`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect(svc.removeOrgPriceOverride).not.toHaveBeenCalled();
  });
});

describe('catalog bundle routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PUT /:id/components sets bundle components', async () => {
    (svc.setBundleComponents as any).mockResolvedValue({ item: { id: ITEM_ID }, components: [], overrides: [] });
    const components = [{ componentItemId: ORG_ID, quantity: 2 }];
    const res = await app().request(`/${ITEM_ID}/components`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ components })
    });
    expect(res.status).toBe(200);
    // route passes through `.components`, not the whole body
    expect(svc.setBundleComponents).toHaveBeenCalledWith(
      ITEM_ID,
      [{ componentItemId: ORG_ID, quantity: 2, showOnInvoice: false }],
      expect.anything()
    );
  });

  it('PUT /:id/components rejects a component with a non-UUID componentItemId (400)', async () => {
    const res = await app().request(`/${ITEM_ID}/components`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ components: [{ componentItemId: 'nope', quantity: 1 }] })
    });
    expect(res.status).toBe(400);
    expect(svc.setBundleComponents).not.toHaveBeenCalled();
  });

  it('maps a NOT_A_BUNDLE CatalogServiceError to 400 on PUT /:id/components', async () => {
    (svc.setBundleComponents as any).mockRejectedValue(
      new (svc as any).CatalogServiceError('Item is not a bundle', 400, 'NOT_A_BUNDLE')
    );
    const res = await app().request(`/${ITEM_ID}/components`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ components: [] })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('NOT_A_BUNDLE');
  });

  it('GET /:id/economics returns the economics payload', async () => {
    (svc.computeBundleEconomics as any).mockResolvedValue({ headlinePrice: '100.00', totalCost: '75.00', margin: '25.00' });
    const res = await app().request(`/${ITEM_ID}/economics`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.margin).toBe('25.00');
    expect(svc.computeBundleEconomics).toHaveBeenCalledWith(ITEM_ID, null, expect.anything());
  });

  it('GET /:id/economics forwards a valid orgId query param', async () => {
    (svc.computeBundleEconomics as any).mockResolvedValue({ headlinePrice: '100.00' });
    const res = await app().request(`/${ITEM_ID}/economics?orgId=${ORG_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(svc.computeBundleEconomics).toHaveBeenCalledWith(ITEM_ID, ORG_ID, expect.anything());
  });

  it('GET /:id/economics rejects a non-UUID orgId query param (400)', async () => {
    const res = await app().request(`/${ITEM_ID}/economics?orgId=not-a-uuid`, { method: 'GET' });
    expect(res.status).toBe(400);
    expect(svc.computeBundleEconomics).not.toHaveBeenCalled();
  });
});
