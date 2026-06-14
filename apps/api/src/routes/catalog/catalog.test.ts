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
