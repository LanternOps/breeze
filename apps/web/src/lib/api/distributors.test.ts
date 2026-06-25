// apps/web/src/lib/api/distributors.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import { ecExpressStatus, ecExpressLookup, ecExpressImport, sellPriceDefault, type EcProduct } from './distributors';

const product: EcProduct = {
  source: 'td_synnex_ec_express', synnexSku: 'ABC123', mfgPartNo: 'MFG-1', status: 'Active',
  name: 'Widget', description: 'A widget', currency: 'USD', cost: 80, msrp: 100, discount: null,
  totalQty: 5, warehouses: [], weight: null, parcelShippable: null, raw: {},
};

beforeEach(() => { fetchWithAuth.mockReset(); fetchWithAuth.mockResolvedValue(new Response('{}')); });

describe('distributors client', () => {
  it('status hits the status route', async () => {
    await ecExpressStatus();
    expect(fetchWithAuth).toHaveBeenCalledWith('/catalog/distributors/td-synnex-ec/status');
  });

  it('lookup encodes the query', async () => {
    await ecExpressLookup('a b/c');
    expect(fetchWithAuth).toHaveBeenCalledWith('/catalog/distributors/td-synnex-ec/lookup?q=a%20b%2Fc');
  });

  it('import POSTs product + item', async () => {
    await ecExpressImport({ product, item: { name: 'Widget', sku: 'ABC123', description: null, unitPrice: 100, costBasis: 80 } });
    const [url, opts] = fetchWithAuth.mock.calls[0];
    expect(url).toBe('/catalog/distributors/td-synnex-ec/import');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body).item.unitPrice).toBe(100);
    expect(JSON.parse(opts.body).product.synnexSku).toBe('ABC123');
  });

  it('sellPriceDefault prefers msrp, falls back to cost, then empty', () => {
    expect(sellPriceDefault(product)).toBe('100.00');
    expect(sellPriceDefault({ ...product, msrp: null })).toBe('80.00');
    expect(sellPriceDefault({ ...product, msrp: null, cost: null })).toBe('');
  });
});
