import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module: provide db (select/insert), and pass-through context helpers.
const {
  selectMock,
  insertMock,
  getConnectionMock,
  getValidAccessTokenMock,
  listRemoteCustomersMock,
  ReauthRequiredError,
} = vi.hoisted(() => {
  class ReauthRequiredError extends Error {
    constructor(message = 'reauth') { super(message); this.name = 'ReauthRequiredError'; }
  }
  return {
    selectMock: vi.fn(),
    insertMock: vi.fn(),
    getConnectionMock: vi.fn(),
    getValidAccessTokenMock: vi.fn(),
    listRemoteCustomersMock: vi.fn(),
    ReauthRequiredError,
  };
});
vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

vi.mock('./accountingConnectionService', () => ({
  getConnection: getConnectionMock,
}));

vi.mock('./accountingTokens', () => ({
  getValidAccessToken: getValidAccessTokenMock,
  ReauthRequiredError,
}));

vi.mock('./providerRegistry', () => ({
  getAccountingProvider: () => ({ listRemoteCustomers: listRemoteCustomersMock }),
}));

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import {
  slugify, generateUniqueSlug, importQuickbooksCustomers,
  listQuickbooksCustomersAnnotated, QbImportError,
} from './quickbooksCustomerImport';

function connectedConn() {
  return { id: 'c1', partnerId: 'p1', provider: 'quickbooks', realmId: 'r1', accessToken: 'tok', environment: 'sandbox', status: 'connected' };
}

// Helper to stub `db.select(...).from(...).where(...)` returning `rows`.
function stubSelect(rows: unknown[]) {
  selectMock.mockReturnValue({ from: () => ({ where: () => Promise.resolve(rows) }) });
}

// Captures the object passed to each `db.insert(...).values(OBJ)` call, in order,
// without any production-code instrumentation.
const valuesSpy = vi.fn();
function stubInserts(rowsInOrder: unknown[][]) {
  let call = 0;
  insertMock.mockImplementation(() => ({
    values: (v: unknown) => { valuesSpy(v); return { returning: () => Promise.resolve(rowsInOrder[call++] ?? []) }; },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  valuesSpy.mockClear();
  getConnectionMock.mockResolvedValue(connectedConn());
  getValidAccessTokenMock.mockResolvedValue('fresh-token');
});

describe('slugify', () => {
  it('lowercases, strips punctuation, hyphenates spaces', () => {
    expect(slugify('Acme Co., Inc.')).toBe('acme-co-inc');
    expect(slugify('  Multiple   Spaces  ')).toBe('multiple-spaces');
  });
  it('falls back to "org" for empty/punctuation-only input', () => {
    expect(slugify('!!!')).toBe('org');
    expect(slugify('')).toBe('org');
  });
});

describe('generateUniqueSlug', () => {
  it('returns the base when free', () => {
    expect(generateUniqueSlug('acme', new Set())).toBe('acme');
  });
  it('appends an incrementing suffix on collision', () => {
    expect(generateUniqueSlug('acme', new Set(['acme', 'acme-2']))).toBe('acme-3');
  });
});

describe('listQuickbooksCustomersAnnotated', () => {
  it('annotates already-imported customers from existing org external ids', async () => {
    listRemoteCustomersMock.mockResolvedValue([
      { id: '1', displayName: 'A' }, { id: '2', displayName: 'B' },
    ]);
    stubSelect([{ id: 'org-1', accountingExternalId: '1' }]);

    const result = await listQuickbooksCustomersAnnotated('p1');

    expect(result).toEqual([
      expect.objectContaining({ id: '1', alreadyImported: true, organizationId: 'org-1' }),
      expect.objectContaining({ id: '2', alreadyImported: false, organizationId: null }),
    ]);
    expect(getValidAccessTokenMock).toHaveBeenCalled();
  });

  it('throws QbImportError(not_connected) when no connection exists', async () => {
    getConnectionMock.mockResolvedValue(null);
    await expect(listQuickbooksCustomersAnnotated('p1')).rejects.toMatchObject({ code: 'not_connected', status: 404 });
  });
});

describe('importQuickbooksCustomers', () => {
  it('creates an org + site for a new customer, mapping billing + shipping data', async () => {
    listRemoteCustomersMock.mockResolvedValue([{
      id: '1', displayName: 'Acme Co', email: 'ap@acme.test', phone: '555', contactName: 'Jane Doe',
      billAddr: { line1: '1 Bill St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' },
      shipAddr: { line1: '2 Ship Rd', city: 'Dallas' },
    }]);
    stubSelect([]); // no existing orgs
    stubInserts([[{ id: 'org-1', name: 'Acme Co', partnerId: 'p1' }], [{ id: 'site-1', orgId: 'org-1', name: 'Acme Co' }]]);

    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });

    expect(summary.imported).toEqual([{ customerId: '1', displayName: 'Acme Co', organizationId: 'org-1', siteId: 'site-1' }]);
    expect(summary.skipped).toEqual([]);
    expect(summary.errors).toEqual([]);

    // Org insert (first values() call) got billing address + accounting link.
    const orgInsertArg = valuesSpy.mock.calls[0]![0];
    expect(orgInsertArg).toMatchObject({
      partnerId: 'p1', name: 'Acme Co', slug: 'acme-co',
      accountingProvider: 'quickbooks', accountingExternalId: '1',
      billingContact: { name: 'Jane Doe', email: 'ap@acme.test', phone: '555' },
      billingAddressLine1: '1 Bill St', billingAddressCity: 'Austin',
      billingAddressRegion: 'TX', billingAddressPostalCode: '78701', billingAddressCountry: 'US',
    });
    // Site insert (second values() call) used shipping address.
    const siteInsertArg = valuesSpy.mock.calls[1]![0];
    expect(siteInsertArg).toMatchObject({
      orgId: 'org-1', name: 'Acme Co',
      address: { addressLine1: '2 Ship Rd', city: 'Dallas' },
      contact: { name: 'Jane Doe', email: 'ap@acme.test', phone: '555' },
    });
  });

  it('falls back to billing address for the site when shipping is absent', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme', billAddr: { line1: '1 Bill St', city: 'Austin' } }]);
    stubSelect([]);
    stubInserts([[{ id: 'org-1' }], [{ id: 'site-1' }]]);
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(valuesSpy.mock.calls[1]![0]).toMatchObject({ address: { addressLine1: '1 Bill St', city: 'Austin' } });
  });

  it('nulls billingAddressCountry when QB Country is not a 2-char code (char(2) guard)', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme', billAddr: { country: 'United States' } }]);
    stubSelect([]);
    stubInserts([[{ id: 'org-1' }], [{ id: 'site-1' }]]);
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    // Org column is char(2): the long country must NOT be written (would throw + drop the customer).
    expect(valuesSpy.mock.calls[0]![0].billingAddressCountry).toBeNull();
    // …but the full country is preserved on the site address JSONB (no length cap).
    expect(valuesSpy.mock.calls[1]![0].address).toMatchObject({ country: 'United States' });
  });

  it('uppercases a genuine 2-char country code into billingAddressCountry', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme', billAddr: { country: 'us' } }]);
    stubSelect([]);
    stubInserts([[{ id: 'org-1' }], [{ id: 'site-1' }]]);
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(valuesSpy.mock.calls[0]![0].billingAddressCountry).toBe('US');
  });

  it('skips customers already linked to an org', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubSelect([{ id: 'org-9', accountingExternalId: '1' }]);
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(summary.imported).toEqual([]);
    expect(summary.skipped).toEqual([{ customerId: '1', displayName: 'Acme', organizationId: 'org-9', reason: 'already_imported' }]);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('suffixes the slug when the base collides with an existing org slug', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubSelect([{ id: 'org-x', accountingExternalId: '99', slug: 'acme' }]);
    stubInserts([[{ id: 'org-1' }], [{ id: 'site-1' }]]);
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(valuesSpy.mock.calls[0]![0]).toMatchObject({ slug: 'acme-2' });
  });

  it('records a per-customer error and continues with the rest (partial success)', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Bad' }, { id: '2', displayName: 'Good' }]);
    stubSelect([]);
    let call = 0;
    insertMock.mockImplementation(() => ({
      values: (v: any) => ({
        returning: () => {
          call++;
          if (call === 1) return Promise.reject(new Error('boom')); // org insert for customer 1
          return Promise.resolve([{ id: `row-${call}` }]);
        },
      }),
    }));
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1', '2'] });
    expect(summary.errors).toEqual([{ customerId: '1', displayName: 'Bad', error: 'boom' }]);
    expect(summary.imported).toHaveLength(1);
    expect(summary.imported[0]!.customerId).toBe('2');
  });

  it('reports requested ids not present in QuickBooks as errors', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    stubSelect([]);
    stubInserts([[{ id: 'org-1' }], [{ id: 'site-1' }]]);
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1', 'missing'] });
    expect(summary.errors).toContainEqual({ customerId: 'missing', error: 'Customer not found in QuickBooks' });
    expect(summary.imported).toHaveLength(1);
  });

  it('passes the freshly-resolved access token (not the stale conn token) to listRemoteCustomers', async () => {
    getValidAccessTokenMock.mockResolvedValue('fresh-token');
    listRemoteCustomersMock.mockResolvedValue([]);
    stubSelect([]);
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: [] });
    expect(listRemoteCustomersMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh-token' }));
  });

  it('reserves slugs within the batch so two same-named new customers do not collide', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }, { id: '2', displayName: 'Acme' }]);
    stubSelect([]);
    stubInserts([[{ id: 'o1' }], [{ id: 's1' }], [{ id: 'o2' }], [{ id: 's2' }]]);
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1', '2'] });
    expect(valuesSpy.mock.calls[0]![0].slug).toBe('acme');   // first org
    expect(valuesSpy.mock.calls[2]![0].slug).toBe('acme-2'); // second org (third values() call)
  });

  it('clamps over-long name + city to the column widths (lossless: full value stays in site JSONB)', async () => {
    const longName = 'N'.repeat(300);
    const longCity = 'C'.repeat(200);
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: longName, billAddr: { city: longCity } }]);
    stubSelect([]);
    stubInserts([[{ id: 'org-1' }], [{ id: 'site-1' }]]);
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(valuesSpy.mock.calls[0]![0].name).toHaveLength(255);
    expect(valuesSpy.mock.calls[0]![0].billingAddressCity).toHaveLength(120);
  });

  it('maps QB address region -> site address state key', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme', billAddr: { region: 'TX', city: 'Austin' } }]);
    stubSelect([]);
    stubInserts([[{ id: 'org-1' }], [{ id: 'site-1' }]]);
    await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(valuesSpy.mock.calls[1]![0].address).toMatchObject({ state: 'TX', city: 'Austin' });
  });

  it('reclassifies a concurrent unique-violation as skipped (honors the partial unique index)', async () => {
    listRemoteCustomersMock.mockResolvedValue([{ id: '1', displayName: 'Acme' }]);
    // 1st select = loadExistingOrgs (none); 2nd select = catch re-query (winner org).
    selectMock
      .mockImplementationOnce(() => ({ from: () => ({ where: () => Promise.resolve([]) }) }))
      .mockImplementationOnce(() => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: 'org-dup' }]) }) }) }));
    const dupErr = Object.assign(new Error('dup'), { code: '23505' });
    insertMock.mockImplementation(() => ({ values: () => ({ returning: () => Promise.reject(dupErr) }) }));
    const summary = await importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] });
    expect(summary.errors).toEqual([]);
    expect(summary.skipped).toEqual([{ customerId: '1', displayName: 'Acme', organizationId: 'org-dup', reason: 'already_imported' }]);
  });
});

describe('importQuickbooksCustomers — connection/QBO error mapping', () => {
  it('throws QbImportError(reauth_required, 409) when the connection needs reauth', async () => {
    getConnectionMock.mockResolvedValue({ ...connectedConn(), status: 'reauth_required' });
    await expect(importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] }))
      .rejects.toMatchObject({ code: 'reauth_required', status: 409 });
  });

  it('maps a ReauthRequiredError from getValidAccessToken to QbImportError(409)', async () => {
    getValidAccessTokenMock.mockRejectedValue(new ReauthRequiredError());
    await expect(importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] }))
      .rejects.toMatchObject({ code: 'reauth_required', status: 409 });
  });

  it('maps a QBO API failure to QbImportError(quickbooks_error, 502)', async () => {
    getValidAccessTokenMock.mockResolvedValue('tok');
    listRemoteCustomersMock.mockRejectedValue(new Error('QuickBooks customer query failed with 429'));
    await expect(importQuickbooksCustomers({ partnerId: 'p1', customerIds: ['1'] }))
      .rejects.toMatchObject({ code: 'quickbooks_error', status: 502 });
  });
});
