import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  encryptSecret: vi.fn((value: string | null | undefined) => value ? `enc(${value})` : null),
  decryptForColumn: vi.fn((_table: string, _column: string, value: string | null | undefined) => value ?? null),
  createCatalogItem: vi.fn(),
}));

vi.mock('../db', () => ({ db: mocks.db }));
vi.mock('./secretCrypto', () => ({
  encryptSecret: mocks.encryptSecret,
  decryptForColumn: mocks.decryptForColumn,
}));
vi.mock('./catalogService', () => ({
  createCatalogItem: mocks.createCatalogItem,
}));

import {
  getTdSynnexDigitalBridgeStatus,
  importTdSynnexCatalogItem,
  saveTdSynnexDigitalBridgeConfig,
  normalizeTdSynnexProducts,
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
});
