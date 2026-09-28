import { createHmac } from 'node:crypto';
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
  it('declares connect, mapping and customerImport (Xero W03)', () => {
    expect(xeroProvider.provider).toBe('xero');
    expect(xeroProvider.displayName).toBe('Xero');
    expect(xeroProvider.capabilities).toEqual({
      connect: true, mapping: true, customerImport: true, invoicePush: false, paymentPull: false, paymentPush: false,
    });
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
      scope: 'offline_access accounting.contacts accounting.invoices accounting.payments accounting.settings',
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
});

describe('items and income accounts (Xero W03)', () => {
  it('upsertItem passes the connection tax defaults', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockResolvedValueOnce(json({ Items: [{ ItemID: 'xi-1', Code: 'fw-100-0000000000' }] }));
    await xeroProvider.upsertItem(conn({ defaultTaxCodeRef: 'OUTPUT2', defaultExemptTaxCodeRef: 'EXEMPTOUTPUT' }), {
      catalogItemId: '11111111-2222-4333-8444-555555555555', name: 'FW', sku: 'FW-100', description: null,
      type: 'Service', unitPrice: '10', currencyCode: 'GBP', taxable: false, active: true, incomeAccountRef: '200',
    }, null);
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string).Items[0].SalesDetails)
      .toEqual({ UnitPrice: 10, AccountCode: '200', TaxType: 'EXEMPTOUTPUT' });
  });
  it('getRemoteItem delegates to a single-item read', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Items: [{ ItemID: 'xi-1', Code: 'AV-1', Name: 'Antivirus' }] }));
    await expect(xeroProvider.getRemoteItem(conn(), 'xi-1')).resolves.toMatchObject({ id: 'xi-1', displayName: 'Antivirus', sku: 'AV-1' });
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe('https://api.xero.com/api.xro/2.0/Items/xi-1?unitdp=4');
  });
  it('listRemoteIncomeAccounts returns the same accounts the settings picker offers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Accounts: [
      { Code: '200', Name: 'Sales', Type: 'REVENUE', Status: 'ACTIVE' },
      { Code: '260', Name: 'Other Revenue', Type: 'SALES', Status: 'ACTIVE' },
      { Code: '090', Name: 'Bank', Type: 'BANK', Status: 'ACTIVE', AccountID: 'b1' },
      { Code: '201', Name: 'Old', Type: 'REVENUE', Status: 'ARCHIVED' },
      { Name: 'No code', Type: 'REVENUE', Status: 'ACTIVE' },
    ] }));
    await expect(xeroProvider.listRemoteIncomeAccounts(conn())).resolves.toEqual([
      { id: '200', displayName: '200 · Sales', accountType: 'REVENUE' },
      { id: '260', displayName: '260 · Other Revenue', accountType: 'SALES' },
    ]);
  });
  it('has no W03 method left behind a capability_unavailable refusal', async () => {
    // a fresh Response per call: a body reads once
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ Items: [], Contacts: [], Accounts: [] }));
    for (const call of [
      () => xeroProvider.listRemoteCustomers(conn()), () => xeroProvider.listRemoteItems(conn()),
      () => xeroProvider.listRemoteIncomeAccounts(conn()),
    ]) {
      await expect(call()).resolves.toBeDefined();
    }
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('payment push wiring (Xero W05b)', () => {
  it('declares a preflight that reads the bank account', () => {
    expect(xeroProvider.paymentPushPreflight!(conn({ defaultPaymentAccountRef: null }))).toMatch(/Choose a bank account/);
    expect(xeroProvider.paymentPushPreflight!(conn({ defaultPaymentAccountRef: 'bank-1' }))).toBeNull();
  });
  it('createPayment embeds the marker first in Reference', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Payments: [{ PaymentID: 'xp-1' }] }));
    await xeroProvider.createPayment(conn({ defaultPaymentAccountRef: 'bank-1' }), {
      invoicePaymentId: '0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f', remoteCustomerId: 'c', remoteInvoiceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      amount: '10.00', currencyCode: 'GBP', txnDate: '2026-09-02', reference: 'pi_1',
      marker: 'Breeze payment 0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f', pushGeneration: 0,
    });
    const sent = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(sent.Payments[0].Reference).toBe('Breeze payment 0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f | pi_1');
  });
  it('still declares paymentPush false until W05c', () => {
    expect(xeroProvider.capabilities.paymentPush).toBe(false);
  });
});

describe('payment pull wiring (Xero W05a)', () => {
  it('pins the reference cap and the marker grammar', () => {
    expect(xeroProvider.limits.paymentRefMax).toBe(64);
    const marker = 'Breeze payment 0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f';
    expect(xeroProvider.paymentMarker.extract(xeroProvider.paymentMarker.embed('pi_1', marker)))
      .toBe('0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f');
  });

  it("reconcileChanges reads with the connection's own tenant id and token", async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Invoices: [] }));
    await xeroProvider.reconcileChanges(conn({ realmId: 'tenant-A', accessToken: 'tok' }), null);
    const headers = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    expect(headers.get('xero-tenant-id')).toBe('tenant-A');
    expect(headers.get('authorization')).toBe('Bearer tok');
  });

  it('still declares paymentPull and paymentPush false until W05c', () => {
    expect(xeroProvider.capabilities.paymentPull).toBe(false);
    expect(xeroProvider.capabilities.paymentPush).toBe(false);
  });
});

describe('invoice push and void (Xero W04)', () => {
  const settings = { defaultIncomeAccountRef: '200', defaultTaxCodeRef: 'OUTPUT2', defaultExemptTaxCodeRef: 'EXEMPTOUTPUT' };
  const payload = {
    invoiceId: 'inv-1', docNumber: 'INV-1', txnDate: '2026-09-01', dueDate: null, customerRef: { id: 'xc-1' }, currencyCode: 'GBP',
    subtotal: '100.00', taxTotal: '20.00', total: '120.00', mapping: null,
    lines: [{ invoiceLineId: 'l1', description: 'Support', quantity: '1.00', unitPrice: '100.00', lineTotal: '100.00', taxable: true }],
  };

  it('pushInvoice runs the Xero flow against the connection\'s tenant', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [] }))
      .mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'xi-1', InvoiceNumber: 'INV-1', TotalTax: 20, Total: 120 }] }));
    const c = conn(settings);
    await expect(xeroProvider.pushInvoice(c, payload, [])).resolves.toMatchObject({ id: 'xi-1', remoteTotal: '120.00' });
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({ 'xero-tenant-id': c.realmId });
    }
  });

  it('voidInvoice reads, then voids by the mapping\'s remote id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'xi-1', Status: 'AUTHORISED' }] }))
      .mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'xi-1', Status: 'VOIDED' }] }));
    await xeroProvider.voidInvoice(conn(settings), { invoiceId: 'inv-1', docNumber: 'INV-1', currencyCode: 'GBP' }, { remoteEntityId: 'xi-1', remoteSyncToken: null });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4',
      'https://api.xero.com/api.xro/2.0/Invoices/xi-1?unitdp=4&summarizeErrors=true',
    ]);
  });

  it('invoicePushPreflight is the Xero pre-flight', () => {
    expect(xeroProvider.invoicePushPreflight(conn({ ...settings, defaultTaxCodeRef: null }), payload)).toEqual({
      reason: 'settings', message: 'Choose a tax rate for taxable lines in Integrations → Accounting → Xero, then push again',
    });
  });

  it('findRemoteInvoice looks the invoice up by its Breeze reference', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'xi-1', Type: 'ACCREC', Reference: 'breeze:inv-1', Status: 'AUTHORISED' }] }));
    await expect(xeroProvider.findRemoteInvoice(conn(settings), 'inv-1')).resolves.toEqual({ id: 'xi-1' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.xero.com/api.xro/2.0/Invoices?where=Reference%3D%3D%22breeze%3Ainv-1%22&unitdp=4');
  });

  it('still does not declare invoicePush through W04a', () => {
    expect(xeroProvider.capabilities.invoicePush).toBe(false);
  });
});

describe('verifyWebhook (Xero W05 refinement 2)', () => {
  const KEY = 'test-signing-key';
  const body = '{"events":[],"firstEventSequence":0,"lastEventSequence":0,"entropy":"ABC"}';
  const sign = (raw: string, key = KEY) => createHmac('sha256', key).update(raw, 'utf8').digest('base64');

  it('accepts base64(HMAC-SHA256(raw body, key))', () => {
    expect(xeroProvider.verifyWebhook(sign(body), body, KEY)).toBe(true);
  });
  it.each([
    ['a different key', () => sign(body, 'other')],
    ['a different body', () => sign(`${body} `)],
    ['a same-length wrong signature', () => sign(body).replace(/^./, (c) => (c === 'A' ? 'B' : 'A'))],
    ['a truncated signature', () => sign(body).slice(0, 10)],
    ['an empty signature', () => ''],
  ])('rejects %s', (_l, sig) => {
    expect(xeroProvider.verifyWebhook(sig(), body, KEY)).toBe(false);
  });
  it('rejects everything when no key is configured', () => {
    expect(xeroProvider.verifyWebhook(sign(body, ''), body, '')).toBe(false);
  });
});
