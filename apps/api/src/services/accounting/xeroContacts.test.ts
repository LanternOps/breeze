import { afterEach, describe, expect, it, vi } from 'vitest';

const { slotMock } = vi.hoisted(() => ({
  slotMock: vi.fn((_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn()),
}));
vi.mock('./accountingRateLimit', async (orig) => ({
  ...(await orig<typeof import('./accountingRateLimit')>()),
  withProviderCallSlot: slotMock,
  noteDailyRemaining: vi.fn(async () => {}),
}));

import { AccountingProviderError } from './accountingProviderError';
import {
  contactNumberFor, getXeroContact, listXeroContacts, toRemoteCustomer, upsertXeroContact, xeroContactName,
  XERO_CONTACT_PAGE_GUARD,
} from './xeroContacts';
import type { AccountingCustomerPayload } from './types';

const ORG = '0f0e0d0c-0b0a-4908-8706-050403020100';
const NUMBER = `breeze:${ORG}`;
const ctx = {
  connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at',
  rate: { perConnection: { limit: 60, windowSeconds: 60 }, maxConcurrentPerConnection: 5, appWide: null, dailyPerConnection: null },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const payload = (over: Partial<AccountingCustomerPayload> = {}): AccountingCustomerPayload => ({
  organizationId: ORG, displayName: 'Acme Ltd', billingEmail: 'ap@acme.test', taxId: null,
  phone: '+44 20 7946 0000', billAddr: { line1: '1 High St', city: 'London', postalCode: 'N1 1AA', country: 'GB' },
  currencyCode: 'GBP', ...over,
});
const contact = (over: Record<string, unknown> = {}) => ({
  ContactID: 'xc-1', ContactNumber: NUMBER, ContactStatus: 'ACTIVE', Name: 'Acme Ltd',
  EmailAddress: 'ap@acme.test', UpdatedDateUTC: '/Date(1790000000000+0000)/', ...over,
});
const urlOf = (fetchMock: ReturnType<typeof vi.spyOn>, i: number) => (fetchMock.mock.calls[i] as [string, RequestInit])[0];
const initOf = (fetchMock: ReturnType<typeof vi.spyOn>, i: number) => (fetchMock.mock.calls[i] as [string, RequestInit])[1];
const LOOKUP_URL = `https://api.xero.com/api.xro/2.0/Contacts?where=ContactNumber%3D%3D%22breeze%3A${ORG}%22&includeArchived=true`;

afterEach(() => { vi.restoreAllMocks(); slotMock.mockClear(); });

describe('contact wire mapping', () => {
  it('maps a paged Contacts row, POBOX → billAddr and STREET → shipAddr', () => {
    expect(toRemoteCustomer(contact({
      FirstName: 'Pat', LastName: 'Lee', DefaultCurrency: 'gbp',
      Phones: [{ PhoneType: 'FAX', PhoneNumber: '1' }, { PhoneType: 'DEFAULT', PhoneCountryCode: '44', PhoneAreaCode: '20', PhoneNumber: '7946 0000' }],
      Addresses: [
        { AddressType: 'POBOX', AddressLine1: 'PO Box 9', City: 'Leeds' },
        { AddressType: 'STREET', AddressLine1: '1 High St', AddressLine2: 'Floor 2', AddressLine3: 'Unit 4', PostalCode: 'N1 1AA', Country: 'United Kingdom' },
      ],
    }))).toEqual({
      id: 'xc-1', displayName: 'Acme Ltd', email: 'ap@acme.test', companyName: 'Acme Ltd', contactName: 'Pat Lee',
      phone: '44 20 7946 0000',
      billAddr: { line1: 'PO Box 9', city: 'Leeds' },
      shipAddr: { line1: '1 High St', line2: 'Floor 2, Unit 4', postalCode: 'N1 1AA', country: 'United Kingdom' },
      active: true, remoteVersion: new Date(1790000000000).toISOString(), currencyCode: 'GBP',
    });
  });
  it('flags archived contacts inactive and supplier-only contacts supplierOnly', () => {
    expect(toRemoteCustomer(contact({ ContactStatus: 'ARCHIVED' }))).toMatchObject({ active: false });
    expect(toRemoteCustomer(contact({ IsSupplier: true, IsCustomer: false }))).toMatchObject({ supplierOnly: true });
    expect(toRemoteCustomer(contact({ IsSupplier: true, IsCustomer: true }))).not.toHaveProperty('supplierOnly');
    expect(toRemoteCustomer(contact({}))).not.toHaveProperty('supplierOnly'); // no transactions yet: stays visible
  });
  it('drops GDPR-erased contacts and rows without an id', () => {
    expect(toRemoteCustomer(contact({ ContactStatus: 'GDPRREQUEST' }))).toBeNull();
    expect(toRemoteCustomer(contact({ ContactID: undefined }))).toBeNull();
  });
  it('makes a Xero-safe name and refuses one that is empty after cleaning', () => {
    expect(xeroContactName('  <Acme>   Ltd  ')).toBe('Acme Ltd');
    expect(xeroContactName('x'.repeat(300))).toHaveLength(255);
    expect(() => xeroContactName(' <> ')).toThrow(expect.objectContaining({ kind: 'validation', provider: 'xero' }));
  });
  it('truncates the name by code point, never leaving a lone surrogate (Review Minor 2)', () => {
    const name = `${'N'.repeat(254)}😀BB`; // 254 ascii + 1 emoji (surrogate pair) + 2 ascii, 258 UTF-16 units
    const truncated = xeroContactName(name);
    expect(truncated).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
    expect(Array.from(truncated)).toHaveLength(255);
  });
  it('builds the ContactNumber from a UUID only', () => {
    expect(contactNumberFor(ORG)).toBe(NUMBER);
    expect(() => contactNumberFor('x" or 1==1')).toThrow(expect.objectContaining({ kind: 'validation' }));
  });
});

describe('listXeroContacts', () => {
  it('pages at 1000 with archived included until pageCount, dropping GDPR rows', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ pagination: { page: 1, pageSize: 1000, pageCount: 2, itemCount: 1002 }, Contacts: [contact(), contact({ ContactID: 'gdpr', ContactStatus: 'GDPRREQUEST' })] }))
      .mockResolvedValueOnce(json({ pagination: { page: 2, pageSize: 1000, pageCount: 2, itemCount: 1002 }, Contacts: [contact({ ContactID: 'xc-2', Name: 'Beta' })] }));
    const rows = await listXeroContacts(ctx);
    expect(rows.map((r) => r.id)).toEqual(['xc-1', 'xc-2']);
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Contacts?page=1&pageSize=1000&includeArchived=true');
    expect(urlOf(fetchMock, 1)).toBe('https://api.xero.com/api.xro/2.0/Contacts?page=2&pageSize=1000&includeArchived=true');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('honours the query through searchTerm', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ pagination: { pageCount: 1 }, Contacts: [] }));
    await listXeroContacts(ctx, '  acme co ');
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Contacts?page=1&pageSize=1000&includeArchived=true&searchTerm=acme%20co');
  });
  it('stops on a short page when the pagination object is missing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await listXeroContacts(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('follows pageCount past 100 pages — a large tenant is never silently truncated (quorum 9)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ pagination: { pageCount: 150 }, Contacts: [contact()] }));
    await expect(listXeroContacts(ctx)).resolves.toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(150);
  });
  it('throws instead of returning a partial list when pagination never ends', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ pagination: { pageCount: 999_999 }, Contacts: [contact()] }));
    await expect(listXeroContacts(ctx)).rejects.toMatchObject({ kind: 'transient', provider: 'xero' });
    expect(fetchMock).toHaveBeenCalledTimes(XERO_CONTACT_PAGE_GUARD);
  });
});

describe('getXeroContact', () => {
  it('reads one contact by id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await expect(getXeroContact(ctx, 'xc-1')).resolves.toMatchObject({ id: 'xc-1' });
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Contacts/xc-1');
  });
  it('returns null on 404 and for a GDPR-erased contact', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Title: 'Not Found' }, 404))
      .mockResolvedValueOnce(json({ Contacts: [contact({ ContactStatus: 'GDPRREQUEST' })] }));
    await expect(getXeroContact(ctx, 'nope')).resolves.toBeNull();
    await expect(getXeroContact(ctx, 'xc-1')).resolves.toBeNull();
  });
});

describe('upsertXeroContact', () => {
  it('creates with ContactNumber after a lookup miss', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Contacts: [contact({ DefaultCurrency: 'GBP' })] }));
    const ref = await upsertXeroContact(ctx, payload(), null);
    expect(urlOf(fetchMock, 0)).toBe(LOOKUP_URL);
    expect(urlOf(fetchMock, 1)).toBe('https://api.xero.com/api.xro/2.0/Contacts');
    expect(initOf(fetchMock, 1).method).toBe('PUT');
    expect(JSON.parse(initOf(fetchMock, 1).body as string)).toEqual({ Contacts: [{
      Name: 'Acme Ltd', EmailAddress: 'ap@acme.test',
      Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: '+44 20 7946 0000' }],
      Addresses: [{ AddressType: 'POBOX', AddressLine1: '1 High St', City: 'London', PostalCode: 'N1 1AA', Country: 'GB' }],
      ContactNumber: NUMBER,
    }] });
    expect(ref).toMatchObject({ id: 'xc-1', remoteVersion: new Date(1790000000000).toISOString(), currencyCode: 'GBP' });
  });

  it('adopts a lookup hit instead of creating, and updates it WITHOUT ContactNumber', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [contact()] }))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await upsertXeroContact(ctx, payload(), null);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(fetchMock, 1)).toBe('https://api.xero.com/api.xro/2.0/Contacts/xc-1');
    expect(initOf(fetchMock, 1).method).toBe('POST');
    const body = JSON.parse(initOf(fetchMock, 1).body as string);
    expect(body.Contacts[0]).toMatchObject({ ContactID: 'xc-1', Name: 'Acme Ltd' });
    expect(body.Contacts[0]).not.toHaveProperty('ContactNumber');
  });

  it('refuses to adopt our own archived contact (remote_archived) and writes nothing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [contact({ ContactStatus: 'ARCHIVED' })] }));
    await expect(upsertXeroContact(ctx, payload(), null)).rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_archived', provider: 'xero' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a lookup row whose ContactNumber is not ours (where-clause is only a hint)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [contact({ ContactNumber: 'breeze:other' })] }))
      .mockResolvedValueOnce(json({ Contacts: [contact({ ContactID: 'xc-new' })] }));
    await expect(upsertXeroContact(ctx, payload(), null)).resolves.toMatchObject({ id: 'xc-new' });
    expect(initOf(fetchMock, 1).method).toBe('PUT');
  });

  it('adopts after a timed-out create (Review Focus 1): exactly one PUT, then lookup, then update', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockRejectedValueOnce(new DOMException('t', 'TimeoutError'))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await expect(upsertXeroContact(ctx, payload(), null)).resolves.toMatchObject({ id: 'xc-1' });
    expect(fetchMock.mock.calls.map((_c, i) => initOf(fetchMock, i).method)).toEqual(['GET', 'PUT', 'GET', 'POST']);
  });

  it('adopts after a duplicate ContactNumber refusal (a concurrent create won)', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Elements: [{ ValidationErrors: [{ Message: `The contact number ${NUMBER} is already assigned to another contact.` }] }] }, 400))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await expect(upsertXeroContact(ctx, payload(), null)).resolves.toMatchObject({ id: 'xc-1' });
  });

  const passThrough = (_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn();

  it('surfaces a throttled re-lookup as the throttle, not the original create error (T3-a)', async () => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'slot', retryAfterMs: 1000, throttleSource: 'local' });
    slotMock
      .mockImplementationOnce(passThrough)
      .mockImplementationOnce(passThrough)
      .mockImplementationOnce(async () => { throw refusal; });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Title: 'oops' }, 503));
    await expect(upsertXeroContact(ctx, payload(), null)).rejects.toBe(refusal);
    expect(fetchMock.mock.calls.map((_c, i) => initOf(fetchMock, i).method)).toEqual(['GET', 'PUT']);
  });

  it('a failed re-lookup after duplicate_name surfaces the lookup failure, not an unproven duplicate_name (T3-a)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Elements: [{ ValidationErrors: [{ Message: 'The contact name Acme Ltd is already assigned to another contact.' }] }] }, 400))
      .mockResolvedValueOnce(json({ Title: 'oops' }, 503));
    await expect(upsertXeroContact(ctx, payload(), null)).rejects.toMatchObject({ kind: 'transient', httpStatus: 503, operation: 'Xero contact lookup' });
    expect(fetchMock.mock.calls.map((_c, i) => initOf(fetchMock, i).method)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('rethrows the original transient when the re-lookup finds nothing (never a blind second create)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json({ Title: 'oops' }, 503))
      .mockResolvedValueOnce(json({ Contacts: [] }));
    await expect(upsertXeroContact(ctx, payload(), null)).rejects.toMatchObject({ kind: 'transient', httpStatus: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  const DUP_NAME = { Elements: [{ ValidationErrors: [{ Message: 'The contact name Acme Ltd is already assigned to another contact. The contact name must be unique across all active contacts.' }] }] };

  it('surfaces duplicate_name after one ContactNumber look misses — never a second create (Review Focus 2)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json(DUP_NAME, 400))
      .mockResolvedValueOnce(json({ Contacts: [] }));
    await expect(upsertXeroContact(ctx, payload(), null)).rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_name' });
    expect(fetchMock.mock.calls.map((_c, i) => initOf(fetchMock, i).method)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('adopts when the duplicate name belongs to our own earlier create (quorum 5)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Contacts: [] }))
      .mockResolvedValueOnce(json(DUP_NAME, 400))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }))
      .mockResolvedValueOnce(json({ Contacts: [contact()] }));
    await expect(upsertXeroContact(ctx, payload(), null)).resolves.toMatchObject({ id: 'xc-1' });
    expect(fetchMock.mock.calls.map((_c, i) => initOf(fetchMock, i).method)).toEqual(['GET', 'PUT', 'GET', 'POST']);
  });

  it.each(['ARCHIVED', 'GDPRREQUEST'])('a mapped contact whose update comes back %s is remote_archived (quorum 4)', async (status) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [contact({ ContactID: 'xc-9', ContactStatus: status })] }));
    await expect(upsertXeroContact(ctx, payload(), { remoteEntityId: 'xc-9', remoteSyncToken: null }))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_archived' });
  });

  it('a mapped contact Xero answers 404 for is not_found + remote_missing (quorum 6)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Title: 'Not Found' }, 404));
    await expect(upsertXeroContact(ctx, payload(), { remoteEntityId: 'gone', remoteSyncToken: null }))
      .rejects.toMatchObject({ kind: 'not_found', providerCode: 'remote_missing', httpStatus: 404 });
  });

  it('updates a mapped contact by ContactID with no lookup and no ContactNumber', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Contacts: [contact({ ContactID: 'xc-9' })] }));
    await upsertXeroContact(ctx, payload({ billAddr: undefined, phone: undefined, billingEmail: null }), { remoteEntityId: 'xc-9', remoteSyncToken: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Contacts/xc-9');
    expect(JSON.parse(initOf(fetchMock, 0).body as string)).toEqual({ Contacts: [{ ContactID: 'xc-9', Name: 'Acme Ltd' }] });
  });

  it.each([
    ['list', () => listXeroContacts(ctx)],
    ['get', () => getXeroContact(ctx, 'xc-1')],
    ['upsert', () => upsertXeroContact(ctx, payload(), null)],
  ])('propagates a limiter refusal untouched (%s)', async (_name, call) => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'slot', retryAfterMs: 1000, throttleSource: 'local' });
    slotMock.mockImplementationOnce(async () => { throw refusal; });
    await expect(call()).rejects.toBe(refusal);
  });
});
