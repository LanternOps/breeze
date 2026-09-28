import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { slotMock } = vi.hoisted(() => ({
  slotMock: vi.fn((_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn()),
}));
vi.mock('./accountingRateLimit', async (orig) => ({
  ...(await orig<typeof import('./accountingRateLimit')>()),
  withProviderCallSlot: slotMock,
  noteDailyRemaining: vi.fn(async () => {}),
}));

import { xeroProvider, XERO_RATE_LIMIT } from './xeroProvider';
import type { AccountingConnection } from './accountingConnectionService';
import { AccountingProviderError } from './accountingProviderError';

function conn(overrides: Partial<AccountingConnection> = {}): AccountingConnection {
  return {
    id: 'c1', partnerId: 'p1', provider: 'xero',
    realmId: 'ten-A', accessToken: 'at', refreshToken: 'rt',
    accessTokenExpiresAt: new Date(Date.now() + 1_800_000), refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    environment: 'production', homeCurrency: null, multiCurrencyEnabled: null,
    defaultIncomeAccountRef: null, defaultTaxCodeRef: null,
    defaultExemptTaxCodeRef: null, defaultPaymentAccountRef: null, providerConnectionRef: 'conn-A',
    pushMode: 'auto', status: 'connected', createdAt: null, updatedAt: null, lastError: null,
    realmIdFingerprint: null, pullPayments: true, pushPayments: true, lastReconcileAt: null, cdcCursor: null,
    ...overrides,
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  process.env.XERO_CLIENT_ID = 'client-abc';
  process.env.XERO_CLIENT_SECRET = 'secret-xyz';
  process.env.XERO_REDIRECT_URI = 'https://breeze.example.com/api/v1/accounting/xero/callback';
  delete process.env.XERO_DAILY_CALL_LIMIT;
});
afterEach(() => { vi.restoreAllMocks(); slotMock.mockClear(); });

describe('xeroProvider identity and limits', () => {
  it('declares only the connect capability', () => {
    expect(xeroProvider.provider).toBe('xero');
    expect(xeroProvider.displayName).toBe('Xero');
    expect(xeroProvider.capabilities).toEqual({ connect: true, mapping: false, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false });
  });

  it('rate spec: 60/min + 5 concurrent per tenant, 10k/min app-wide, tier-aware daily budget', () => {
    expect(XERO_RATE_LIMIT.perConnection).toEqual({ limit: 60, windowSeconds: 60 });
    expect(XERO_RATE_LIMIT.maxConcurrentPerConnection).toBe(5);
    expect(XERO_RATE_LIMIT.appWide).toEqual({ limit: 10_000, windowSeconds: 60 });
    expect(XERO_RATE_LIMIT.dailyPerConnection!.limit()).toBe(1000);
    process.env.XERO_DAILY_CALL_LIMIT = '5000';
    expect(XERO_RATE_LIMIT.dailyPerConnection!.limit()).toBe(5000); // read at call time
    expect(xeroProvider.limits.rate).toBe(XERO_RATE_LIMIT);
  });

  it('connectEnvironment is always production (no Xero sandbox)', () => {
    expect(xeroProvider.connectEnvironment()).toBe('production');
  });

  it('configError reports a missing OAuth trio, null when configured', () => {
    expect(xeroProvider.configError()).toBeNull();
    delete process.env.XERO_REDIRECT_URI;
    expect(xeroProvider.configError()).toBe('Xero OAuth is not configured on this instance');
  });
});

describe('buildAuthUrl', () => {
  it('targets login.xero.com with the pinned scopes and the state', () => {
    const url = new URL(xeroProvider.buildAuthUrl('signed-state'));
    expect(`${url.origin}${url.pathname}`).toBe('https://login.xero.com/identity/connect/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-abc',
      redirect_uri: 'https://breeze.example.com/api/v1/accounting/xero/callback',
      scope: 'offline_access accounting.contacts accounting.invoices accounting.payments accounting.settings.read',
      state: 'signed-state',
    });
  });
});

describe('exchangeCode / refresh', () => {
  it('exchangeCode ignores the (absent) realmId and returns realmId ""', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ access_token: 'at', refresh_token: 'rt', expires_in: 1800 }));
    await expect(xeroProvider.exchangeCode('code', 'ignored')).resolves.toMatchObject({ realmId: '', accessToken: 'at' });
  });
});

describe('fetchRealmSettings', () => {
  it('reads BaseCurrency from Organisation and multi-currency from Currencies (count > 1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Organisations: [{ Name: 'Demo Company (NZ)', BaseCurrency: 'nzd', IsDemoCompany: true }] }))
      .mockResolvedValueOnce(json({ Currencies: [{ Code: 'NZD' }, { Code: 'AUD' }] }));
    await expect(xeroProvider.fetchRealmSettings(conn())).resolves.toEqual({ homeCurrency: 'NZD', multiCurrencyEnabled: true });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.xero.com/api.xro/2.0/Organisation',
      'https://api.xero.com/api.xro/2.0/Currencies',
    ]);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'xero-tenant-id': 'ten-A' });
  });

  it('single currency → false; malformed BaseCurrency → null', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Organisations: [{ BaseCurrency: 'dollars' }] }))
      .mockResolvedValueOnce(json({ Currencies: [{ Code: 'USD' }] }));
    await expect(xeroProvider.fetchRealmSettings(conn())).resolves.toEqual({ homeCurrency: null, multiCurrencyEnabled: false });
  });

  it('refuses a connection with no tenant', async () => {
    await expect(xeroProvider.fetchRealmSettings(conn({ realmId: null })))
      .rejects.toThrow('Xero connection is missing a tenant id');
    await expect(xeroProvider.fetchRealmSettings(conn({ realmId: null }))).rejects.toBeInstanceOf(AccountingProviderError);
    await expect(xeroProvider.fetchRealmSettings(conn({ realmId: null })))
      .rejects.toMatchObject({ kind: 'validation', provider: 'xero' });
  });

  it('refuses a connection with no access token', async () => {
    await expect(xeroProvider.fetchRealmSettings(conn({ accessToken: null })))
      .rejects.toThrow('Xero connection is missing an access token');
    await expect(xeroProvider.fetchRealmSettings(conn({ accessToken: null }))).rejects.toBeInstanceOf(AccountingProviderError);
    await expect(xeroProvider.fetchRealmSettings(conn({ accessToken: null })))
      .rejects.toMatchObject({ kind: 'validation', provider: 'xero' });
  });

  it('a null JSON body becomes a transient AccountingProviderError, not a TypeError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(null));
    await expect(xeroProvider.fetchRealmSettings(conn())).rejects.toMatchObject({ kind: 'transient', provider: 'xero' });
  });

  it('a non-array Organisations/Currencies reads as empty rather than throwing', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Organisations: 'not-an-array' }))
      .mockResolvedValueOnce(json({ Currencies: 'not-an-array' }));
    await expect(xeroProvider.fetchRealmSettings(conn())).resolves.toEqual({ homeCurrency: null, multiCurrencyEnabled: null });
  });

  it('a 429 from the Organisation call propagates as rate_limited unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }),
    );
    await expect(xeroProvider.fetchRealmSettings(conn())).rejects.toMatchObject({ kind: 'rate_limited', provider: 'xero' });
  });

  it('a limiter refusal from withProviderCallSlot propagates as the SAME error object', async () => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'Xero organisation read', throttleSource: 'local' });
    slotMock.mockImplementationOnce(async () => { throw refusal; });
    const err = await xeroProvider.fetchRealmSettings(conn()).catch((e) => e);
    expect(err).toBe(refusal);
  });
});

describe('listSettingsOptions', () => {
  it('returns organisation, ACTIVE revenue accounts by code, ACTIVE bank accounts by id, revenue tax rates by TaxType', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Organisations: [{ Name: 'Demo Company (UK)', IsDemoCompany: true }] }))
      .mockResolvedValueOnce(json({ Accounts: [
        { AccountID: 'a-200', Code: '200', Name: 'Sales', Type: 'REVENUE', Status: 'ACTIVE' },
        { AccountID: 'a-201', Code: '201', Name: 'Old sales', Type: 'SALES', Status: 'ARCHIVED' },
        { AccountID: 'a-260', Code: '260', Name: 'Other Revenue', Type: 'SALES', Status: 'ACTIVE' },
        { AccountID: 'a-400', Code: '400', Name: 'Advertising', Type: 'EXPENSE', Status: 'ACTIVE' },
        { AccountID: 'bank-1', Name: 'Business Bank Account', Type: 'BANK', Status: 'ACTIVE', BankAccountNumber: '12-3456' },
        { AccountID: 'rev-nocode', Name: 'No code', Type: 'REVENUE', Status: 'ACTIVE' },
        { AccountID: 'a-270', Code: '270', Type: 'REVENUE', Status: 'ACTIVE' },
      ] }))
      .mockResolvedValueOnce(json({ TaxRates: [
        { Name: '20% (VAT on Income)', TaxType: 'OUTPUT2', Status: 'ACTIVE', CanApplyToRevenue: true, DisplayTaxRate: 20 },
        { Name: 'No VAT', TaxType: 'NONE', Status: 'ACTIVE', CanApplyToRevenue: true, DisplayTaxRate: 0 },
        { Name: '20% (VAT on Expenses)', TaxType: 'INPUT2', Status: 'ACTIVE', CanApplyToRevenue: false, DisplayTaxRate: 20 },
        { Name: 'Retired', TaxType: 'OLD', Status: 'DELETED', CanApplyToRevenue: true, DisplayTaxRate: 5 },
      ] }));
    await expect(xeroProvider.listSettingsOptions!(conn())).resolves.toEqual({
      organisation: { name: 'Demo Company (UK)', isDemoCompany: true },
      incomeAccounts: [
        { ref: '200', label: '200 · Sales', detail: 'REVENUE' },
        { ref: '260', label: '260 · Other Revenue', detail: 'SALES' },
        // A Code with no Name must not render a dangling separator ("270 ·").
        { ref: '270', label: '270', detail: 'REVENUE' },
      ],
      bankAccounts: [{ ref: 'bank-1', label: 'Business Bank Account', detail: '12-3456' }],
      taxRates: [
        { ref: 'OUTPUT2', label: '20% (VAT on Income)', detail: '20%' },
        { ref: 'NONE', label: 'No VAT', detail: '0%' },
      ],
    });
  });

  it('a null JSON body becomes a transient AccountingProviderError, not a TypeError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(null));
    await expect(xeroProvider.listSettingsOptions!(conn())).rejects.toMatchObject({ kind: 'transient', provider: 'xero' });
  });

  it('a non-array Accounts/TaxRates reads as an empty list rather than throwing', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Organisations: [{ Name: 'Demo Company (UK)' }] }))
      .mockResolvedValueOnce(json({ Accounts: 'x' }))
      .mockResolvedValueOnce(json({ TaxRates: 'x' }));
    await expect(xeroProvider.listSettingsOptions!(conn())).resolves.toEqual({
      organisation: { name: 'Demo Company (UK)', isDemoCompany: null },
      incomeAccounts: [],
      bankAccounts: [],
      taxRates: [],
    });
  });

  it('a 429 from the Organisation call propagates as rate_limited unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 429, headers: { 'Retry-After': '30' } }),
    );
    await expect(xeroProvider.listSettingsOptions!(conn())).rejects.toMatchObject({ kind: 'rate_limited', provider: 'xero' });
  });

  it('a limiter refusal from withProviderCallSlot propagates as the SAME error object', async () => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'Xero organisation read', throttleSource: 'local' });
    slotMock.mockImplementationOnce(async () => { throw refusal; });
    const err = await xeroProvider.listSettingsOptions!(conn()).catch((e) => e);
    expect(err).toBe(refusal);
  });
});

describe('tenantSelection', () => {
  it('scopes grant tenants to the auth event and removes a single link', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json([{ id: 'conn-A', authEventId: 'evt-00001', tenantId: 'ten-A', tenantType: 'ORGANISATION', tenantName: 'Alpha' }]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const ts = xeroProvider.tenantSelection!;
    expect(ts.connectableTenantType).toBe('ORGANISATION');
    await expect(ts.listGrantTenants('at', 'evt-00001')).resolves.toHaveLength(1);
    // The filter mode must actually reach the request URL — listGrantTenants
    // is scoped to the auth event, never the bare (all-tenants) endpoint.
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.xero.com/connections?authEventId=evt-00001');
    await ts.removeTenantConnection('at', 'conn-A');
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.xero.com/connections/conn-A');
  });

  it('listAllTenants hits the bare (unscoped) connections endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json([{ id: 'conn-A', tenantId: 'ten-A', tenantType: 'ORGANISATION', tenantName: 'Alpha' }]));
    const ts = xeroProvider.tenantSelection!;
    await expect(ts.listAllTenants('at')).resolves.toHaveLength(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.xero.com/connections');
  });
});

describe('releaseConnection (disconnect)', () => {
  it('DELETEs exactly the stored provider_connection_ref', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 204 }));
    await xeroProvider.releaseConnection!(conn());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.xero.com/connections/conn-A');
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('revoke');
  });
  it('does nothing without a stored ref', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await xeroProvider.releaseConnection!(conn({ providerConnectionRef: null }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('does nothing without an access token, even with a stored ref', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(xeroProvider.releaseConnection!(conn({ accessToken: null }))).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('contacts (Xero W03)', () => {
  it('listRemoteCustomers delegates with the connection tenant and query', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ pagination: { pageCount: 1 }, Contacts: [] }));
    await xeroProvider.listRemoteCustomers(conn(), 'ac');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/Contacts?page=1&pageSize=1000&includeArchived=true&searchTerm=ac');
    expect(init.headers).toMatchObject({ 'xero-tenant-id': 'ten-A', Authorization: 'Bearer at' });
  });
  it('declares getRemoteCustomer', () => {
    expect(typeof xeroProvider.getRemoteCustomer).toBe('function');
  });
  it('still declares only the connect capability through W03a', () => {
    expect(xeroProvider.capabilities).toMatchObject({ connect: true, mapping: false, customerImport: false });
  });
});

describe('methods behind later waves', () => {
  it.each([
    ['listRemoteItems', () => xeroProvider.listRemoteItems(conn())],
    ['listRemoteIncomeAccounts', () => xeroProvider.listRemoteIncomeAccounts(conn())],
    ['upsertItem', () => xeroProvider.upsertItem(conn(), {} as any, null)],
    ['pushInvoice', () => xeroProvider.pushInvoice(conn(), {} as any, [])],
    ['voidInvoice', () => xeroProvider.voidInvoice(conn(), {} as any, {} as any)],
    ['createPayment', () => xeroProvider.createPayment(conn(), {} as any)],
    ['deletePayment', () => xeroProvider.deletePayment(conn(), {} as any)],
    ['reconcileChanges', () => xeroProvider.reconcileChanges(conn(), null)],
  ])('%s refuses with capability_unavailable and makes no HTTP call', async (_name, call) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(call()).rejects.toMatchObject({ kind: 'validation', provider: 'xero', providerCode: 'capability_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paymentMarker throws until W05; verifyWebhook fails closed until W05', () => {
    expect(() => xeroProvider.paymentMarker.embed(null, 'm')).toThrow(/W05/);
    expect(xeroProvider.verifyWebhook('sig', '{}', 'key')).toBe(false);
  });
});
