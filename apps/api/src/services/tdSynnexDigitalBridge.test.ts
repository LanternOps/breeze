import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class SsrfBlockedError extends Error {}
  return {
    db: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
    },
    encryptSecret: vi.fn((value: string | null | undefined) => value ? `enc(${value})` : null),
    decryptForColumn: vi.fn((_table: string, _column: string, value: string | null | undefined) => value ?? null),
    createCatalogItem: vi.fn(),
    safeFetch: vi.fn(),
    SsrfBlockedError,
    enrichDistributorListing: vi.fn(),
  };
});

vi.mock('../db', () => ({ db: mocks.db }));
vi.mock('./secretCrypto', () => ({
  encryptSecret: mocks.encryptSecret,
  decryptForColumn: mocks.decryptForColumn,
}));
vi.mock('./catalogService', () => ({
  createCatalogItem: mocks.createCatalogItem,
}));
vi.mock('./catalogEnrichmentService', () => ({ enrichDistributorListing: mocks.enrichDistributorListing }));
vi.mock('./urlSafety', () => ({
  safeFetch: mocks.safeFetch,
  SsrfBlockedError: mocks.SsrfBlockedError,
}));

import {
  getTdSynnexDigitalBridgeStatus,
  importTdSynnexCatalogItem,
  saveTdSynnexDigitalBridgeConfig,
  searchTdSynnexProducts,
  normalizeTdSynnexProducts,
  normalizeTdSynnexBaseUrl,
  normalizeTdSynnexEndpointPath,
  TD_SYNNEX_MASKED_SECRET,
  TdSynnexDigitalBridgeError,
} from './tdSynnexDigitalBridge';

const actor = { userId: 'user-1', partnerId: 'partner-1', accessibleOrgIds: null };

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

function insertChain(returningRows: unknown[]) {
  return {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returningRows),
  };
}

// db.update(...).set(...).where(...) — `where` is awaited directly on the search
// path and `.returning()` is chained on the test-connection path.
function updateChain(returningRows: unknown[] = []) {
  return {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(returningRows),
    returning: vi.fn().mockResolvedValue(returningRows),
  };
}

function fakeResponse(status: number, body: string) {
  return { status, ok: status >= 200 && status < 300, text: async () => body } as unknown as Response;
}

const enabledRow = {
  id: 'integration-1',
  partnerId: actor.partnerId,
  environment: 'sandbox',
  region: 'US',
  baseUrl: 'https://digitalbridge.example.test',
  authType: 'api_key',
  enabled: true,
  credentials: { apiKey: 'enc(key)' },
  settings: { searchPath: '/search' },
};

describe('tdSynnexDigitalBridge service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('masks credentials when reading integration status', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([{
      id: 'integration-1',
      environment: 'sandbox',
      region: 'US',
      baseUrl: 'https://digitalbridge.test',
      authType: 'api_key',
      enabled: true,
      credentials: { apiKey: 'enc(key)', apiSecret: 'enc(secret)' },
      settings: { searchPath: '/search' },
      lastTestStatus: null,
      lastTestAt: null,
      lastTestError: null,
      lastSyncAt: null,
      lastError: null,
    }]));

    const status = await getTdSynnexDigitalBridgeStatus(actor);

    expect(status.configured).toBe(true);
    expect(status.credentials).toEqual({ apiKey: TD_SYNNEX_MASKED_SECRET, apiSecret: TD_SYNNEX_MASKED_SECRET });
  });

  it('preserves existing encrypted credentials when masked values are submitted', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([{
      credentials: { apiKey: 'enc(old-key)', apiSecret: 'enc(old-secret)' },
      settings: { searchPath: '/old-search' },
    }]));
    mocks.db.insert.mockReturnValueOnce(insertChain([{
      id: 'integration-1',
      environment: 'sandbox',
      region: 'US',
      baseUrl: 'https://digitalbridge.test',
      authType: 'api_key',
      enabled: true,
      credentials: { apiKey: 'enc(old-key)', apiSecret: 'enc(old-secret)' },
      settings: { searchPath: '/new-search', searchMethod: 'GET' },
      lastTestStatus: null,
      lastTestAt: null,
      lastTestError: null,
      lastSyncAt: null,
      lastError: null,
    }]));

    await saveTdSynnexDigitalBridgeConfig({
      environment: 'sandbox',
      region: 'US',
      baseUrl: 'https://digitalbridge.test',
      authType: 'api_key',
      enabled: true,
      credentials: { apiKey: TD_SYNNEX_MASKED_SECRET, apiSecret: TD_SYNNEX_MASKED_SECRET },
      settings: { searchPath: '/new-search', searchMethod: 'GET' },
    }, actor);

    const insert = mocks.db.insert.mock.results[0]!.value;
    const values = insert.values.mock.calls[0]![0];
    expect(values.credentials).toEqual({ apiKey: 'enc(old-key)', apiSecret: 'enc(old-secret)' });
    expect(mocks.encryptSecret).not.toHaveBeenCalledWith(TD_SYNNEX_MASKED_SECRET);
  });

  it('clears existing encrypted credentials when blank or null values are submitted', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([{
      credentials: { apiKey: 'enc(old-key)', apiSecret: 'enc(old-secret)' },
      settings: { searchPath: '/old-search' },
    }]));
    mocks.db.insert.mockReturnValueOnce(insertChain([{
      id: 'integration-1',
      environment: 'sandbox',
      region: 'US',
      baseUrl: 'https://digitalbridge.test',
      authType: 'api_key',
      enabled: true,
      credentials: {},
      settings: { searchPath: '/new-search', searchMethod: 'GET' },
      lastTestStatus: null,
      lastTestAt: null,
      lastTestError: null,
      lastSyncAt: null,
      lastError: null,
    }]));

    await saveTdSynnexDigitalBridgeConfig({
      environment: 'sandbox',
      region: 'US',
      baseUrl: 'https://digitalbridge.test',
      authType: 'api_key',
      enabled: true,
      credentials: { apiKey: '', apiSecret: null },
      settings: { searchPath: '/new-search', searchMethod: 'GET' },
    }, actor);

    const insert = mocks.db.insert.mock.results[0]!.value;
    const values = insert.values.mock.calls[0]![0];
    expect(values.credentials).toEqual({});
  });

  it('rejects import when TD SYNNEX integration is disabled', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([{
      id: 'integration-1',
      partnerId: actor.partnerId,
      enabled: false,
    }]));

    await expect(importTdSynnexCatalogItem({
      product: {
        source: 'td_synnex_digital_bridge',
        sourceProductId: 'td-1',
        sku: 'SKU-1',
        manufacturerPartNumber: null,
        vendor: null,
        name: 'Dock',
        description: null,
        cost: '100.00',
        currency: 'USD',
        availability: null,
        warehouses: [],
        raw: {},
        lastRefreshedAt: new Date().toISOString(),
      },
      item: {
        name: 'Dock',
        sku: 'SKU-1',
        unitPrice: 125,
        taxable: true,
      },
    }, actor)).rejects.toThrow(TdSynnexDigitalBridgeError);
    expect(mocks.createCatalogItem).not.toHaveBeenCalled();
  });

  it('normalizes common product fields from provider responses', () => {
    const products = normalizeTdSynnexProducts({
      products: [{
        productId: 'p-1',
        sku: 'SKU-1',
        manufacturer: 'Lenovo',
        manufacturerPartNumber: 'MPN-1',
        productName: 'ThinkPad Dock',
        netPrice: '99.5',
        currencyCode: 'USD',
        availableQuantity: '8',
        warehouses: [{ code: 'A', quantity: 8 }],
      }]
    });

    expect(products[0]).toMatchObject({
      sourceProductId: 'p-1',
      sku: 'SKU-1',
      vendor: 'Lenovo',
      manufacturerPartNumber: 'MPN-1',
      cost: '99.50',
      availability: 8,
    });
  });

  it('detects products across array/products/items/results/data shapes', () => {
    const one = { id: 'a', name: 'A' };
    expect(normalizeTdSynnexProducts([one])).toHaveLength(1);
    expect(normalizeTdSynnexProducts({ products: [one] })).toHaveLength(1);
    expect(normalizeTdSynnexProducts({ items: [one] })).toHaveLength(1);
    expect(normalizeTdSynnexProducts({ results: [one] })).toHaveLength(1);
    expect(normalizeTdSynnexProducts({ data: [one] })).toHaveLength(1);
  });

  it('returns [] for garbage / unexpected payload shapes', () => {
    expect(normalizeTdSynnexProducts(null)).toEqual([]);
    expect(normalizeTdSynnexProducts({})).toEqual([]);
    expect(normalizeTdSynnexProducts({ products: 'nope' })).toEqual([]);
    expect(normalizeTdSynnexProducts('garbage')).toEqual([]);
  });

  it('skips provider rows with no usable identifier instead of fabricating ids', () => {
    const products = normalizeTdSynnexProducts([
      { name: 'No identifier' },           // no id, no sku -> skipped
      {},                                  // empty -> skipped
      { sku: 'ONLY-SKU', name: 'Has SKU' } // sku becomes the sourceProductId
    ]);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ sourceProductId: 'ONLY-SKU', sku: 'ONLY-SKU' });
  });

  it('formats numeric cost to a 2-decimal string', () => {
    const [product] = normalizeTdSynnexProducts([{ id: 'p', name: 'P', price: 99.5 }]);
    expect(product!.cost).toBe('99.50');
  });

  it('rejects partner-less actors before touching the database', async () => {
    await expect(getTdSynnexDigitalBridgeStatus({ ...actor, partnerId: null }))
      .rejects.toMatchObject({ code: 'TD_SYNNEX_PARTNER_REQUIRED', status: 400 });
    expect(mocks.db.select).not.toHaveBeenCalled();
  });

  it('encrypts a freshly submitted credential (trimmed)', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([{ credentials: {}, settings: {} }]));
    mocks.db.insert.mockReturnValueOnce(insertChain([{ ...enabledRow, credentials: { apiKey: 'enc(new-key)' } }]));

    await saveTdSynnexDigitalBridgeConfig({
      environment: 'sandbox', region: 'US', baseUrl: 'https://digitalbridge.example.test',
      authType: 'api_key', enabled: true,
      credentials: { apiKey: '  new-key  ' },
      settings: { searchPath: '/search', searchMethod: 'GET' },
    }, actor);

    const values = mocks.db.insert.mock.results[0]!.value.values.mock.calls[0]![0];
    expect(values.credentials.apiKey).toBe('enc(new-key)');
    expect(mocks.encryptSecret).toHaveBeenCalledWith('new-key');
  });

  it('never emits stored ciphertext or plaintext in masked status', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([{
      ...enabledRow, credentials: { apiKey: 'enc(supersecret)', apiSecret: 'enc(topsecret)' },
    }]));
    const status = await getTdSynnexDigitalBridgeStatus(actor);
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('enc(');
  });

  it('requires the secret for basic auth before reporting configured', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([{
      ...enabledRow, authType: 'basic', credentials: { apiKey: 'enc(key)' },
    }]));
    const status = await getTdSynnexDigitalBridgeStatus(actor);
    expect(status.configured).toBe(false);
  });

  describe('normalizeTdSynnexBaseUrl', () => {
    it('accepts and trims a valid https url', () => {
      expect(normalizeTdSynnexBaseUrl('https://digitalbridge.example.test/v1/?x=1#frag'))
        .toBe('https://digitalbridge.example.test/v1');
    });

    it.each([
      ['not-a-url'],
      ['http://digitalbridge.example.test'],     // not https
      ['https://user:pass@digitalbridge.example.test'], // embedded credentials
      ['https://127.0.0.1'],                     // internal address
      ['https://localhost'],
    ])('rejects %s', (value) => {
      expect(() => normalizeTdSynnexBaseUrl(value))
        .toThrow(expect.objectContaining({ code: 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED' }));
    });
  });

  describe('normalizeTdSynnexEndpointPath', () => {
    it('accepts a relative path', () => {
      expect(normalizeTdSynnexEndpointPath('/v1/search')).toBe('/v1/search');
    });

    it.each([
      ['search'],            // no leading slash
      ['//evil.example'],    // protocol-relative
      ['/a\\b'],             // backslash
      ['/a\r\nb'],           // CRLF
      ['https://evil.test'], // absolute url / scheme
      ['javascript:alert(1)'],
    ])('rejects %s', (value) => {
      expect(() => normalizeTdSynnexEndpointPath(value))
        .toThrow(expect.objectContaining({ code: 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED' }));
    });
  });

  describe('requestDigitalBridge error mapping (via search)', () => {
    beforeEach(() => {
      mocks.db.select.mockReturnValue(selectChain([enabledRow]));
      mocks.db.update.mockReturnValue(updateChain());
    });

    it('maps a 401 response to TD_SYNNEX_AUTH_FAILED and records lastError', async () => {
      mocks.safeFetch.mockResolvedValueOnce(fakeResponse(401, ''));
      await expect(searchTdSynnexProducts({ q: 'dock', limit: 20 }, actor))
        .rejects.toMatchObject({ code: 'TD_SYNNEX_AUTH_FAILED', status: 401 });
      const setArg = mocks.db.update.mock.results[0]!.value.set.mock.calls[0]![0];
      expect(setArg.lastError).toContain('credentials');
    });

    it('maps a non-ok response to TD_SYNNEX_PROVIDER_ERROR (502)', async () => {
      mocks.safeFetch.mockResolvedValueOnce(fakeResponse(500, '{}'));
      await expect(searchTdSynnexProducts({ q: 'dock', limit: 20 }, actor))
        .rejects.toMatchObject({ code: 'TD_SYNNEX_PROVIDER_ERROR', status: 502 });
    });

    it('maps invalid JSON to TD_SYNNEX_PROVIDER_ERROR', async () => {
      mocks.safeFetch.mockResolvedValueOnce(fakeResponse(200, '{not json'));
      await expect(searchTdSynnexProducts({ q: 'dock', limit: 20 }, actor))
        .rejects.toMatchObject({ code: 'TD_SYNNEX_PROVIDER_ERROR' });
    });

    it('maps a timeout to TD_SYNNEX_PROVIDER_ERROR', async () => {
      const abort = new Error('aborted'); abort.name = 'AbortError';
      mocks.safeFetch.mockRejectedValueOnce(abort);
      await expect(searchTdSynnexProducts({ q: 'dock', limit: 20 }, actor))
        .rejects.toMatchObject({ code: 'TD_SYNNEX_PROVIDER_ERROR' });
    });

    it('maps an SSRF block to TD_SYNNEX_ENDPOINT_NOT_CONFIGURED', async () => {
      mocks.safeFetch.mockRejectedValueOnce(new mocks.SsrfBlockedError('blocked'));
      await expect(searchTdSynnexProducts({ q: 'dock', limit: 20 }, actor))
        .rejects.toMatchObject({ code: 'TD_SYNNEX_ENDPOINT_NOT_CONFIGURED' });
    });

    it('returns normalized products and clears lastError on success', async () => {
      mocks.safeFetch.mockResolvedValueOnce(fakeResponse(200, JSON.stringify({ products: [{ id: 'p-1', name: 'Dock' }] })));
      const products = await searchTdSynnexProducts({ q: 'dock', limit: 20 }, actor);
      expect(products).toHaveLength(1);
      const setArg = mocks.db.update.mock.results[0]!.value.set.mock.calls[0]![0];
      expect(setArg.lastError).toBeNull();
    });
  });

  it('fails loudly when stored credentials are a corrupt non-string', async () => {
    mocks.db.select.mockReturnValue(selectChain([{ ...enabledRow, credentials: { apiKey: 123 } }]));
    mocks.db.update.mockReturnValue(updateChain());
    await expect(searchTdSynnexProducts({ q: 'dock', limit: 20 }, actor))
      .rejects.toMatchObject({ code: 'TD_SYNNEX_CREDENTIALS_INVALID', status: 400 });
  });

  it('maps a configured base path through to the resolved endpoint url', async () => {
    mocks.db.select.mockReturnValue(selectChain([{
      ...enabledRow, baseUrl: 'https://digitalbridge.example.test/digitalbridge/v1', settings: { searchPath: '/products/search' },
    }]));
    mocks.db.update.mockReturnValue(updateChain());
    mocks.safeFetch.mockResolvedValueOnce(fakeResponse(200, JSON.stringify({ products: [] })));
    await searchTdSynnexProducts({ q: 'dock', limit: 20 }, actor);
    const calledUrl = mocks.safeFetch.mock.calls[0]![0] as string;
    // base path prefix must be preserved, not dropped by absolute-path resolution
    expect(calledUrl).toContain('/digitalbridge/v1/products/search');
  });

  it('imports a provider product mapping distributor metadata into attributes', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([enabledRow]));
    mocks.createCatalogItem.mockResolvedValueOnce({ id: 'catalog-1' });
    await importTdSynnexCatalogItem({
      product: {
        source: 'td_synnex_digital_bridge', sourceProductId: 'td-1', sku: 'SKU-1',
        manufacturerPartNumber: 'MPN-1', vendor: 'Lenovo', name: 'Dock', description: 'desc',
        cost: '100.00', currency: 'USD', availability: 4, warehouses: [{ code: 'A' }],
        raw: { anything: true }, lastRefreshedAt: new Date().toISOString(),
      },
      item: { name: 'Dock', sku: 'SKU-1', unitPrice: 125, taxable: true },
    }, actor);
    const input = mocks.createCatalogItem.mock.calls[0]![0];
    expect(input.attributes.distributor).toMatchObject({
      provider: 'td_synnex_digital_bridge', sourceProductId: 'td-1', vendor: 'Lenovo',
    });
    // raw provider blob must NOT be persisted into the catalog item
    expect(input.attributes.distributor).not.toHaveProperty('raw');
    expect(mocks.enrichDistributorListing).not.toHaveBeenCalled(); // aiCleanup unset → no AI
  });

  it('web-enriches name + description when aiCleanup is set, anchoring on the MPN', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([enabledRow]));
    mocks.createCatalogItem.mockResolvedValueOnce({ id: 'catalog-2' });
    mocks.enrichDistributorListing.mockResolvedValueOnce({
      name: 'Lenovo ThinkPad USB-C Dock Gen 2',
      description: 'USB-C dock, dual 4K, 90W PD, GbE.',
      itemType: 'hardware',
      priceGuidance: null,
      provenance: { source: 'ai_enrich', model: 'm', query: 'q', suggestion: {}, enrichedAt: 't', enrichedBy: 'u1' },
    });
    await importTdSynnexCatalogItem({
      product: {
        source: 'td_synnex_digital_bridge', sourceProductId: 'td-1', sku: 'SKU-1',
        manufacturerPartNumber: 'MPN-1', vendor: 'Lenovo', name: 'SPL Dock DISTI', description: 'raw',
        cost: '100.00', currency: 'USD', availability: 4, warehouses: [{ code: 'A' }],
        raw: { anything: true }, lastRefreshedAt: new Date().toISOString(),
      },
      item: { name: 'SPL Dock DISTI', sku: 'SKU-1', unitPrice: 125, taxable: true },
      aiCleanup: true,
    }, actor);
    const [query, hint] = mocks.enrichDistributorListing.mock.calls[0]!;
    expect(query).toContain('MPN-1');
    expect(hint).toBe('hardware');
    const input = mocks.createCatalogItem.mock.calls[0]![0];
    expect(input.name).toBe('Lenovo ThinkPad USB-C Dock Gen 2');
    expect(input.description).toMatch(/4K/);
    expect(input.attributes.distributor.aiEnriched).toBe(true);
    expect(input.attributes.distributor.rawName).toBe('SPL Dock DISTI');
  });

  it('keeps raw values and marks aiEnriched=false when enrichment is unavailable', async () => {
    mocks.db.select.mockReturnValueOnce(selectChain([enabledRow]));
    mocks.createCatalogItem.mockResolvedValueOnce({ id: 'catalog-3' });
    mocks.enrichDistributorListing.mockResolvedValueOnce(null); // budget/rate/timeout
    await importTdSynnexCatalogItem({
      product: {
        source: 'td_synnex_digital_bridge', sourceProductId: 'td-1', sku: 'SKU-1',
        manufacturerPartNumber: 'MPN-1', vendor: 'Lenovo', name: 'SPL Dock DISTI', description: 'raw desc',
        cost: '100.00', currency: 'USD', availability: 4, warehouses: [{ code: 'A' }],
        raw: { anything: true }, lastRefreshedAt: new Date().toISOString(),
      },
      item: { name: 'SPL Dock DISTI', sku: 'SKU-1', unitPrice: 125, taxable: true },
      aiCleanup: true,
    }, actor);
    const input = mocks.createCatalogItem.mock.calls[0]![0];
    expect(input.name).toBe('SPL Dock DISTI'); // unchanged
    expect(input.description).toBe('raw desc');
    expect(input.attributes.distributor.aiEnriched).toBe(false);
    expect(input.attributes.distributor.aiProvenance).toBeUndefined();
  });
});
