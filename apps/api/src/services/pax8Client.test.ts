import { describe, expect, it, vi } from 'vitest';
import { Pax8ApiError, Pax8Client } from './pax8Client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(doFetch: (url: string, init?: any) => Promise<Response>, creds?: Partial<{ accessToken: string | null; accessTokenExpiresAt: Date | null }>) {
  return new Pax8Client({
    apiBaseUrl: 'https://api.pax8.com/v1',
    tokenUrl: 'https://api.pax8.com/v1/token',
    credentials: { clientId: 'client', clientSecret: 'secret', ...creds },
    fetch: doFetch as any,
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

  it('throws Pax8ApiError with status and body on a non-2xx data response', async () => {
    const doFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/token')) return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
      return new Response('rate limited', { status: 429 });
    });
    const client = makeClient(doFetch);

    const err = await client.listCompanies().catch((e) => e);
    expect(err).toBeInstanceOf(Pax8ApiError);
    expect(err.status).toBe(429);
    expect(err.body).toContain('rate limited');
  });

  it('throws Pax8ApiError when the token request fails', async () => {
    const doFetch = vi.fn(async () => new Response('bad creds', { status: 401 }));
    const client = makeClient(doFetch);

    const err = await client.listCompanies().catch((e) => e);
    expect(err).toBeInstanceOf(Pax8ApiError);
    expect(err.status).toBe(401);
  });

  it('throws when the token response omits an access token', async () => {
    const doFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/token')) return jsonResponse({ expires_in: 3600 });
      return jsonResponse({ content: [] });
    });
    const client = makeClient(doFetch);

    await expect(client.listCompanies()).rejects.toBeInstanceOf(Pax8ApiError);
  });

  it('reuses a cached token that is not near expiry (no token request)', async () => {
    const doFetch = vi.fn(async (url: string, init?: any) => {
      if (url.endsWith('/token')) throw new Error('should not refresh a valid token');
      return jsonResponse({ content: [{ id: 'co-1', name: 'Acme' }], last: true });
    });
    const client = makeClient(doFetch, {
      accessToken: 'cached-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await expect(client.listCompanies()).resolves.toHaveLength(1);
    expect(doFetch).toHaveBeenCalledTimes(1); // data only, no /token
    expect(doFetch.mock.calls[0]![1]!.headers.authorization).toBe('Bearer cached-token');
  });

  it('refreshes a token that is within the 5-minute expiry skew', async () => {
    const doFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/token')) return jsonResponse({ access_token: 'fresh-token', expires_in: 3600 });
      return jsonResponse({ content: [{ id: 'co-1', name: 'Acme' }], last: true });
    });
    const client = makeClient(doFetch, {
      accessToken: 'stale-token',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 1000), // < 5 min → refresh
    });

    await client.listCompanies();
    const tokenCalls = doFetch.mock.calls.filter(([url]) => String(url).endsWith('/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(client.cachedAccessToken.token).toBe('fresh-token');
  });

  it('stops paginating when the page payload reports last=true', async () => {
    const doFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/token')) return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
      if (url.includes('page=0')) return jsonResponse({ content: [{ id: 'a', name: 'A' }], last: false, page: 0 });
      if (url.includes('page=1')) return jsonResponse({ content: [{ id: 'b', name: 'B' }], last: true, page: 1 });
      throw new Error(`should not fetch beyond last page: ${url}`);
    });
    const client = makeClient(doFetch);

    await expect(client.listCompanies()).resolves.toHaveLength(2);
    // token + page0 + page1, never page2
    expect(doFetch).toHaveBeenCalledTimes(3);
  });

  it('stops paginating when a page returns zero rows', async () => {
    const doFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/token')) return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
      if (url.includes('page=0')) return jsonResponse({ content: [{ id: 'a', name: 'A' }], totalPages: 5, page: 0 });
      return jsonResponse({ content: [], totalPages: 5, page: 1 });
    });
    const client = makeClient(doFetch);

    await expect(client.listCompanies()).resolves.toHaveLength(1);
    expect(doFetch).toHaveBeenCalledTimes(3); // token + page0 + empty page1, then break
  });

  it('drops malformed records missing id or name', async () => {
    const doFetch = vi.fn(async (url: string) => {
      if (url.endsWith('/token')) return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
      return jsonResponse({
        content: [
          { id: 'co-1', name: 'Good Co' },
          { id: 'co-2' }, // missing name → dropped
          { name: 'No Id Co' }, // missing id → dropped
          'not-an-object', // dropped
        ],
        last: true,
      });
    });
    const client = makeClient(doFetch);

    await expect(client.listCompanies()).resolves.toEqual([
      { pax8CompanyId: 'co-1', name: 'Good Co', status: null, metadata: { id: 'co-1', name: 'Good Co' } },
    ]);
  });
});

function clientWithFetch(fetchImpl: (url: string) => Response) {
  return new Pax8Client({
    credentials: { clientId: 'id', clientSecret: 'secret', accessToken: 'tok', accessTokenExpiresAt: new Date(Date.now() + 3_600_000) },
    fetch: async (url: string) => fetchImpl(url),
  });
}

describe('Pax8Client.listProducts', () => {
  it('normalizes products from a paged content envelope', async () => {
    const client = clientWithFetch((url) => {
      if (url.includes('/products')) {
        return jsonResponse({
          content: [
            { id: 'p1', name: 'Microsoft 365 Business Premium', vendor: { name: 'Microsoft' }, vendorSku: 'CFQ7' },
            { productId: 'p2', productName: 'Acronis Backup', vendorName: 'Acronis', sku: 'ACR-1' },
          ],
          last: true,
          page: 0,
        });
      }
      return jsonResponse({});
    });
    const rows = await client.listProducts({ limit: 10 });
    expect(rows).toEqual([
      { pax8ProductId: 'p1', name: 'Microsoft 365 Business Premium', vendorName: 'Microsoft', vendorSku: 'CFQ7', shortDescription: null, raw: expect.any(Object) },
      { pax8ProductId: 'p2', name: 'Acronis Backup', vendorName: 'Acronis', vendorSku: 'ACR-1', shortDescription: null, raw: expect.any(Object) },
    ]);
  });
});

describe('Pax8Client.getProductPricing', () => {
  it('normalizes the cost + suggested retail per term', async () => {
    const client = clientWithFetch((url) => {
      if (url.includes('/pricing')) {
        return jsonResponse({
          content: [
            { commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: 18.5, suggestedRetailPrice: 22, currencyCode: 'USD' },
            { commitmentTerm: 'Monthly', billingTerm: 'Monthly', partnerBuyRate: '20', suggestedRetailPrice: '25.00', currency: 'USD' },
          ],
          last: true,
        });
      }
      return jsonResponse({});
    });
    const rows = await client.getProductPricing('p1');
    expect(rows[0]).toEqual({ commitmentTerm: 'Annual', billingTerm: 'Monthly', partnerBuyRate: '18.50', suggestedRetailPrice: '22.00', currencyCode: 'USD', raw: expect.any(Object) });
    expect(rows[1]).toMatchObject({ commitmentTerm: 'Monthly', partnerBuyRate: '20.00', suggestedRetailPrice: '25.00', currencyCode: 'USD' });
  });
});
