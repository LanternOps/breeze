import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'crypto';

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));
import {
  quickbooksProvider, mapQboCustomer, mapQboAddress, mapQboHomeCurrency, QBO_PREFERENCES_TIMEOUT_MS,
  QBO_CDC_CURSOR_SLACK_MS,
} from './quickbooksProvider';
import type { AccountingConnection } from './accountingConnectionService';

function conn(overrides: Partial<AccountingConnection> = {}): AccountingConnection {
  return {
    id: 'c1', partnerId: 'p1', provider: 'quickbooks',
    realmId: 'realm123', accessToken: 'tok', refreshToken: 'r',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    environment: 'sandbox', homeCurrency: 'USD', multiCurrencyEnabled: null,
    defaultIncomeAccountRef: null, defaultTaxCodeRef: null,
    pushMode: 'auto', status: 'connected',
    createdAt: null, updatedAt: null, lastError: null,
    realmIdFingerprint: null, pullPayments: true, lastReconcileAt: null, cdcCursor: null,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

// --- pushInvoice/voidInvoice fixture helpers -------------------------------

function line(overrides: Partial<{
  invoiceLineId: string; description: string; quantity: string;
  unitPrice: string; lineTotal: string; taxable: boolean;
}> = {}) {
  return {
    invoiceLineId: 'l1', description: 'Onsite support',
    quantity: '2.00', unitPrice: '50.00', lineTotal: '100.00', taxable: true,
    ...overrides,
  };
}

function invoicePayload(overrides: Partial<{
  invoiceId: string; docNumber: string | null; txnDate: string; dueDate: string | null;
  customerRef: { id: string }; currencyCode: string; subtotal: string; taxTotal: string;
  total: string; lines: ReturnType<typeof line>[];
  mapping: { remoteEntityId: string; remoteSyncToken: string | null } | null;
}> = {}) {
  return {
    invoiceId: 'inv-1', docNumber: 'INV-1', txnDate: '2026-09-01', dueDate: '2026-09-15',
    customerRef: { id: '55' }, currencyCode: 'USD',
    subtotal: '100.00', taxTotal: '7.00', total: '107.00',
    lines: [line()], mapping: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockFetchJsonOnce(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(body, status));
}

function lastFetchInit(fetchMock: ReturnType<typeof vi.spyOn>) {
  const calls = fetchMock.mock.calls as unknown as [unknown, RequestInit][];
  return calls[calls.length - 1]![1];
}

describe('mapQboAddress', () => {
  it('maps QBO address fields, including CountrySubDivisionCode -> region', () => {
    expect(mapQboAddress({
      Line1: '123 Main', Line2: 'Suite 4', City: 'Austin',
      CountrySubDivisionCode: 'TX', PostalCode: '78701', Country: 'US',
    })).toEqual({
      line1: '123 Main', line2: 'Suite 4', city: 'Austin',
      region: 'TX', postalCode: '78701', country: 'US',
    });
  });

  it('returns undefined when the address is empty/missing', () => {
    expect(mapQboAddress(undefined)).toBeUndefined();
    expect(mapQboAddress({})).toBeUndefined();
  });
});

describe('mapQboCustomer', () => {
  it('maps display name, company, email, phone, contact name, addresses, active', () => {
    const c = mapQboCustomer({
      Id: '42', DisplayName: 'Acme Co', CompanyName: 'Acme Inc',
      SyncToken: '3',
      PrimaryEmailAddr: { Address: 'ap@acme.test' },
      PrimaryPhone: { FreeFormNumber: '555-1212' },
      GivenName: 'Jane', FamilyName: 'Doe', Active: true,
      BillAddr: { Line1: '1 Bill St', City: 'Austin' },
      ShipAddr: { Line1: '2 Ship Rd', City: 'Dallas' },
    });
    expect(c).toMatchObject({
      id: '42', displayName: 'Acme Co', companyName: 'Acme Inc',
      syncToken: '3',
      email: 'ap@acme.test', phone: '555-1212', contactName: 'Jane Doe',
      active: true,
      billAddr: { line1: '1 Bill St', city: 'Austin' },
      shipAddr: { line1: '2 Ship Rd', city: 'Dallas' },
    });
  });

  it('falls back to CompanyName when DisplayName is missing, and tolerates missing optionals', () => {
    const c = mapQboCustomer({ Id: '7', CompanyName: 'Solo LLC' });
    expect(c.id).toBe('7');
    expect(c.displayName).toBe('Solo LLC');
    expect(c.email).toBeUndefined();
    expect(c.billAddr).toBeUndefined();
  });

  it('surfaces CurrencyRef.value as currencyCode (multi-currency §11)', () => {
    const c = mapQboCustomer({ Id: '42', DisplayName: 'Acme Co', CurrencyRef: { value: 'CAD' } });
    expect(c.currencyCode).toBe('CAD');
  });

  it('leaves currencyCode undefined when QBO omits CurrencyRef', () => {
    const c = mapQboCustomer({ Id: '42', DisplayName: 'Acme Co' });
    expect(c.currencyCode).toBeUndefined();
  });
});

describe('listRemoteItems', () => {
  it('pages Items and maps the fields needed for reconciliation', async () => {
    const page1 = { QueryResponse: { Item: Array.from({ length: 1000 }, (_, i) => ({
      Id: String(i), Name: `Item ${i}`, Sku: `SKU-${i}`, Type: 'Service',
      UnitPrice: 25, Active: true, SyncToken: '0',
    })) } };
    const page2 = { QueryResponse: { Item: [{
      Id: '1000', Name: 'Last Item', Type: 'NonInventory', UnitPrice: 50,
      Active: true, SyncToken: '4',
    }] } };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));

    const result = await quickbooksProvider.listRemoteItems(conn());

    expect(result).toHaveLength(1001);
    expect(result[0]).toEqual({
      id: '0', displayName: 'Item 0', sku: 'SKU-0', description: undefined,
      type: 'Service', unitPrice: 25, active: true, syncToken: '0',
    });
    expect(result[1000]).toMatchObject({ id: '1000', type: 'NonInventory', syncToken: '4' });
    expect(String(fetchMock.mock.calls[1]![0])).toContain('STARTPOSITION%201001');
  });
});

describe('listRemoteIncomeAccounts', () => {
  it('returns active QBO income accounts with stable IDs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      QueryResponse: { Account: [{
        Id: '79', Name: 'Services Income', AccountType: 'Income',
        AccountSubType: 'ServiceFeeIncome', Active: true,
      }] },
    }), { status: 200 }));

    await expect(quickbooksProvider.listRemoteIncomeAccounts(conn())).resolves.toEqual([{
      id: '79', displayName: 'Services Income', accountType: 'Income',
      accountSubType: 'ServiceFeeIncome',
    }]);
  });
});

describe('upsertCustomer', () => {
  it('creates a Customer without sparse-update fields', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      Customer: { Id: '12', SyncToken: '0' },
    }), { status: 200 }));

    const ref = await quickbooksProvider.upsertCustomer(conn(), {
      organizationId: 'org-1', displayName: 'Acme', companyName: 'Acme LLC',
      billingEmail: 'ap@acme.test', phone: '555-1212', taxId: 'TAX-1',
      billAddr: { line1: '1 Main', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' },
      currencyCode: 'USD',
    }, null);

    expect(ref).toEqual({ id: '12', syncToken: '0' });
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(JSON.parse(String(request.body))).toEqual({
      DisplayName: 'Acme',
      CompanyName: 'Acme LLC',
      PrimaryEmailAddr: { Address: 'ap@acme.test' },
      PrimaryPhone: { FreeFormNumber: '555-1212' },
      PrimaryTaxIdentifier: 'TAX-1',
      BillAddr: {
        Line1: '1 Main', City: 'Austin', CountrySubDivisionCode: 'TX',
        PostalCode: '78701', Country: 'US',
      },
    });
  });

  it('surfaces CurrencyRef.value as currencyCode on the CREATE response, symmetrically with listRemoteCustomers (multi-currency §11)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      Customer: { Id: '12', SyncToken: '0', CurrencyRef: { value: 'CAD' } },
    }), { status: 200 }));

    const ref = await quickbooksProvider.upsertCustomer(conn(), {
      organizationId: 'org-1', displayName: 'Acme',
      billingEmail: null, taxId: null, currencyCode: 'CAD',
    }, null);

    expect(ref).toEqual({ id: '12', syncToken: '0', currencyCode: 'CAD' });
  });

  it('sparse-updates a Customer with its current Id and SyncToken', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      Customer: { Id: '12', SyncToken: '8' },
    }), { status: 200 }));

    await quickbooksProvider.upsertCustomer(conn(), {
      organizationId: 'org-1', displayName: 'Acme LLC',
      billingEmail: null, taxId: null, currencyCode: 'USD',
    }, { remoteEntityId: '12', remoteSyncToken: '7' });

    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      sparse: true, Id: '12', SyncToken: '7', DisplayName: 'Acme LLC',
    });
  });
});

describe('upsertItem', () => {
  const input = {
    catalogItemId: 'ci-1', name: 'Managed Service', sku: 'MS-1',
    description: 'Monthly management', type: 'Service' as const,
    unitPrice: '125.50', currencyCode: 'USD', taxable: true,
    incomeAccountRef: '79', active: true,
  };

  it('creates an Item with the configured income account, converting the decimal-string price', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      Item: { Id: '9', SyncToken: '0' },
    }), { status: 200 }));

    await expect(quickbooksProvider.upsertItem(conn(), input, null)).resolves.toEqual({ id: '9', syncToken: '0' });
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      Name: 'Managed Service', Sku: 'MS-1', Description: 'Monthly management',
      Type: 'Service', UnitPrice: 125.5, Taxable: true, Active: true,
      IncomeAccountRef: { value: '79' },
    });
  });

  it('refuses an update that is missing the current SyncToken', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(quickbooksProvider.upsertItem(conn(), input, { remoteEntityId: '9', remoteSyncToken: null }))
      .rejects.toThrow(/SyncToken/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses creation without an income account before any HTTP call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(quickbooksProvider.upsertItem(conn(), { ...input, incomeAccountRef: undefined }, null))
      .rejects.toThrow(/income account/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('pushInvoice', () => {
  const taxConn = conn({ defaultTaxCodeRef: 'TXC1' });

  it('POSTs a create body with DocNumber, CustomerRef, per-line SalesItemLineDetail and TxnTaxDetail override', async () => {
    const fetchMock = mockFetchJsonOnce({
      Invoice: { Id: '310', SyncToken: '0', DocNumber: 'INV-2026-0042', TotalAmt: 107.0, TxnTaxDetail: { TotalTax: 7.0 } },
    });

    const result = await quickbooksProvider.pushInvoice(taxConn, invoicePayload({
      docNumber: 'INV-2026-0042', subtotal: '100.00', taxTotal: '7.00', total: '107.00',
      customerRef: { id: '55' },
      lines: [line({ description: 'Onsite support', quantity: '2.00', unitPrice: '50.00', lineTotal: '100.00', taxable: true })],
    }), [{ invoiceLineId: 'l1', remoteItemRef: { id: '77' } }]);

    const body = JSON.parse(String(lastFetchInit(fetchMock).body));
    expect(body.DocNumber).toBe('INV-2026-0042');
    expect(body.CustomerRef).toEqual({ value: '55' });
    expect(body.Line[0]).toMatchObject({
      DetailType: 'SalesItemLineDetail', Amount: 100, Description: 'Onsite support',
      SalesItemLineDetail: { ItemRef: { value: '77' }, Qty: 2, UnitPrice: 50, TaxCodeRef: { value: 'TAX' } },
    });
    expect(body.TxnTaxDetail).toEqual({ TxnTaxCodeRef: { value: taxConn.defaultTaxCodeRef }, TotalTax: 7 });
    expect(result).toEqual({ id: '310', syncToken: '0', docNumber: 'INV-2026-0042', remoteTaxTotal: '7', remoteTotal: '107' });
  });

  it('omits ItemRef for an unmapped line and sets TaxCodeRef NON when not taxable', async () => {
    const fetchMock = mockFetchJsonOnce({ Invoice: { Id: '310', SyncToken: '0' } });

    await quickbooksProvider.pushInvoice(taxConn, invoicePayload({
      lines: [line({ invoiceLineId: 'l1', taxable: false })],
    }), []); // no mapping for l1 at all

    const body = JSON.parse(String(lastFetchInit(fetchMock).body));
    expect(body.Line[0].SalesItemLineDetail).not.toHaveProperty('ItemRef');
    expect(body.Line[0].SalesItemLineDetail).toMatchObject({ TaxCodeRef: { value: 'NON' } });
  });

  it('pushes a contract base line and its overage sibling, the overage with no ItemRef (#3205 W04)', async () => {
    const fetchMock = mockFetchJsonOnce({ Invoice: { Id: '311', SyncToken: '0' } });

    await quickbooksProvider.pushInvoice(taxConn, invoicePayload({
      subtotal: '262.00', taxTotal: '26.20', total: '288.20',
      lines: [
        line({ invoiceLineId: 'base', description: 'Endpoints', quantity: '25.00', unitPrice: '10.00', lineTotal: '250.00', taxable: true }),
        line({ invoiceLineId: 'over', description: 'Overage: 1 above 25 included — Endpoints', quantity: '1.00', unitPrice: '12.00', lineTotal: '12.00', taxable: true }),
      ],
    }), [{ invoiceLineId: 'base', remoteItemRef: { id: '77' } }]); // the overage is never catalog-linked

    const body = JSON.parse(String(lastFetchInit(fetchMock).body));
    expect(body.Line).toHaveLength(2);
    expect(body.Line[0].SalesItemLineDetail).toMatchObject({ ItemRef: { value: '77' }, Qty: 25, UnitPrice: 10, TaxCodeRef: { value: 'TAX' } });
    expect(body.Line[1]).toMatchObject({ Amount: 12, Description: 'Overage: 1 above 25 included — Endpoints' });
    expect(body.Line[1].SalesItemLineDetail).not.toHaveProperty('ItemRef');
    expect(body.Line[1].SalesItemLineDetail).toMatchObject({ Qty: 1, UnitPrice: 12, TaxCodeRef: { value: 'TAX' } });
  });

  it('sends sparse update with Id + SyncToken when a mapping is provided, and throws without a sync token', async () => {
    const fetchMock = mockFetchJsonOnce({ Invoice: { Id: '310', SyncToken: '4' } });

    await quickbooksProvider.pushInvoice(taxConn, invoicePayload({
      mapping: { remoteEntityId: '310', remoteSyncToken: '3' },
    }), [{ invoiceLineId: 'l1', remoteItemRef: { id: '77' } }]);

    const body = JSON.parse(String(lastFetchInit(fetchMock).body));
    expect(body).toMatchObject({ sparse: true, Id: '310', SyncToken: '3' });

    fetchMock.mockClear();
    await expect(quickbooksProvider.pushInvoice(taxConn, invoicePayload({
      mapping: { remoteEntityId: '310', remoteSyncToken: null },
    }), [])).rejects.toThrow('QuickBooks Invoice update requires the current SyncToken');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits TxnTaxDetail entirely when the connection has no defaultTaxCodeRef', async () => {
    const fetchMock = mockFetchJsonOnce({ Invoice: { Id: '310', SyncToken: '0' } });

    await quickbooksProvider.pushInvoice(conn({ defaultTaxCodeRef: null }), invoicePayload(), [
      { invoiceLineId: 'l1', remoteItemRef: { id: '77' } },
    ]);

    const body = JSON.parse(String(lastFetchInit(fetchMock).body));
    expect(body).not.toHaveProperty('TxnTaxDetail');
  });

  it('retries once WITHOUT DocNumber on a 400 Duplicate Document Number fault and returns QBO’s assigned DocNumber', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ Fault: { Error: [{ Message: 'Duplicate Document Number Error' }] } }), { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ Invoice: { Id: '311', SyncToken: '0', DocNumber: 'INV-9001' } }));

    const result = await quickbooksProvider.pushInvoice(taxConn, invoicePayload({ docNumber: 'INV-2026-0042' }), [
      { invoiceLineId: 'l1', remoteItemRef: { id: '77' } },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(firstBody.DocNumber).toBe('INV-2026-0042');
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(secondBody).not.toHaveProperty('DocNumber');
    expect(result.docNumber).toBe('INV-9001');
  });

  // Review finding 4 (Phase C Task 3 fix round): a network-level retry of a
  // create that actually landed must not mint a second QuickBooks invoice.
  it('stamps a CREATE request with a &requestid derived from the Breeze invoice id, stable across the DocNumber retry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ Fault: { Error: [{ Message: 'Duplicate Document Number Error' }] } }), { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ Invoice: { Id: '311', SyncToken: '0', DocNumber: 'INV-9001' } }));

    await quickbooksProvider.pushInvoice(taxConn, invoicePayload({ invoiceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', docNumber: 'INV-2026-0042' }), [
      { invoiceLineId: 'l1', remoteItemRef: { id: '77' } },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = String(fetchMock.mock.calls[0]![0]);
    const secondUrl = String(fetchMock.mock.calls[1]![0]);
    expect(firstUrl).toContain('requestid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    // Same key on the DocNumber-stripped retry — it's the same logical create.
    expect(secondUrl).toContain('requestid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('omits requestid entirely on a sparse UPDATE (an existing Id + SyncToken is already idempotent)', async () => {
    const fetchMock = mockFetchJsonOnce({ Invoice: { Id: '310', SyncToken: '4' } });

    await quickbooksProvider.pushInvoice(taxConn, invoicePayload({
      invoiceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      mapping: { remoteEntityId: '310', remoteSyncToken: '3' },
    }), [{ invoiceLineId: 'l1', remoteItemRef: { id: '77' } }]);

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).not.toContain('requestid');
  });

  it('throws with attached status/body (sliced) on non-ok, and never sends CurrencyRef', async () => {
    const fetchMock = mockFetchJsonOnce({ Fault: { Error: [{ Message: 'Business Validation Error' }] } }, 500);

    const err = await quickbooksProvider.pushInvoice(taxConn, invoicePayload({ currencyCode: 'EUR' }), [
      { invoiceLineId: 'l1', remoteItemRef: { id: '77' } },
    ]).then(
      () => { throw new Error('expected pushInvoice to reject on a non-2xx'); },
      (e: Error & { status?: number; body?: string }) => e,
    );

    expect(err.status).toBe(500);
    expect(err.body).toContain('Business Validation Error');
    const body = JSON.parse(String(lastFetchInit(fetchMock).body));
    expect(body).not.toHaveProperty('CurrencyRef');
  });
});

describe('voidInvoice', () => {
  function voidPayload(overrides: Partial<{ invoiceId: string; docNumber: string | null; currencyCode: string }> = {}) {
    return { invoiceId: 'inv-1', docNumber: 'INV-1', currencyCode: 'USD', ...overrides };
  }

  it('POSTs invoice?operation=void with Id + SyncToken from the mapping', async () => {
    const fetchMock = mockFetchJsonOnce({ Invoice: { Id: '310', SyncToken: '5', status: 'Voided' } });

    await quickbooksProvider.voidInvoice(conn(), voidPayload(), { remoteEntityId: '310', remoteSyncToken: '4' });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('invoice?operation=void&minorversion=70');
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body).toEqual({ Id: '310', SyncToken: '4' });
  });

  it('throws when the mapping has no remoteSyncToken', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await expect(quickbooksProvider.voidInvoice(conn(), voidPayload(), { remoteEntityId: '310', remoteSyncToken: null }))
      .rejects.toThrow(/SyncToken/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listRemoteCustomers', () => {
  it('pages through the QBO query API until a short page is returned', async () => {
    const page1 = { QueryResponse: { Customer: Array.from({ length: 1000 }, (_, i) => ({ Id: String(i), DisplayName: `C${i}` })) } };
    const page2 = { QueryResponse: { Customer: [{ Id: '1000', DisplayName: 'last', CurrencyRef: { value: 'CAD' } }] } };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));

    const result = await quickbooksProvider.listRemoteCustomers(conn());

    expect(result).toHaveLength(1001);
    expect(result[1000]).toMatchObject({ id: '1000', currencyCode: 'CAD' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = String(fetchMock.mock.calls[0]![0]);
    expect(firstUrl).toContain('sandbox-quickbooks.api.intuit.com');
    expect(firstUrl).toContain('STARTPOSITION%201'); // url-encoded space
    const secondUrl = String(fetchMock.mock.calls[1]![0]);
    expect(secondUrl).toContain('STARTPOSITION%201001');
  });

  it('uses the production base URL when environment is production', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ QueryResponse: {} }), { status: 200 }));
    await quickbooksProvider.listRemoteCustomers(conn({ environment: 'production' }));
    expect(String(fetchMock.mock.calls[0]![0])).toContain('https://quickbooks.api.intuit.com');
  });

  it('throws when the QBO API returns a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await expect(quickbooksProvider.listRemoteCustomers(conn())).rejects.toThrow(/QuickBooks customer query failed/);
  });

  it('throws when the connection has no realmId or access token', async () => {
    await expect(quickbooksProvider.listRemoteCustomers(conn({ realmId: null }))).rejects.toThrow(/realm/i);
    await expect(quickbooksProvider.listRemoteCustomers(conn({ accessToken: null }))).rejects.toThrow(/access token/i);
  });
});

// Pre-existing OAuth + webhook coverage from QuickBooks Phase A (#1849), retained
// here (adapted to the spyOn + restoreAllMocks style) so this task does not delete it.
describe('QuickbooksProvider OAuth + webhook', () => {
  it('buildAuthUrl embeds state, scope, redirect_uri', () => {
    const url = quickbooksProvider.buildAuthUrl('state-abc');
    expect(url).toContain('com.intuit.quickbooks.accounting');
    expect(url).toContain('state=state-abc');
    expect(url).toContain('response_type=code');
    expect(url).toContain('redirect_uri=');
  });

  it('refresh returns the ROTATED refresh token, not the input', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: 'new-at',
      refresh_token: 'ROTATED-rt',
      expires_in: 3600,
      x_refresh_token_expires_in: 8640000,
    }), { status: 200 }));

    const tokens = await quickbooksProvider.refresh('old-rt');
    expect(tokens.refreshToken).toBe('ROTATED-rt');
    expect(tokens.accessToken).toBe('new-at');
    expect(tokens.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('exchangeCode posts grant_type=authorization_code and parses expiry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      x_refresh_token_expires_in: 8640000,
    }), { status: 200 }));

    const tokens = await quickbooksProvider.exchangeCode('the-code', 'realm-9');
    expect(tokens.realmId).toBe('realm-9');
    const body = String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? '');
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=the-code');
  });

  it('verifies webhook signatures with HMAC-SHA256', () => {
    const body = '{"eventNotifications":[]}';
    const signature = createHmac('sha256', 'verifier-token').update(body).digest('base64');
    expect(quickbooksProvider.verifyWebhook(signature, body, 'verifier-token')).toBe(true);
    expect(quickbooksProvider.verifyWebhook(signature, body, 'wrong-token')).toBe(false);
  });
});

describe('mapQboHomeCurrency', () => {
  it('reads Preferences.CurrencyPrefs.HomeCurrency.value and normalizes it', () => {
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: ' cad ' } } } })).toBe('CAD');
  });

  it('returns null when any level is missing', () => {
    expect(mapQboHomeCurrency({})).toBeNull();
    expect(mapQboHomeCurrency({ Preferences: {} })).toBeNull();
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: {} } })).toBeNull();
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: null } } })).toBeNull();
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: null } } } })).toBeNull();
  });

  it('returns null for a non three-letter value rather than persisting junk', () => {
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: 'DOLLARS' } } } })).toBeNull();
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: '' } } } })).toBeNull();
  });

  it('accepts a code OUTSIDE Breeze supported currencies — it is an external fact', () => {
    expect(mapQboHomeCurrency({ Preferences: { CurrencyPrefs: { HomeCurrency: { value: 'BHD' } } } })).toBe('BHD');
  });
});

describe('fetchRealmSettings', () => {
  const prefsBody = { Preferences: { CurrencyPrefs: { HomeCurrency: { value: 'CAD' }, MultiCurrencyEnabled: true } } };

  it('calls the sandbox preferences endpoint with minorversion 70 and a bearer token, returning homeCurrency + multiCurrencyEnabled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(prefsBody), { status: 200 }));

    await expect(quickbooksProvider.fetchRealmSettings(conn())).resolves.toEqual({ homeCurrency: 'CAD', multiCurrencyEnabled: true });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('sandbox-quickbooks.api.intuit.com');
    expect(url).toContain('/v3/company/realm123/preferences');
    expect(url).toContain('minorversion=70');
    expect(url).not.toContain('companyinfo');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('uses the production host for a production connection', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(prefsBody), { status: 200 }));

    await quickbooksProvider.fetchRealmSettings(conn({ environment: 'production' }));

    expect(String(fetchMock.mock.calls[0]![0])).toContain('https://quickbooks.api.intuit.com');
  });

  it('returns null/null when QBO omits CurrencyPrefs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ Preferences: {} }), { status: 200 }));

    await expect(quickbooksProvider.fetchRealmSettings(conn())).resolves.toEqual({ homeCurrency: null, multiCurrencyEnabled: null });
  });

  it('coerces a non-boolean MultiCurrencyEnabled to null rather than persisting junk', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      Preferences: { CurrencyPrefs: { HomeCurrency: { value: 'USD' }, MultiCurrencyEnabled: 'true' } },
    }), { status: 200 }));

    await expect(quickbooksProvider.fetchRealmSettings(conn())).resolves.toEqual({ homeCurrency: 'USD', multiCurrencyEnabled: null });
  });

  it('throws a SANITIZED typed error on a non-2xx — status and operation only, never the QBO body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ Fault: { Error: [{ Detail: 'realm 4620816365 customer Acme Ltd' }] } }), { status: 403 }),
    );

    // `.then(onFulfilled, onRejected)` rather than `.catch`: it narrows the type to
    // the error (a bare `.catch` widens to `string | null | Error`) AND fails loudly
    // if the call ever resolves instead of throwing.
    const err = await quickbooksProvider.fetchRealmSettings(conn()).then(
      () => { throw new Error('expected fetchRealmSettings to reject on a non-2xx'); },
      (e: Error & { status?: number; operation?: string; body?: string }) => e,
    );

    expect(err.status).toBe(403);
    expect(err.operation).toBe('fetchRealmSettings');
    // This error is handed to captureException by the OAuth callback, so it must
    // carry no provider payload, no realm id and no token.
    expect(err.body).toBeUndefined();
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain('Acme Ltd');
    expect(err.message).not.toContain('realm123');
    expect(err.message).not.toContain('tok');
  });

  it('rejects when the connection lacks a realmId or an access token', async () => {
    await expect(quickbooksProvider.fetchRealmSettings(conn({ realmId: null }))).rejects.toThrow(/realmId/);
    await expect(quickbooksProvider.fetchRealmSettings(conn({ accessToken: null }))).rejects.toThrow(/access token/);
  });

  it('throws the SAME sanitized error when a 200 is not JSON — the body never reaches telemetry', async () => {
    // Intuit endpoints sit behind proxies/WAFs that can answer 200 with an HTML
    // page. An unguarded response.json() would throw a SyntaxError whose message
    // embeds a snippet of that body, and the OAuth callback hands the error
    // straight to captureException — defeating the non-2xx sanitization.
    const html = '<html><body>Blocked: realm 4620816365 customer Acme Ltd</body></html>';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );

    const err = await quickbooksProvider.fetchRealmSettings(conn()).then(
      () => { throw new Error('expected fetchRealmSettings to reject on a non-JSON 200'); },
      (e: Error & { status?: number; operation?: string; body?: string }) => e,
    );

    expect(err.status).toBe(200);
    expect(err.operation).toBe('fetchRealmSettings');
    expect(err.body).toBeUndefined();
    const serialized = JSON.stringify({ ...err, message: err.message });
    expect(serialized).not.toContain('Acme Ltd');
    expect(serialized).not.toContain('4620816365');
    expect(serialized).not.toContain('<html>');
    expect(err).not.toBeInstanceOf(SyntaxError);
  });

  it('does not leave the error-path response body unconsumed (undici holds the connection until GC)', async () => {
    const response = new Response(JSON.stringify({ Fault: {} }), { status: 403 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response);

    await expect(quickbooksProvider.fetchRealmSettings(conn())).rejects.toThrow();

    // cancel() (or a read) disturbs the stream; an untouched body leaves this false.
    expect(response.bodyUsed).toBe(true);
  });

  it('passes an abort signal so a hung Intuit cannot stall the OAuth callback', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(prefsBody), { status: 200 }));

    await quickbooksProvider.fetchRealmSettings(conn());

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the preferences request well inside undici\'s ~300s headers timeout', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal!.addEventListener('abort', () =>
            reject((init as RequestInit).signal!.reason));
        }),
      );

      const pending = quickbooksProvider.fetchRealmSettings(conn());
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(QBO_PREFERENCES_TIMEOUT_MS + 1);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(QBO_PREFERENCES_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- reconcileChanges (CDC) fixture helpers --------------------------------

function cdcResponse(entityBlocks: Record<string, unknown>[], time = '2026-09-02T20:10:00.000Z') {
  return { CDCResponse: [{ QueryResponse: entityBlocks }], time };
}

function qboPayment(overrides: Record<string, unknown> = {}) {
  return {
    Id: '180', SyncToken: '0', TxnDate: '2026-09-02', TotalAmt: 150.0,
    CurrencyRef: { value: 'USD', name: 'United States Dollar' },
    CustomerRef: { value: '58' },
    PaymentMethodRef: { value: '2', name: 'Check' },
    PaymentRefNum: '10441',
    Line: [{ Amount: 150.0, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] }],
    MetaData: { CreateTime: '2026-09-02T20:04:34-07:00', LastUpdatedTime: '2026-09-02T20:04:34-07:00' },
    ...overrides,
  };
}

describe('reconcileChanges (CDC)', () => {
  it('requests entities=Payment,Invoice with changedSince 5 minutes behind the cursor', async () => {
    const spy = mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment()], startPosition: 1, maxResults: 1, totalCount: 1 }]));
    const since = new Date('2026-09-02T20:00:00.000Z');
    await quickbooksProvider.reconcileChanges(conn(), since);
    const url = String(spy.mock.calls[0]![0]);
    expect(url).toContain('/cdc?entities=Payment%2CInvoice');
    expect(url).toContain(`changedSince=${encodeURIComponent('2026-09-02T19:55:00.000Z')}`);
    expect(url).toContain('minorversion=70');
  });

  it('floors a null cursor at 30 days and never earlier than the connection createdAt', async () => {
    mockFetchJsonOnce(cdcResponse([]));
    const created = new Date(Date.now() - 5 * 24 * 3600_000);
    const spy = vi.mocked(globalThis.fetch);
    await quickbooksProvider.reconcileChanges(conn({ createdAt: created }), null);
    expect(String(spy.mock.calls[0]![0])).toContain(encodeURIComponent(new Date(created.getTime() - QBO_CDC_CURSOR_SLACK_MS).toISOString()));
  });

  it('emits one payment line per Invoice-linked Line, in minor units', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment()] }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.payments).toEqual([{
      remoteInvoiceId: '145', remotePaymentId: '180', amountMinor: 15000, currency: 'USD',
      txnDate: '2026-09-02', remotePaymentSyncToken: '0', paymentMethodName: 'Check', paymentRefNum: '10441',
    }]);
  });

  it('splits one Payment applied across two invoices into two lines', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment({
      TotalAmt: 250.0,
      Line: [
        { Amount: 100.0, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] },
        { Amount: 150.0, LinkedTxn: [{ TxnId: '146', TxnType: 'Invoice' }] },
      ],
    })] }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.payments.map((p) => [p.remoteInvoiceId, p.amountMinor])).toEqual([['145', 10000], ['146', 15000]]);
  });

  it('ignores non-Invoice LinkedTxn lines (deposits, credit applications)', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment({
      Line: [{ Amount: 150.0, LinkedTxn: [{ TxnId: '9', TxnType: 'CreditMemo' }] }],
    })] }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.payments).toEqual([]);
    // No Invoice-linked line means nothing for the applier to reconcile against
    // — same "deletion candidate" bucket as a voided payment (brief step 3).
    expect(cs.deletedPayments).toEqual(['180']);
  });

  it('treats a voided payment (TotalAmt 0, no lines) as a deletion, not a zero payment', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment({ TotalAmt: 0, Line: [] })] }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.payments).toEqual([]);
    expect(cs.deletedPayments).toEqual(['180']);
  });

  it('collects status:"Deleted" Payment and Invoice entities into the deletion lists', async () => {
    mockFetchJsonOnce(cdcResponse([
      { Payment: [{ Id: '181', status: 'Deleted', domain: 'QBO', MetaData: { LastUpdatedTime: '2026-09-02T20:06:00-07:00' } }] },
      { Invoice: [{ Id: '145', status: 'Deleted', domain: 'QBO', MetaData: { LastUpdatedTime: '2026-09-02T20:07:00-07:00' } }] },
    ]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.deletedPayments).toEqual(['181']);
    expect(cs.deletedInvoices).toEqual(['145']);
  });

  it('treats a zero-balance Invoice with a "Voided" PrivateNote as a deletion (QBO does not mark it status:"Deleted")', async () => {
    mockFetchJsonOnce(cdcResponse([{ Invoice: [{
      Id: '146', TotalAmt: 0, Balance: 0, PrivateNote: 'Voided on 2026-09-02',
      MetaData: { LastUpdatedTime: '2026-09-02T20:08:00-07:00' },
    }] }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.deletedInvoices).toEqual(['146']);
  });

  it('does NOT treat a normal zero-balance-but-not-voided Invoice as deleted', async () => {
    mockFetchJsonOnce(cdcResponse([{ Invoice: [{
      Id: '147', TotalAmt: 0, Balance: 0,
      MetaData: { LastUpdatedTime: '2026-09-02T20:09:00-07:00' },
    }] }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.deletedInvoices).toEqual([]);
  });

  // --- overflow: /query backfill (final-review finding A) -------------------
  //
  // QBO's /cdc takes only `changedSince`, so the pre-review window-halving
  // re-issued a BYTE-IDENTICAL request and could never resolve an overflow.
  // The overflowing entity is now paged through /query instead.

  it('pages the overflowing entity through /query instead of re-issuing the identical CDC request', async () => {
    const since = new Date('2026-09-02T20:00:00.000Z');
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(
        cdcResponse([{ Payment: [qboPayment()], startPosition: 1, maxResults: 1, totalCount: 2 }]),
      ))
      .mockResolvedValueOnce(jsonResponse({
        QueryResponse: { Payment: [qboPayment(), qboPayment({ Id: '182' })] },
        time: '2026-09-02T20:11:00.000Z',
      }));

    const cs = await quickbooksProvider.reconcileChanges(conn(), since);

    expect(spy).toHaveBeenCalledTimes(2);
    const queryUrl = decodeURIComponent(String(spy.mock.calls[1]![0]));
    expect(queryUrl).toContain('/query?query=');
    expect(queryUrl).toContain(
      "select * from Payment where MetaData.LastUpdatedTime >= '2026-09-02T19:55:00.000Z'"
      + ' orderby MetaData.LastUpdatedTime startposition 1 maxresults 1000',
    );
    expect(cs.payments.map((p) => p.remotePaymentId).sort()).toEqual(['180', '182']);
    expect(cs.overflowed).toBe(false);
  });

  it('keeps paging /query until a short page, and de-duplicates against the CDC rows by Id', async () => {
    const fullPage = Array.from({ length: 1000 }, (_, i) => qboPayment({ Id: String(2000 + i) }));
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(
        cdcResponse([{ Payment: [qboPayment()], startPosition: 1, maxResults: 1, totalCount: 1500 }]),
      ))
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Payment: fullPage } }))
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Payment: [qboPayment()] } }));

    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date('2026-09-02T20:00:00.000Z'));

    expect(spy).toHaveBeenCalledTimes(3);
    expect(decodeURIComponent(String(spy.mock.calls[2]![0]))).toContain('startposition 1001');
    // 1000 query rows + payment 180 exactly once (query row wins over the CDC row).
    expect(cs.payments).toHaveLength(1001);
    expect(cs.payments.filter((p) => p.remotePaymentId === '180')).toHaveLength(1);
    expect(cs.overflowed).toBe(false);
  });

  it('reports overflowed:true when the /query backfill itself fails, keeping the CDC rows', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('unexpected extra fetch() call — this test only mocks 2 responses');
    });
    spy
      .mockResolvedValueOnce(jsonResponse(
        cdcResponse([{ Payment: [qboPayment()], startPosition: 1, maxResults: 1, totalCount: 2 }]),
      ))
      .mockResolvedValueOnce(jsonResponse({ Fault: { Error: [{ Detail: 'realm secrets' }] } }, 500));

    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date('2026-09-02T20:00:00.000Z'));

    expect(cs.overflowed).toBe(true);
    expect(cs.payments.map((p) => p.remotePaymentId)).toEqual(['180']);
  });

  it('backfills an overflowing Invoice block through /query and keeps the CDC deletion lists', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(cdcResponse([{
        Invoice: [{ Id: '145', status: 'Deleted' }],
        startPosition: 1, maxResults: 1, totalCount: 2,
      }])))
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Invoice: [
        { Id: '146', TotalAmt: 0, Balance: 0, PrivateNote: 'Voided on 2026-09-02' },
        { Id: '147', TotalAmt: 90, Balance: 90 },
      ] } }));

    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date('2026-09-02T20:00:00.000Z'));

    expect(decodeURIComponent(String(spy.mock.calls[1]![0]))).toContain('select * from Invoice where');
    // The CDC deletion survives: /query never returns deleted entities.
    expect(cs.deletedInvoices.sort()).toEqual(['145', '146']);
    expect(cs.overflowed).toBe(false);
  });

  // --- stale cursor past the 30-day floor (finding H) ----------------------

  it('warns and captures ONCE when the stored cursor is older than the 30-day CDC floor', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    captureExceptionMock.mockClear();
    mockFetchJsonOnce(cdcResponse([]));
    const ancient = new Date(Date.now() - 45 * 24 * 3600_000);

    await quickbooksProvider.reconcileChanges(conn(), ancient);

    // The floor SILENTLY moved the window forward — everything between the
    // stored cursor and the floor is unreadable and will never be swept.
    expect(warnSpy).toHaveBeenCalled();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect(String(captureExceptionMock.mock.calls[0]![0])).toMatch(/30-day/);
    warnSpy.mockRestore();
  });

  it('says nothing when the stored cursor is inside the lookback window', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    captureExceptionMock.mockClear();
    mockFetchJsonOnce(cdcResponse([]));

    await quickbooksProvider.reconcileChanges(conn(), new Date(Date.now() - 2 * 3600_000));

    expect(warnSpy).not.toHaveBeenCalled();
    expect(captureExceptionMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('says nothing on a FIRST run (null cursor is not a skipped range)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    captureExceptionMock.mockClear();
    mockFetchJsonOnce(cdcResponse([]));

    await quickbooksProvider.reconcileChanges(conn(), null);

    expect(captureExceptionMock).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('leaves overflowed false on an ordinary, non-truncated window', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment()], startPosition: 1, maxResults: 1, totalCount: 1 }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.overflowed).toBe(false);
  });

  it('never leaks a raw QBO fault body on failure', async () => {
    const faultBody = { Fault: { Error: [{ Detail: 'realm secrets' }] } };
    // Two reconcileChanges() calls below == two fetch() calls. A base
    // mockImplementation that throws (rather than falling through to the real
    // `fetch`) turns any THIRD, unmocked call into a loud test failure instead
    // of a silent outbound request to sandbox-quickbooks.api.intuit.com.
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('unexpected extra fetch() call — this test only mocks 2 responses');
    });
    spy
      .mockResolvedValueOnce(jsonResponse(faultBody, 500))
      .mockResolvedValueOnce(jsonResponse(faultBody, 500));

    await expect(quickbooksProvider.reconcileChanges(conn(), new Date())).rejects.toThrow(/QuickBooks change data capture failed with 500/);
    await expect(quickbooksProvider.reconcileChanges(conn(), new Date())).rejects.not.toThrow(/realm secrets/);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('uses the CDC response\'s server time as the cursor when present (spec: "the response\'s server time, not ours")', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment()] }], '2026-09-02T20:10:00.000Z'));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.cursor).toEqual(new Date('2026-09-02T20:10:00.000Z'));
  });

  it('falls back to the local clock when the CDC response omits or fails to parse `time`', async () => {
    vi.useFakeTimers();
    try {
      const fixedNow = new Date('2026-09-02T21:00:00.000Z');
      vi.setSystemTime(fixedNow);
      mockFetchJsonOnce({ CDCResponse: [{ QueryResponse: [{ Payment: [qboPayment()] }] }] }); // no top-level `time`
      const cs = await quickbooksProvider.reconcileChanges(conn(), new Date(fixedNow.getTime() - 3600_000));
      expect(cs.cursor).toEqual(fixedNow);
    } finally {
      vi.useRealTimers();
    }
  });
});
