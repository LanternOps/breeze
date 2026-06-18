import { describe, expect, it, vi } from 'vitest';
import { Pax8Client } from './pax8Client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Pax8Client', () => {
  it('fetches a token, paginates companies, and normalizes company ids/names', async () => {
    const doFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/token')) {
        return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
      }
      if (url.includes('/companies') && url.includes('page=0')) {
        return jsonResponse({
          content: [{ id: 123, name: 'Acme Co', status: 'ACTIVE' }],
          page: 0,
          totalPages: 2,
        });
      }
      if (url.includes('/companies') && url.includes('page=1')) {
        return jsonResponse({
          content: [{ companyId: 'co-2', companyName: 'Beta Co' }],
          page: 1,
          totalPages: 2,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const client = new Pax8Client({
      apiBaseUrl: 'https://api.pax8.com/v1',
      tokenUrl: 'https://api.pax8.com/v1/token',
      credentials: { clientId: 'client', clientSecret: 'secret' },
      fetch: doFetch,
    });

    await expect(client.listCompanies()).resolves.toMatchObject([
      { pax8CompanyId: '123', name: 'Acme Co', status: 'ACTIVE' },
      { pax8CompanyId: 'co-2', name: 'Beta Co' },
    ]);
    expect(doFetch).toHaveBeenCalledTimes(3);
  });

  it('normalizes subscription quantities and nested product/company metadata', async () => {
    const doFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/token')) return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
      if (url.includes('/subscriptions')) {
        return jsonResponse({
          content: [{
            id: 'sub-1',
            company: { id: 'company-1' },
            product: { id: 'prod-1', name: 'Microsoft 365 Business Premium', vendorSkuId: 'sku-1', vendor: { name: 'Microsoft' } },
            quantity: 12,
            pricing: { unitPrice: 22, currencyCode: 'USD' },
            cost: { unitCost: '18.5' },
            status: 'ACTIVE',
            billingTerm: 'MONTHLY',
          }],
          page: 0,
          totalPages: 1,
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const client = new Pax8Client({
      apiBaseUrl: 'https://api.pax8.com/v1',
      tokenUrl: 'https://api.pax8.com/v1/token',
      credentials: { clientId: 'client', clientSecret: 'secret' },
      fetch: doFetch,
    });

    await expect(client.listSubscriptions()).resolves.toMatchObject([{
      pax8SubscriptionId: 'sub-1',
      pax8CompanyId: 'company-1',
      productId: 'prod-1',
      productName: 'Microsoft 365 Business Premium',
      vendorName: 'Microsoft',
      vendorSkuId: 'sku-1',
      quantity: '12.00',
      unitPrice: '22.00',
      unitCost: '18.50',
      currencyCode: 'USD',
    }]);
  });
});
