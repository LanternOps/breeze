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

vi.mock('../../services/tdSynnexDigitalBridge', () => ({
  getTdSynnexDigitalBridgeStatus: vi.fn(),
  saveTdSynnexDigitalBridgeConfig: vi.fn(),
  testTdSynnexDigitalBridgeConnection: vi.fn(),
  searchTdSynnexProducts: vi.fn(),
  importTdSynnexCatalogItem: vi.fn(),
  TdSynnexDigitalBridgeError: class TdSynnexDigitalBridgeError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  }
}));

vi.mock('../../services/tdSynnexEcExpress', () => ({
  REGION_ENDPOINTS: { US: 'https://ws.synnex.com/webservice/pnaserviceV05' },
  getEcExpressStatus: vi.fn(),
  saveEcExpressConfig: vi.fn(),
  testEcExpressConnection: vi.fn(),
  lookupEcExpressProducts: vi.fn(),
  importEcExpressCatalogItem: vi.fn(),
  TdSynnexEcExpressError: class TdSynnexEcExpressError extends Error {
    public readonly status: number;
    constructor(msg: string, public code = 'EC_PROVIDER_ERROR') {
      super(msg);
      const statusMap: Record<string, number> = {
        EC_AUTH_FAILED: 422,
        EC_NOT_CONFIGURED: 404,
        EC_NO_RESULTS: 404,
        EC_DUPLICATE_SKU: 409,
        EC_PROVIDER_ERROR: 502,
        EC_PARTNER_REQUIRED: 400,
        EC_DISABLED: 400,
        EC_CREDENTIALS_INVALID: 400,
        EC_UNSUPPORTED_REGION: 400,
      };
      this.status = statusMap[code] ?? 400;
    }
  }
}));

// Mock auth middleware to inject a partner-scoped actor with catalog perms.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next()
}));

import { catalogRoutes } from './index';
import * as svc from '../../services/catalogService';
import * as tdSvc from '../../services/tdSynnexDigitalBridge';
import * as ecSvc from '../../services/tdSynnexEcExpress';

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

describe('catalog TD SYNNEX distributor routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /distributors/td-synnex/status returns masked integration status', async () => {
    (tdSvc.getTdSynnexDigitalBridgeStatus as any).mockResolvedValue({
      configured: true,
      enabled: true,
      credentials: { apiKey: '********', apiSecret: '********' }
    });
    const res = await app().request('/distributors/td-synnex/status', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.credentials.apiKey).toBe('********');
    expect(tdSvc.getTdSynnexDigitalBridgeStatus).toHaveBeenCalledOnce();
  });

  it('PUT /distributors/td-synnex/config validates and saves config', async () => {
    (tdSvc.saveTdSynnexDigitalBridgeConfig as any).mockResolvedValue({ configured: true, enabled: true });
    const res = await app().request('/distributors/td-synnex/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        environment: 'sandbox',
        region: 'US',
        baseUrl: 'https://example.test',
        authType: 'api_key',
        credentials: { apiKey: 'key', apiSecret: 'secret' },
        settings: { searchPath: '/catalog/search', searchMethod: 'GET' }
      })
    });
    expect(res.status).toBe(200);
    expect(tdSvc.saveTdSynnexDigitalBridgeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://example.test' }),
      expect.anything()
    );
  });

  it('PUT /distributors/td-synnex/config rejects invalid baseUrl', async () => {
    const res = await app().request('/distributors/td-synnex/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'not-a-url' })
    });
    expect(res.status).toBe(400);
    expect(tdSvc.saveTdSynnexDigitalBridgeConfig).not.toHaveBeenCalled();
  });

  it('PUT /distributors/td-synnex/config rejects internal or non-HTTPS baseUrl values', async () => {
    const res = await app().request('/distributors/td-synnex/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        environment: 'sandbox',
        region: 'US',
        baseUrl: 'http://127.0.0.1:8080',
        authType: 'api_key',
        credentials: { apiKey: 'key' },
        settings: { searchPath: '/catalog/search', searchMethod: 'GET' }
      })
    });
    expect(res.status).toBe(400);
    expect(tdSvc.saveTdSynnexDigitalBridgeConfig).not.toHaveBeenCalled();
  });

  it('PUT /distributors/td-synnex/config rejects absolute endpoint paths', async () => {
    const res = await app().request('/distributors/td-synnex/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        environment: 'sandbox',
        region: 'US',
        baseUrl: 'https://example.test',
        authType: 'api_key',
        credentials: { apiKey: 'key' },
        settings: { searchPath: 'https://evil.example/search', searchMethod: 'GET' }
      })
    });
    expect(res.status).toBe(400);
    expect(tdSvc.saveTdSynnexDigitalBridgeConfig).not.toHaveBeenCalled();
  });

  it('GET /distributors/td-synnex/search forwards query and limit', async () => {
    (tdSvc.searchTdSynnexProducts as any).mockResolvedValue([{ sourceProductId: 'td-1', name: 'Dock' }]);
    const res = await app().request('/distributors/td-synnex/search?q=dock&limit=10', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].name).toBe('Dock');
    expect(tdSvc.searchTdSynnexProducts).toHaveBeenCalledWith({ q: 'dock', limit: 10 }, expect.anything());
  });

  it('POST /distributors/td-synnex/import creates a catalog item from a provider product', async () => {
    (tdSvc.importTdSynnexCatalogItem as any).mockResolvedValue({ id: 'catalog-1', name: 'Dock' });
    const product = {
      source: 'td_synnex_digital_bridge',
      sourceProductId: 'td-1',
      sku: 'SKU-1',
      manufacturerPartNumber: 'MPN-1',
      vendor: 'Vendor',
      name: 'Dock',
      description: null,
      cost: '100.00',
      currency: 'USD',
      availability: 4,
      warehouses: [],
      raw: {},
      lastRefreshedAt: new Date().toISOString()
    };
    const res = await app().request('/distributors/td-synnex/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product, item: { name: 'Dock', sku: 'SKU-1', unitPrice: 125, costBasis: 100, taxable: true } })
    });
    expect(res.status).toBe(200);
    expect(tdSvc.importTdSynnexCatalogItem).toHaveBeenCalledOnce();
  });

  it('maps provider errors to their status code', async () => {
    (tdSvc.searchTdSynnexProducts as any).mockRejectedValue(
      new (tdSvc as any).TdSynnexDigitalBridgeError('missing endpoint', 400, 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED')
    );
    const res = await app().request('/distributors/td-synnex/search?q=dock', { method: 'GET' });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('TD_SYNNEX_ENDPOINT_NOT_CONFIGURED');
  });

  it('maps a duplicate-SKU CatalogServiceError from import to a 409', async () => {
    // import drops its own pre-check and relies on createCatalogItem's unique
    // index, which surfaces a CatalogServiceError the distributor route must map.
    (tdSvc.importTdSynnexCatalogItem as any).mockRejectedValue(
      new (svc as any).CatalogServiceError('An item with this SKU already exists', 409, 'DUPLICATE_SKU')
    );
    const product = {
      source: 'td_synnex_digital_bridge', sourceProductId: 'td-1', sku: 'SKU-1',
      manufacturerPartNumber: null, vendor: null, name: 'Dock', description: null,
      cost: '100.00', currency: 'USD', availability: null, warehouses: [], raw: {},
      lastRefreshedAt: new Date().toISOString()
    };
    const res = await app().request('/distributors/td-synnex/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product, item: { name: 'Dock', sku: 'SKU-1', unitPrice: 125, taxable: true } })
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('DUPLICATE_SKU');
  });

  it('rejects an oversized raw provider blob on import', async () => {
    const product = {
      source: 'td_synnex_digital_bridge', sourceProductId: 'td-1', sku: 'SKU-1',
      manufacturerPartNumber: null, vendor: null, name: 'Dock', description: null,
      cost: '100.00', currency: 'USD', availability: null, warehouses: [],
      raw: { blob: 'x'.repeat(200_001) },
      lastRefreshedAt: new Date().toISOString()
    };
    const res = await app().request('/distributors/td-synnex/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ product, item: { name: 'Dock', unitPrice: 125, taxable: true } })
    });
    expect(res.status).toBe(400);
    expect(tdSvc.importTdSynnexCatalogItem).not.toHaveBeenCalled();
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

describe('catalog EC Express distributor routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /distributors/td-synnex-ec/status returns masked status', async () => {
    (ecSvc.getEcExpressStatus as any).mockResolvedValue({ configured: true, enabled: true });
    const res = await app().request('/distributors/td-synnex-ec/status', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.configured).toBe(true);
    expect(ecSvc.getEcExpressStatus).toHaveBeenCalledOnce();
  });

  it('POST /distributors/td-synnex-ec/test returns 200 with the masked status', async () => {
    (ecSvc.testEcExpressConnection as any).mockResolvedValue({
      configured: true,
      enabled: true,
      region: 'US',
      credentials: { email: '********', password: '********', customerNo: '********' },
      lastTestStatus: 'success',
      lastTestAt: new Date().toISOString(),
      lastTestError: null,
    });
    const res = await app().request('/distributors/td-synnex-ec/test', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.lastTestStatus).toBe('success');
    expect(ecSvc.testEcExpressConnection).toHaveBeenCalledOnce();
  });

  it('PUT /distributors/td-synnex-ec/config rejects an invalid region enum value with 400', async () => {
    const res = await app().request('/distributors/td-synnex-ec/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ region: 'XX', enabled: true })
    });
    expect(res.status).toBe(400);
    expect(ecSvc.saveEcExpressConfig).not.toHaveBeenCalled();
  });

  it('GET /distributors/td-synnex-ec/lookup surfaces EC_AUTH_FAILED as 422', async () => {
    (ecSvc.lookupEcExpressProducts as any).mockRejectedValue(
      new (ecSvc as any).TdSynnexEcExpressError('TD SYNNEX authentication failed', 'EC_AUTH_FAILED')
    );
    const res = await app().request('/distributors/td-synnex-ec/lookup?q=8938995', { method: 'GET' });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('EC_AUTH_FAILED');
  });

  const validEcProduct = {
    source: 'td_synnex_ec_express',
    synnexSku: '8938995',
    mfgPartNo: 'DOCK-1',
    status: 'ACTIVE',
    name: 'TD Dock',
    description: 'A dock',
    currency: 'USD',
    cost: 100.0,
    msrp: 125.0,
    discount: null,
    totalQty: 5,
    weight: 1.2,
    parcelShippable: 'Y',
    warehouses: [],
    raw: {},
  };

  it('POST /distributors/td-synnex-ec/import creates a catalog item from EC product', async () => {
    (ecSvc.importEcExpressCatalogItem as any).mockResolvedValue({ id: 'catalog-ec-1', name: 'TD Dock' });
    const product = validEcProduct;
    const res = await app().request('/distributors/td-synnex-ec/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product,
        item: { name: 'TD Dock', sku: '8938995', unitPrice: 125.00, costBasis: 100.00, taxable: true }
      })
    });
    expect(res.status).toBe(200);
    expect(ecSvc.importEcExpressCatalogItem).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.data.id).toBe('catalog-ec-1');
  });

  it('POST /distributors/td-synnex-ec/import rejects invalid item (missing name) with 400', async () => {
    const res = await app().request('/distributors/td-synnex-ec/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product: { synnexSKU: '8938995' },
        item: { unitPrice: 125.00 }
      })
    });
    expect(res.status).toBe(400);
    expect(ecSvc.importEcExpressCatalogItem).not.toHaveBeenCalled();
  });

  it('maps EC_DUPLICATE_SKU CatalogServiceError from import to 409', async () => {
    (ecSvc.importEcExpressCatalogItem as any).mockRejectedValue(
      new (svc as any).CatalogServiceError('An item with this SKU already exists', 409, 'DUPLICATE_SKU')
    );
    const product = validEcProduct;
    const res = await app().request('/distributors/td-synnex-ec/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product,
        item: { name: 'TD Dock', sku: '8938995', unitPrice: 125.00, taxable: true }
      })
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('DUPLICATE_SKU');
  });
});
