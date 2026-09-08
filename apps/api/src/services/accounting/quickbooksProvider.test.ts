import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'crypto';

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));
import {
  quickbooksProvider, mapQboCustomer, mapQboAddress, mapQboHomeCurrency, mapQboCdcPayment, QBO_PREFERENCES_TIMEOUT_MS,
  QBO_CDC_CURSOR_SLACK_MS,
} from './quickbooksProvider';
import type { AccountingConnection } from './accountingConnectionService';
import type { AccountingPaymentPayload } from './types';
import { isQboPaymentLinkedRefusal } from './quickbooksFault';

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
    realmIdFingerprint: null, pullPayments: true, pushPayments: true, lastReconcileAt: null, cdcCursor: null,
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

  // Phase C bug (#4624 follow-up): QuickBooks bumps an Invoice's SyncToken every
  // time a Payment is applied to or removed from it, so the token Breeze stored
  // at push time goes stale without Breeze ever writing the invoice again.
  it('re-reads the live SyncToken and retries the sparse update once on a 5010 Stale Object fault', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } }),
        { status: 400 },
      ))
      .mockResolvedValueOnce(jsonResponse({ Invoice: { Id: '310', SyncToken: '4' } }))
      .mockResolvedValueOnce(jsonResponse({ Invoice: { Id: '310', SyncToken: '5', TotalAmt: 107.0 } }));

    const result = await quickbooksProvider.pushInvoice(taxConn, invoicePayload({
      mapping: { remoteEntityId: '310', remoteSyncToken: '0' },
    }), [{ invoiceLineId: 'l1', remoteItemRef: { id: '77' } }]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // First attempt used the stored (stale) token.
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body)).SyncToken).toBe('0');
    // Then a read of the live Invoice.
    const readUrl = String(fetchMock.mock.calls[1]![0]);
    expect(readUrl).toContain('/invoice/310');
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method ?? 'GET').toBe('GET');
    // Retry carries the LIVE token, still sparse against the same Id.
    expect(JSON.parse(String((fetchMock.mock.calls[2]![1] as RequestInit).body)))
      .toMatchObject({ sparse: true, Id: '310', SyncToken: '4' });
    // And the caller gets the token QuickBooks returned, to persist.
    expect(result.syncToken).toBe('5');
  });

  it('does not loop on a stale fault: a second 5010 after the re-read propagates', async () => {
    const stale = () => new Response(
      JSON.stringify({ Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } }),
      { status: 400 },
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(jsonResponse({ Invoice: { Id: '310', SyncToken: '4' } }))
      .mockResolvedValueOnce(stale());

    await expect(quickbooksProvider.pushInvoice(taxConn, invoicePayload({
      mapping: { remoteEntityId: '310', remoteSyncToken: '0' },
    }), [])).rejects.toThrow(/failed with 400/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never re-reads a SyncToken on the CREATE path — a 5010 there propagates untouched', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } }),
      { status: 400 },
    ));

    await expect(quickbooksProvider.pushInvoice(taxConn, invoicePayload({ mapping: null }), []))
      .rejects.toThrow(/failed with 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('returns the SyncToken QuickBooks stamped on the void, for the coordinator to persist', async () => {
    mockFetchJsonOnce({ Invoice: { Id: '310', SyncToken: '5', status: 'Voided' } });

    await expect(quickbooksProvider.voidInvoice(conn(), voidPayload(), { remoteEntityId: '310', remoteSyncToken: '4' }))
      .resolves.toEqual({ syncToken: '5' });
  });

  // Walk item 37 / prod v0.110.0: QuickBooks bumps an Invoice's SyncToken every
  // time a Payment is applied, so voiding a PAID invoice always failed with a
  // 400 on the stored token and left the mapping in error. QuickBooks does
  // allow the void — it just wants the live revision.
  it('re-reads the live SyncToken and retries the void exactly once on a 5010 Stale Object fault', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } }),
        { status: 400 },
      ))
      .mockResolvedValueOnce(jsonResponse({ Invoice: { Id: '310', SyncToken: '7' } }))
      .mockResolvedValueOnce(jsonResponse({ Invoice: { Id: '310', SyncToken: '8', status: 'Voided' } }));

    const result = await quickbooksProvider.voidInvoice(
      conn(), voidPayload(), { remoteEntityId: '310', remoteSyncToken: '4' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // First void used the stored (stale) token.
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ Id: '310', SyncToken: '4' });
    // Then a plain GET of the live Invoice.
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/invoice/310');
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method ?? 'GET').toBe('GET');
    // Retry carries the LIVE token.
    expect(String(fetchMock.mock.calls[2]![0])).toContain('invoice?operation=void');
    expect(JSON.parse(String((fetchMock.mock.calls[2]![1] as RequestInit).body))).toEqual({ Id: '310', SyncToken: '7' });
    expect(result).toEqual({ syncToken: '8' });
  });

  it('does not loop on a stale fault: a second 5010 after the re-read propagates', async () => {
    const stale = () => new Response(
      JSON.stringify({ Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } }),
      { status: 400 },
    );
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(stale())
      .mockResolvedValueOnce(jsonResponse({ Invoice: { Id: '310', SyncToken: '7' } }))
      .mockResolvedValueOnce(stale());

    await expect(quickbooksProvider.voidInvoice(conn(), voidPayload(), { remoteEntityId: '310', remoteSyncToken: '4' }))
      .rejects.toThrow(/failed with 400/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  // #5180 — the seam that makes the whole terminal-classification chain work.
  // Everything downstream (the coordinator's catch, the worker's TERMINAL_CODES)
  // keys off the fields `qboRequest` attaches HERE. If that attachment regresses
  // — wrong property name, inverted condition — every hand-built-error test
  // downstream stays green while the feature never fires against real
  // QuickBooks, which is exactly the "five identical refusals, no signal"
  // failure this issue was about. So this test starts from a real fetch reply.
  it('attaches the payment-linked classification off the FULL fault body, so the coordinator can call the void terminal', async () => {
    const detail = 'Business Validation Error: You cannot void this invoice because it has payments applied to it.'
      // Padding so the reason sits PAST the 500-character truncation point that
      // `body` storage applies — the classification must survive that.
      + ` ${'x'.repeat(600)}`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ Fault: { Error: [{ code: '6000', Message: 'Business Validation Error', Detail: detail }] } }),
      { status: 400 },
    ));

    const err = await quickbooksProvider
      .voidInvoice(conn(), voidPayload(), { remoteEntityId: '310', remoteSyncToken: '4' })
      .catch((e: unknown) => e) as Error & { body?: string; qboPaymentLinked?: boolean };

    // Not a 5010, so the provider does NOT re-read and retry — it propagates.
    expect(err.message).toMatch(/failed with 400/);
    expect(err.qboPaymentLinked).toBe(true);
    expect(isQboPaymentLinkedRefusal(err)).toBe(true);
    // The truncated copy stored for forensics still never carries Intuit's
    // Detail past 500 characters, and the flag did not depend on it.
    expect(err.body!.length).toBeLessThanOrEqual(500);
  });

  it('does NOT flag an ordinary 400 fault as payment-linked — an unrelated rejection keeps its retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ Fault: { Error: [{ code: '6140', Message: 'Duplicate Document Number Error', Detail: 'DocNumber INV-1 already exists.' }] } }),
      { status: 400 },
    ));

    const err = await quickbooksProvider
      .voidInvoice(conn(), voidPayload(), { remoteEntityId: '310', remoteSyncToken: '4' })
      .catch((e: unknown) => e) as Error & { qboPaymentLinked?: boolean };

    expect(err.qboPaymentLinked).toBeUndefined();
    expect(isQboPaymentLinkedRefusal(err)).toBe(false);
  });

  it('reads the live SyncToken FIRST when the mapping has none, instead of refusing the void', async () => {
    // An adopted or re-owned invoice mapping can legitimately carry no token,
    // and refusing left the only route to a QuickBooks void as doing it by hand.
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ Invoice: { Id: '310', SyncToken: '7' } }))
      .mockResolvedValueOnce(jsonResponse({ Invoice: { Id: '310', SyncToken: '8', status: 'Voided' } }));

    const result = await quickbooksProvider.voidInvoice(
      conn(), voidPayload(), { remoteEntityId: '310', remoteSyncToken: null },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/invoice/310');
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({ Id: '310', SyncToken: '7' });
    expect(result).toEqual({ syncToken: '8' });
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
      breezePaymentId: null,
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

  it('reports a payment with no Invoice-linked line as UNAPPLIED, never as deleted', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment({
      Line: [{ Amount: 150.0, LinkedTxn: [{ TxnId: '9', TxnType: 'CreditMemo' }] }],
    })] }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.payments).toEqual([]);
    // The Payment is ALIVE, it just settles no invoice. Calling it a deletion
    // made the pull clear a Breeze-origin row's remote id, after which the
    // invoice fan-out re-owned the mapping and pushed a SECOND QuickBooks
    // Payment for money that moved once (finding C1).
    expect(cs.unappliedPayments).toEqual(['180']);
    expect(cs.deletedPayments).toEqual([]);
  });

  it('reports a QBO-voided payment (TotalAmt 0, no lines) as UNAPPLIED, not as deleted', async () => {
    mockFetchJsonOnce(cdcResponse([{ Payment: [qboPayment({ TotalAmt: 0, Line: [] })] }]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.payments).toEqual([]);
    // QBO never DELETES a Payment on a void — it zeroes it and keeps the row,
    // which is precisely why a delete Breeze still owes it needs the remote id.
    expect(cs.unappliedPayments).toEqual(['180']);
    expect(cs.deletedPayments).toEqual([]);
  });

  it('collects status:"Deleted" Payment and Invoice entities into the deletion lists', async () => {
    mockFetchJsonOnce(cdcResponse([
      { Payment: [{ Id: '181', status: 'Deleted', domain: 'QBO', MetaData: { LastUpdatedTime: '2026-09-02T20:06:00-07:00' } }] },
      { Invoice: [{ Id: '145', status: 'Deleted', domain: 'QBO', MetaData: { LastUpdatedTime: '2026-09-02T20:07:00-07:00' } }] },
    ]));
    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date());
    expect(cs.deletedPayments).toEqual(['181']);
    // `status: "Deleted"` is the ONLY thing that reaches the deletion list.
    expect(cs.unappliedPayments).toEqual([]);
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

  it('RESURRECTS a payment the truncated CDC list called deleted when /query still returns it', async () => {
    // The CDC list is truncated, so its DELETION entries are as unreliable as
    // its change entries — and `/query` never returns a deleted entity, so a row
    // it DOES return is alive whatever CDC said. Without this arm the pull would
    // reverse a live Payment: delete the Breeze `invoice_payments` row and
    // recompute the invoice against money that never stopped existing.
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(cdcResponse([{
        Payment: [{ Id: '180', status: 'Deleted' }],
        startPosition: 1, maxResults: 1, totalCount: 2,
      }])))
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Payment: [qboPayment({ Id: '180' })] } }));

    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date('2026-09-02T20:00:00.000Z'));

    expect(spy).toHaveBeenCalledTimes(2);
    expect(cs.deletedPayments).toEqual([]); // resurrected
    expect(cs.payments.map((p) => p.remotePaymentId)).toEqual(['180']);
    expect(cs.overflowed).toBe(false);
  });

  it('re-buckets unapplied payments both ways when the /query backfill covers them', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(cdcResponse([{
        Payment: [
          // Unapplied at CDC read time...
          qboPayment({ Id: '180', TotalAmt: 0, Line: [] }),
          // ...and applied at CDC read time.
          qboPayment({ Id: '182' }),
        ],
        startPosition: 1, maxResults: 2, totalCount: 5,
      }])))
      .mockResolvedValueOnce(jsonResponse({ QueryResponse: { Payment: [
        // /query is AUTHORITATIVE: 180 has since been re-applied...
        qboPayment({ Id: '180' }),
        // ...and 182 has since been unapplied.
        qboPayment({ Id: '182', TotalAmt: 0, Line: [] }),
      ] } }));

    const cs = await quickbooksProvider.reconcileChanges(conn(), new Date('2026-09-02T20:00:00.000Z'));

    expect(spy).toHaveBeenCalledTimes(2);
    expect(cs.payments.map((p) => p.remotePaymentId)).toEqual(['180']);
    expect(cs.unappliedPayments).toEqual(['182']);
    expect(cs.deletedPayments).toEqual([]);
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

function paymentPayload(overrides: Partial<AccountingPaymentPayload> = {}): AccountingPaymentPayload {
  return {
    invoicePaymentId: '0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    remoteCustomerId: '55', remoteInvoiceId: '145',
    amount: '107.00', currencyCode: 'USD', txnDate: '2026-09-02',
    reference: 'ch_123', privateNote: 'Breeze payment 0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
    pushGeneration: 0,
    ...overrides,
  };
}

describe('createPayment', () => {
  it.each([
    ['1234.56', 1234.56],
    ['0.05', 0.05],
    ['107.00', 107],
  ])('sends %s as an exact TotalAmt and Line Amount', async (amount, expected) => {
    // The wire amount IS the money. A rounding or parsing slip here posts the
    // wrong cash against a customer's invoice and nothing downstream would
    // notice — the mapping stamps `synced` either way. `0.05` catches a
    // minor-unit slip, `1234.56` a float-formatting one.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ Payment: { Id: '181', SyncToken: '0' } }));

    await quickbooksProvider.createPayment(conn(), paymentPayload({ amount }));

    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.TotalAmt).toBe(expected);
    expect(body.Line).toHaveLength(1);
    expect(body.Line[0].Amount).toBe(expected);
    // The two must never disagree: QuickBooks accepts an over-applied Payment
    // and silently leaves the difference as an unapplied credit.
    expect(body.Line[0].Amount).toBe(body.TotalAmt);
  });

  it('posts a Payment applied to the invoice, with requestid, PrivateNote and no CurrencyRef', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ Payment: { Id: '181', SyncToken: '0' } }));

    const ref = await quickbooksProvider.createPayment(conn(), paymentPayload());

    expect(ref).toEqual({ id: '181', syncToken: '0' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).method).toBe('POST');
    expect(String(url)).toContain('/v3/company/realm123/payment?minorversion=70');
    // Deterministic per Breeze payment: a network-level retry of a create that
    // actually landed must return the ORIGINAL Payment, not mint a second one.
    // Generation 0 (every row that predates the generation column, and every
    // first push) keeps the BARE id — unchanged wire behaviour.
    expect(String(url)).toMatch(/requestid=0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b$/);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({
      CustomerRef: { value: '55' },
      TotalAmt: 107,
      TxnDate: '2026-09-02',
      PaymentRefNum: 'ch_123',
      PrivateNote: 'Breeze payment 0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
      Line: [{ Amount: 107, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] }],
    });
    // Explicitly absent (spec decision 8 + the CurrencyRef rule pushInvoice follows).
    expect(body).not.toHaveProperty('CurrencyRef');
    expect(body).not.toHaveProperty('DepositToAccountRef');
    expect(body).not.toHaveProperty('PaymentMethodRef');
  });

  it('suffixes the requestid with the push generation once the mapping has been re-owned', async () => {
    // QuickBooks replays the ORIGINAL create response for a requestid for 24h.
    // After somebody deletes the Breeze-created Payment in QuickBooks, the
    // fan-out re-owns the mapping and bumps its generation; without a NEW
    // requestid the replay hands back the id of the Payment that no longer
    // exists and the mapping is stamped synced against nothing.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ Payment: { Id: '190', SyncToken: '0' } }));

    await quickbooksProvider.createPayment(conn(), paymentPayload({ pushGeneration: 2 }));

    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain('requestid=0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b%3Ag2');
    // The adoption marker is generation-FREE: the pull matches Payments on it.
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body.PrivateNote).toBe('Breeze payment 0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b');
  });

  it('omits PaymentRefNum entirely when there is no reference', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ Payment: { Id: '182', SyncToken: '0' } }));
    await quickbooksProvider.createPayment(conn(), paymentPayload({ reference: null }));
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect('PaymentRefNum' in body).toBe(false);
  });

  it('throws when the response carries no Id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ Payment: {} }));
    await expect(quickbooksProvider.createPayment(conn(), paymentPayload()))
      .rejects.toThrow(/missing an Id/);
  });
});

describe('deletePayment', () => {
  it('posts operation=delete with the known SyncToken', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ Payment: { Id: '181', status: 'Deleted' } }));

    const result = await quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' });

    expect(result).toBe('deleted');
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('payment?operation=delete&minorversion=70');
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)))
      .toEqual({ Id: '181', SyncToken: '3' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an empty body', {}],
    ['a Payment with neither an Id nor a Deleted status', { Payment: {} }],
    // The two the AND let through: each carries ONE of the two signals.
    ['a Payment with an Id but no Deleted status', { Payment: { Id: '181' } }],
    ['a Payment with an Id and a non-Deleted status', { Payment: { Id: '181', status: 'Pending' } }],
    ['a Deleted status with no Id', { Payment: { status: 'Deleted' } }],
  ])('refuses to report success on a 2xx with %s', async (_label, body) => {
    // The guard read `!Id && status !== 'Deleted'` — an AND, so a body carrying
    // an Id but no `Deleted` status (or vice versa) passed. Its own comment says
    // a 2xx that does not actually confirm the delete must not be success, and
    // that is an OR: BOTH signals have to be absent before Breeze believes it.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body));

    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .rejects.toThrow(/did not confirm deletion/);
  });

  it('accepts a 2xx that confirms with an Id AND a Deleted status', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ Payment: { Id: '181', status: 'Deleted' } }));

    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .resolves.toBe('deleted');
  });

  it('treats an Object Not Found fault as success — the desired end state already holds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ Fault: { Error: [{ code: '610', Message: 'Object Not Found' }] } }),
      { status: 400 },
    ));
    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .resolves.toBe('already_absent');
  });

  it('still re-reads the SyncToken when the fault code sits PAST the 500-char body cap', async () => {
    // `qboRequest` truncates `body` to 500 chars for storage, and the
    // classifiers used to regex that truncated text — so a fault whose code sat
    // behind a long `Detail` read as "not a stale object", the re-read never
    // fired, and the delete failed permanently on a fault designed to be
    // retried. The classification is taken from the FULL text.
    const padded = JSON.stringify({
      Fault: { Error: [{ Detail: 'D'.repeat(900), code: '5010', Message: 'Stale Object Error' }] },
    });
    expect(padded.indexOf('5010')).toBeGreaterThan(500); // the fixture is the point
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(padded, { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', SyncToken: '7' } }))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', status: 'Deleted' } }));

    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .resolves.toBe('deleted');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('classifies a CODE-only fault (no Message) as already_absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ Fault: { Error: [{ code: '610' }] } }), { status: 400 },
    ));
    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .resolves.toBe('already_absent');
  });

  it('classifies a MESSAGE-only fault (no code) as already_absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ Fault: { Error: [{ Message: 'Object Not Found' }] } }), { status: 400 },
    ));
    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .resolves.toBe('already_absent');
  });

  it('classifies a MESSAGE-only stale fault (no code) and re-reads the token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ Fault: { Error: [{ Message: 'Stale Object Error' }] } }), { status: 400 },
      ))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', SyncToken: '7' } }))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', status: 'Deleted' } }));

    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .resolves.toBe('deleted');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('re-reads the SyncToken ONCE on a stale-object fault and retries the delete', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } }),
        { status: 400 },
      ))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', SyncToken: '7' } }))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', status: 'Deleted' } }));

    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .resolves.toBe('deleted');

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(String(fetchSpy.mock.calls[1]![0])).toContain('payment/181?minorversion=70');
    // The SyncToken re-read is a plain GET — the provider must never send
    // `method: 'POST'` for it (that would be a second, unintended delete).
    expect((fetchSpy.mock.calls[1]![1] as RequestInit | undefined)?.method).not.toBe('POST');
    expect(JSON.parse(String((fetchSpy.mock.calls[2]![1] as RequestInit).body)))
      .toEqual({ Id: '181', SyncToken: '7' });
  });

  it('gives up after ONE stale retry so a token war cannot loop', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ Fault: { Error: [{ code: '5010' }] } }), { status: 400 }))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', SyncToken: '7' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Fault: { Error: [{ code: '5010' }] } }), { status: 400 }));

    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('reads a fresh SyncToken first when Breeze holds none', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', SyncToken: '2' } }))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', status: 'Deleted' } }));
    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: null }))
      .resolves.toBe('deleted');
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('payment/181?minorversion=70');
    // The delete must carry the token the READ returned. Sending anything else
    // (or nothing) earns a 5010 at best and, on the retry path, a delete of the
    // wrong revision at worst.
    expect(JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body)))
      .toEqual({ Id: '181', SyncToken: '2' });
  });

  it('reports already_absent when the null-token READ says the Payment is gone', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ Fault: { Error: [{ code: '610', Message: 'Object Not Found' }] } }), { status: 400 },
    ));

    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: null }))
      .resolves.toBe('already_absent');
    // Exactly one call: the read answered, so no delete was ever attempted.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('reports already_absent when the STALE-PATH re-read says the Payment is gone', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } }), { status: 400 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ Fault: { Error: [{ code: '610', Message: 'Object Not Found' }] } }), { status: 400 },
      ));

    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .resolves.toBe('already_absent');
    // Delete, re-read — and NO third call: somebody removed it between the two.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('reports already_absent when the RETRIED delete says the Payment is gone', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } }), { status: 400 },
      ))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181', SyncToken: '7' } }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ Fault: { Error: [{ code: '610', Message: 'Object Not Found' }] } }), { status: 400 },
      ));

    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .resolves.toBe('already_absent');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('throws — rather than reporting already_absent — when a 2xx read carries no SyncToken (no held token)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181' } })); // no SyncToken
    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: null }))
      .rejects.toThrow(/no SyncToken/);
    // The malformed read must never be treated as "go ahead and delete" —
    // no second (delete) request should have been issued.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws — rather than reporting already_absent — when a 2xx read carries no SyncToken (stale-retry path)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ Fault: { Error: [{ code: '5010', Message: 'Stale Object Error' }] } }),
        { status: 400 },
      ))
      .mockResolvedValueOnce(jsonResponse({ Payment: { Id: '181' } })); // no SyncToken
    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .rejects.toThrow(/no SyncToken/);
    // Malformed read after the stale fault must not trigger a second delete attempt.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('propagates an unrelated fault as a rejection — it is NOT classified already_absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ Fault: { Error: [{ code: '6240', Message: 'Invalid Reference Id' }] } }),
      { status: 400 },
    ));
    await expect(quickbooksProvider.deletePayment(conn(), { remotePaymentId: '181', syncToken: '3' }))
      .rejects.toMatchObject({ status: 400 });
  });
});

describe('mapQboCdcPayment PrivateNote marker', () => {
  it('parses a Breeze-authored note onto the change-set line', async () => {
    const line = mapQboCdcPayment({
      Id: '181', SyncToken: '0', TxnDate: '2026-09-02', TotalAmt: 107,
      PrivateNote: 'Breeze payment 0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b',
      Line: [{ Amount: 107, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] }],
    }, conn());
    expect(line[0]!.breezePaymentId).toBe('0f8d1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b');
  });

  it('leaves breezePaymentId null for an operator-authored note', () => {
    const line = mapQboCdcPayment({
      Id: '182', SyncToken: '0', TxnDate: '2026-09-02', TotalAmt: 50,
      PrivateNote: 'cheque dropped off at reception',
      Line: [{ Amount: 50, LinkedTxn: [{ TxnId: '145', TxnType: 'Invoice' }] }],
    }, conn());
    expect(line[0]!.breezePaymentId).toBeNull();
  });
});
