import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Pax8 service mocks ─────────────────────────────────────────────────────────

const pax8Svc = vi.hoisted(() => ({
  getPax8CatalogStatus: vi.fn(),
  searchPax8Products: vi.fn(),
  getPax8ProductPricing: vi.fn(),
  importPax8CatalogItem: vi.fn(),
}));

const { Pax8CatalogError } = vi.hoisted(() => {
  class Pax8CatalogError extends Error {
    constructor(public override message: string, public status = 400, public code?: string) { super(message); }
  }
  return { Pax8CatalogError };
});

vi.mock('../../services/pax8CatalogService', () => ({
  ...pax8Svc,
  Pax8CatalogError,
}));

// ── Auth middleware mock — requireMfa uses a gate so individual tests can block ─

const mfaGate = vi.hoisted(() => ({ block: false }));

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (c: any, next: any) => {
    if (mfaGate.block) return c.json({ error: 'MFA required' }, 403);
    return next();
  },
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    CATALOG_READ: { resource: 'catalog', action: 'read' },
    CATALOG_WRITE: { resource: 'catalog', action: 'write' },
  },
}));

vi.mock('../../services/ssrfGuard', () => ({
  checkSsrfSafe: () => ({ ok: true }),
}));

vi.mock('../../services/catalogService', () => ({
  CatalogServiceError: class CatalogServiceError extends Error {
    constructor(public override message: string, public status = 400, public code?: string) { super(message); }
  },
}));

vi.mock('./catalog', () => ({
  catalogActorFrom: (_c: any) => ({ userId: 'u1', partnerId: 'p1', orgId: null, accessibleOrgIds: null }),
}));

// Stub sibling distributor services (also imported by distributors.ts)
vi.mock('../../services/tdSynnexDigitalBridge', () => ({
  getTdSynnexDigitalBridgeStatus: vi.fn(),
  saveTdSynnexDigitalBridgeConfig: vi.fn(),
  testTdSynnexDigitalBridgeConnection: vi.fn(),
  searchTdSynnexProducts: vi.fn(),
  importTdSynnexCatalogItem: vi.fn(),
  TdSynnexDigitalBridgeError: class TdSynnexDigitalBridgeError extends Error {
    constructor(public override message: string, public status = 400, public code?: string) { super(message); }
  },
}));

vi.mock('../../services/tdSynnexEcExpress', () => ({
  REGION_ENDPOINTS: { US: 'https://ws.synnex.com/webservice/pnaserviceV05' },
  getEcExpressStatus: vi.fn(),
  saveEcExpressConfig: vi.fn(),
  testEcExpressConnection: vi.fn(),
  lookupEcExpressProducts: vi.fn(),
  importEcExpressCatalogItem: vi.fn(),
  TdSynnexEcExpressError: class TdSynnexEcExpressError extends Error {
    public status: number;
    constructor(public override message: string, public code = 'EC_PROVIDER_ERROR') {
      super(message);
      const statusMap: Record<string, number> = {
        EC_AUTH_FAILED: 422, EC_NOT_CONFIGURED: 404, EC_NO_RESULTS: 404,
        EC_DUPLICATE_SKU: 409, EC_PROVIDER_ERROR: 502, EC_PARTNER_REQUIRED: 400,
        EC_DISABLED: 400, EC_CREDENTIALS_INVALID: 400, EC_UNSUPPORTED_REGION: 400,
      };
      this.status = statusMap[code] ?? 400;
    }
  },
}));

import { catalogDistributorRoutes } from './distributors';

const fakeAuth = { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null };

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('auth', fakeAuth); await next(); });
  a.route('/', catalogDistributorRoutes);
  return a;
}

beforeEach(() => {
  Object.values(pax8Svc).forEach((f) => f.mockReset());
  mfaGate.block = false;
});

// ── GET /distributors/pax8/status ─────────────────────────────────────────────

describe('GET /distributors/pax8/status', () => {
  it('returns configured/enabled flags', async () => {
    pax8Svc.getPax8CatalogStatus.mockResolvedValue({ configured: true, enabled: true });
    const res = await app().request('/distributors/pax8/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.configured).toBe(true);
    expect(pax8Svc.getPax8CatalogStatus).toHaveBeenCalledOnce();
  });

  it('maps Pax8CatalogError to its status code', async () => {
    pax8Svc.getPax8CatalogStatus.mockRejectedValue(
      new Pax8CatalogError('Pax8 is not connected', 400, 'PAX8_NOT_CONFIGURED'),
    );
    const res = await app().request('/distributors/pax8/status');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('PAX8_NOT_CONFIGURED');
  });
});

// ── GET /distributors/pax8/search ─────────────────────────────────────────────

describe('GET /distributors/pax8/search', () => {
  it('returns matched products', async () => {
    pax8Svc.searchPax8Products.mockResolvedValue([{
      pax8ProductId: 'p1', name: 'Microsoft 365', vendorName: 'Microsoft',
      vendorSku: 'CFQ7', shortDescription: null, raw: {},
    }]);
    const res = await app().request('/distributors/pax8/search?q=micro&limit=20');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(pax8Svc.searchPax8Products).toHaveBeenCalledWith(
      { q: 'micro', limit: 20 },
      expect.anything(),
    );
  });

  it('rejects q shorter than 2 chars (400)', async () => {
    const res = await app().request('/distributors/pax8/search?q=m');
    expect(res.status).toBe(400);
    expect(pax8Svc.searchPax8Products).not.toHaveBeenCalled();
  });

  it('forwards optional vendor filter', async () => {
    pax8Svc.searchPax8Products.mockResolvedValue([]);
    const res = await app().request('/distributors/pax8/search?q=office&vendor=Microsoft');
    expect(res.status).toBe(200);
    expect(pax8Svc.searchPax8Products).toHaveBeenCalledWith(
      { q: 'office', vendor: 'Microsoft', limit: 20 },
      expect.anything(),
    );
  });
});

// ── GET /distributors/pax8/pricing ────────────────────────────────────────────

describe('GET /distributors/pax8/pricing', () => {
  it('returns pricing tiers for a product', async () => {
    pax8Svc.getPax8ProductPricing.mockResolvedValue([{ priceRangeStart: 1, partnerBuyRate: '10.00' }]);
    const res = await app().request('/distributors/pax8/pricing?productId=prod-abc-123');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(pax8Svc.getPax8ProductPricing).toHaveBeenCalledWith('prod-abc-123', expect.anything());
  });

  it('rejects a missing productId (400)', async () => {
    const res = await app().request('/distributors/pax8/pricing');
    expect(res.status).toBe(400);
    expect(pax8Svc.getPax8ProductPricing).not.toHaveBeenCalled();
  });
});

// ── POST /distributors/pax8/import ────────────────────────────────────────────

const validProduct = {
  source: 'pax8',
  pax8ProductId: 'prod-123',
  name: 'Microsoft 365 Business Basic',
  vendorName: 'Microsoft',
  vendorSku: 'CFQ7TTC0LH18',
  commitmentTerm: 'P1Y',
  billingTerm: 'Annual',
  partnerBuyRate: '6.00',
  currency: 'USD',
  raw: {},
};

describe('POST /distributors/pax8/import', () => {
  it('creates a catalog item from a Pax8 product', async () => {
    pax8Svc.importPax8CatalogItem.mockResolvedValue({ id: 'ci-1', name: 'Microsoft 365 Business Basic' });
    const res = await app().request('/distributors/pax8/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product: validProduct,
        item: { name: 'Microsoft 365 Business Basic', unitPrice: 8.00 },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('ci-1');
    expect(pax8Svc.importPax8CatalogItem).toHaveBeenCalledOnce();
  });

  it('requires MFA — returns 403 without it', async () => {
    mfaGate.block = true;
    const res = await app().request('/distributors/pax8/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product: validProduct, item: { name: 'X', unitPrice: 1 } }),
    });
    expect(res.status).toBe(403);
    expect(pax8Svc.importPax8CatalogItem).not.toHaveBeenCalled();
  });

  it('rejects an oversized raw payload (400)', async () => {
    const res = await app().request('/distributors/pax8/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product: { ...validProduct, raw: { blob: 'x'.repeat(200_001) } },
        item: { name: 'X', unitPrice: 1 },
      }),
    });
    expect(res.status).toBe(400);
    expect(pax8Svc.importPax8CatalogItem).not.toHaveBeenCalled();
  });

  it('rejects a negative unitPrice (400)', async () => {
    const res = await app().request('/distributors/pax8/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product: validProduct, item: { name: 'X', unitPrice: -1 } }),
    });
    expect(res.status).toBe(400);
    expect(pax8Svc.importPax8CatalogItem).not.toHaveBeenCalled();
  });

  it('maps Pax8CatalogError to its status code', async () => {
    pax8Svc.importPax8CatalogItem.mockRejectedValue(
      new Pax8CatalogError('Pax8 is not connected', 400, 'PAX8_NOT_CONFIGURED'),
    );
    const res = await app().request('/distributors/pax8/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product: validProduct, item: { name: 'M365', unitPrice: 8 } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('PAX8_NOT_CONFIGURED');
  });
});
