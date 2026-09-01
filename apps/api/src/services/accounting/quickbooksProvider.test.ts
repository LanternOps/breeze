import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { quickbooksProvider, mapQboCustomer, mapQboAddress } from './quickbooksProvider';
import type { AccountingConnection } from './accountingConnectionService';

function conn(overrides: Partial<AccountingConnection> = {}): AccountingConnection {
  return {
    id: 'c1', partnerId: 'p1', provider: 'quickbooks',
    realmId: 'realm123', accessToken: 'tok', refreshToken: 'r',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    environment: 'sandbox', homeCurrency: 'USD',
    defaultIncomeAccountRef: null, defaultTaxCodeRef: null,
    pushMode: 'auto', status: 'connected',
    createdAt: null, updatedAt: null, lastError: null,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

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
      displayName: 'Acme', companyName: 'Acme LLC', email: 'ap@acme.test',
      phone: '555-1212', taxId: 'TAX-1',
      billingAddress: { line1: '1 Main', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' },
    });

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

  it('sparse-updates a Customer with its current Id and SyncToken', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      Customer: { Id: '12', SyncToken: '8' },
    }), { status: 200 }));

    await quickbooksProvider.upsertCustomer(conn(), {
      displayName: 'Acme LLC', existing: { id: '12', syncToken: '7' },
    });

    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      sparse: true, Id: '12', SyncToken: '7', DisplayName: 'Acme LLC',
    });
  });
});

describe('upsertItem', () => {
  const input = {
    name: 'Managed Service', sku: 'MS-1', description: 'Monthly management',
    type: 'Service' as const, unitPrice: 125, taxable: true,
    incomeAccountRef: '79', active: true,
  };

  it('creates an Item with the configured income account', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({
      Item: { Id: '9', SyncToken: '0' },
    }), { status: 200 }));

    await expect(quickbooksProvider.upsertItem(conn(), input)).resolves.toEqual({ id: '9', syncToken: '0' });
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      Name: 'Managed Service', Sku: 'MS-1', Description: 'Monthly management',
      Type: 'Service', UnitPrice: 125, Taxable: true, Active: true,
      IncomeAccountRef: { value: '79' },
    });
  });

  it('refuses an update that is missing the current SyncToken', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(quickbooksProvider.upsertItem(conn(), {
      ...input, existing: { id: '9' },
    })).rejects.toThrow(/SyncToken/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('listRemoteCustomers', () => {
  it('pages through the QBO query API until a short page is returned', async () => {
    const page1 = { QueryResponse: { Customer: Array.from({ length: 1000 }, (_, i) => ({ Id: String(i), DisplayName: `C${i}` })) } };
    const page2 = { QueryResponse: { Customer: [{ Id: '1000', DisplayName: 'last' }] } };
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));

    const result = await quickbooksProvider.listRemoteCustomers(conn());

    expect(result).toHaveLength(1001);
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
