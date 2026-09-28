import { afterEach, describe, expect, it, vi } from 'vitest';

const { slotMock } = vi.hoisted(() => ({
  slotMock: vi.fn((_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn()),
}));
vi.mock('./accountingRateLimit', async (orig) => ({
  ...(await orig<typeof import('./accountingRateLimit')>()),
  withProviderCallSlot: slotMock,
  noteDailyRemaining: vi.fn(async () => {}),
}));

import { createHash } from 'node:crypto';
import { AccountingProviderError } from './accountingProviderError';
import { getXeroItem, listXeroItems, toRemoteItem, upsertXeroItem, xeroItemCode, xeroItemName, xeroItemSuffix } from './xeroItems';
import type { AccountingItemPayload } from './types';

const ctx = {
  connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at',
  rate: { perConnection: { limit: 60, windowSeconds: 60 }, maxConcurrentPerConnection: 5, appWide: null, dailyPerConnection: null },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const urlOf = (fetchMock: ReturnType<typeof vi.spyOn>, i: number) => (fetchMock.mock.calls[i] as [string, RequestInit])[0];
const initOf = (fetchMock: ReturnType<typeof vi.spyOn>, i: number) => (fetchMock.mock.calls[i] as [string, RequestInit])[1];

const ITEM = '11111111-2222-4333-8444-555555555555';
const H = createHash('sha256').update(ITEM).digest('hex').slice(0, 10);
const TAX = { taxCodeRef: 'OUTPUT2', exemptTaxCodeRef: 'EXEMPTOUTPUT' };
const ALL_ITEMS_URL = 'https://api.xero.com/api.xro/2.0/Items?unitdp=4';
const payload = (over: Partial<AccountingItemPayload> = {}): AccountingItemPayload => ({
  catalogItemId: ITEM, name: 'Managed Firewall', sku: 'FW-100', description: 'Per site, monthly',
  type: 'Service', unitPrice: '49.9950', currencyCode: 'GBP', taxable: true, active: true, incomeAccountRef: '200', ...over,
});
const xitem = (over: Record<string, unknown> = {}) => ({
  ItemID: 'xi-1', Code: `fw-100-${H}`, Name: 'Managed Firewall', Description: 'Per site, monthly', IsSold: true,
  SalesDetails: { UnitPrice: 49.995, AccountCode: '200', TaxType: 'OUTPUT2' }, UpdatedDateUTC: '/Date(1790000000000+0000)/', ...over,
});
const createBody = (code: string) => ({ Items: [{
  Code: code, IsPurchased: false, Name: 'Managed Firewall', Description: 'Per site, monthly', IsSold: true,
  SalesDetails: { UnitPrice: 49.995, AccountCode: '200', TaxType: 'OUTPUT2' },
}] });
const methods = (fetchMock: ReturnType<typeof vi.spyOn>) => fetchMock.mock.calls.map((_c: unknown, i: number) => initOf(fetchMock, i).method);
const duplicateCode = () => json({ Elements: [{ ValidationErrors: [{ Message: `Item code 'fw-100-${H}' already exists` }] }] }, 400);

afterEach(() => { vi.restoreAllMocks(); slotMock.mockClear(); });

describe('item codes and names', () => {
  it('builds prefix-<10 hex> from the SKU, else the name, within 30 chars', () => {
    expect(xeroItemSuffix(ITEM)).toBe(H);
    expect(xeroItemCode(payload())).toBe(`fw-100-${H}`);
    expect(xeroItemCode(payload({ sku: undefined }))).toBe(`managed-firewall-${H}`);
    // prefix is 19 chars: 'microsoft' (9) + '-365-' (5) + 'busin' (5)
    expect(xeroItemCode(payload({ sku: undefined, name: 'Microsoft 365 Business Premium (annual)' }))).toBe(`microsoft-365-busin-${H}`);
  });
  it.each([
    ['Microsoft 365 Business Premium (annual)'], ['★★★'], ['Café Wi-Fi'], ['x'.repeat(200)], ['  --  '],
  ])('never exceeds 30 chars and always ends in -<suffix> (%s)', (name) => {
    const code = xeroItemCode(payload({ sku: undefined, name }));
    expect(code.length).toBeLessThanOrEqual(30);
    expect(code.endsWith(`-${H}`)).toBe(true);
    expect(code).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
  it('falls back to "item" and strips accents', () => {
    expect(xeroItemCode(payload({ sku: undefined, name: '★★★' }))).toBe(`item-${H}`);
    expect(xeroItemCode(payload({ sku: undefined, name: 'Café Wi-Fi' }))).toBe(`cafe-wi-fi-${H}`);
  });
  it('truncates names to 50', () => {
    expect(xeroItemName(`  ${'N'.repeat(80)} `)).toHaveLength(50);
  });
});

describe('toRemoteItem', () => {
  it('maps Code to sku and UpdatedDateUTC to an ISO version', () => {
    expect(toRemoteItem(xitem())).toEqual({
      id: 'xi-1', displayName: 'Managed Firewall', sku: `fw-100-${H}`, description: 'Per site, monthly',
      unitPrice: 49.995, active: true, remoteVersion: new Date(1790000000000).toISOString(),
    });
    expect(toRemoteItem(xitem({ IsSold: false }))).toMatchObject({ active: false });
    expect(toRemoteItem(xitem({ ItemID: undefined }))).toBeNull();
  });
});

describe('listXeroItems / getXeroItem', () => {
  it('reads all items once with unitdp=4 and filters by query client-side', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ Items: [xitem(), xitem({ ItemID: 'xi-2', Code: 'AV-1', Name: 'Antivirus' })] }));
    await expect(listXeroItems(ctx)).resolves.toHaveLength(2);
    await expect(listXeroItems(ctx, 'fire')).resolves.toEqual([expect.objectContaining({ id: 'xi-1' })]);
    await expect(listXeroItems(ctx, 'av-1')).resolves.toEqual([expect.objectContaining({ id: 'xi-2' })]);
    expect(urlOf(fetchMock, 0)).toBe(ALL_ITEMS_URL);
  });
  it('getXeroItem returns null on 404', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 404));
    await expect(getXeroItem(ctx, 'xi-9')).resolves.toBeNull();
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Items/xi-9?unitdp=4');
  });
});

describe('upsertXeroItem', () => {
  it('creates under prefix-<suffix> after the suffix look misses', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'other', Code: 'AV-1', Name: 'Antivirus' })] }))
      .mockResolvedValueOnce(json({ Items: [xitem()] }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).resolves.toMatchObject({ id: 'xi-1', remoteVersion: new Date(1790000000000).toISOString() });
    expect(urlOf(fetchMock, 0)).toBe(ALL_ITEMS_URL);
    expect(urlOf(fetchMock, 1)).toBe(ALL_ITEMS_URL);
    expect(methods(fetchMock)).toEqual(['GET', 'PUT']);
    expect(JSON.parse(initOf(fetchMock, 1).body as string)).toEqual(createBody(`fw-100-${H}`));
  });

  it('never adopts an MSP item that only shares the SKU (Review Focus 3)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'msp', Code: 'FW-100', Name: 'Managed Firewall' })] }))
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'xi-new' })] }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).resolves.toMatchObject({ id: 'xi-new' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT']);
    expect(fetchMock.mock.calls.some((_c, i) => urlOf(fetchMock, i).includes('/Items/msp'))).toBe(false);
  });

  it('a retry after a rename adopts by suffix and keeps the existing Code (Review Focus 3)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'xi-ours', Code: `old-name-${H.toUpperCase()}`, Name: 'Old name' })] }))
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'xi-ours' })] }));
    await upsertXeroItem(ctx, payload({ name: 'Managed Firewall', sku: 'FW-200' }), null, TAX);
    expect(methods(fetchMock)).toEqual(['GET', 'POST']);
    expect(urlOf(fetchMock, 1)).toBe('https://api.xero.com/api.xro/2.0/Items/xi-ours?unitdp=4');
    const sent = JSON.parse(initOf(fetchMock, 1).body as string).Items[0];
    expect(sent).toMatchObject({ ItemID: 'xi-ours', Code: `old-name-${H.toUpperCase()}`, Name: 'Managed Firewall' });
    expect(sent).not.toHaveProperty('IsPurchased');
  });

  it('two suffix hits are refused with duplicate_key and nothing is written (Review Focus 3)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Items: [
      xitem({ ItemID: 'a', Code: `x-${H}` }), xitem({ ItemID: 'b', Code: `y-${H}` }),
    ] }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adopts after a timed-out create whose item did land', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockRejectedValueOnce(new DOMException('t', 'TimeoutError'))
      .mockResolvedValueOnce(json({ Items: [xitem()] }))
      .mockResolvedValueOnce(json({ Items: [xitem()] }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).resolves.toMatchObject({ id: 'xi-1' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT', 'GET', 'POST']);
  });

  it('adopts after a duplicate_key create whose code a peer landed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockResolvedValueOnce(duplicateCode())
      .mockResolvedValueOnce(json({ Items: [xitem()] }))
      .mockResolvedValueOnce(json({ Items: [xitem()] }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).resolves.toMatchObject({ id: 'xi-1' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT', 'GET', 'POST']);
  });

  it('rethrows the original transient when the re-look finds nothing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockResolvedValueOnce(json({ Title: 'oops' }, 503))
      .mockResolvedValueOnce(json({ Items: [] }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).rejects.toMatchObject({ kind: 'transient', httpStatus: 503 });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT', 'GET']);
  });

  const passThrough = (_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn();

  it('surfaces a throttled re-look as the throttle, not the original create error (T3-a)', async () => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'slot', retryAfterMs: 1000, throttleSource: 'local' });
    slotMock
      .mockImplementationOnce(passThrough)
      .mockImplementationOnce(passThrough)
      .mockImplementationOnce(async () => { throw refusal; });
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockResolvedValueOnce(json({ Title: 'oops' }, 503));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).rejects.toBe(refusal);
    expect(methods(fetchMock)).toEqual(['GET', 'PUT']);
  });

  it('a failed re-look after duplicate_key surfaces the look failure (T3-a)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockResolvedValueOnce(duplicateCode())
      .mockResolvedValueOnce(json({ Title: 'oops' }, 503));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).rejects.toMatchObject({ kind: 'transient', httpStatus: 503, operation: 'Xero item lookup' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('uses the exempt TaxType for a non-taxable item and omits a null one', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] })).mockResolvedValueOnce(json({ Items: [xitem()] }))
      .mockResolvedValueOnce(json({ Items: [] })).mockResolvedValueOnce(json({ Items: [xitem()] }));
    await upsertXeroItem(ctx, payload({ taxable: false }), null, TAX);
    expect(JSON.parse(initOf(fetchMock, 1).body as string).Items[0].SalesDetails.TaxType).toBe('EXEMPTOUTPUT');
    await upsertXeroItem(ctx, payload({ taxable: false }), null, { taxCodeRef: 'OUTPUT2', exemptTaxCodeRef: null });
    expect(JSON.parse(initOf(fetchMock, 3).body as string).Items[0].SalesDetails).not.toHaveProperty('TaxType');
  });

  it('updates a mapped item by reading it first and posting back its own Code', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'xi-7', Code: 'MSP-OWN' })] }))
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'xi-7' })] }));
    await upsertXeroItem(ctx, payload(), { remoteEntityId: 'xi-7', remoteSyncToken: null }, TAX);
    expect(urlOf(fetchMock, 0)).toBe('https://api.xero.com/api.xro/2.0/Items/xi-7?unitdp=4');
    expect(urlOf(fetchMock, 1)).toBe('https://api.xero.com/api.xro/2.0/Items/xi-7?unitdp=4');
    expect(methods(fetchMock)).toEqual(['GET', 'POST']);
    expect(initOf(fetchMock, 1).headers).not.toHaveProperty('Idempotency-Key');
    const sent = JSON.parse(initOf(fetchMock, 1).body as string).Items[0];
    expect(sent).toMatchObject({ ItemID: 'xi-7', Code: 'MSP-OWN', Name: 'Managed Firewall', IsSold: true });
    expect(sent).not.toHaveProperty('IsPurchased');
  });

  it('carries a request-derived Idempotency-Key on the create only', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockResolvedValueOnce(json({ Items: [xitem()] }));
    await upsertXeroItem(ctx, payload(), null, TAX);
    expect(initOf(fetchMock, 0).headers).not.toHaveProperty('Idempotency-Key');
    expect((initOf(fetchMock, 1).headers as Record<string, string>)['Idempotency-Key']).toMatch(/^breeze-[0-9a-f]{64}$/);
  });

  it('a mapped item deleted in Xero is not_found + remote_missing — never silently re-created (quorum 6)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 404));
    await expect(upsertXeroItem(ctx, payload(), { remoteEntityId: 'gone', remoteSyncToken: null }, TAX))
      .rejects.toMatchObject({ kind: 'not_found', providerCode: 'remote_missing' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a mapped item deleted between the read and the update is not_found + remote_missing', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [xitem({ ItemID: 'xi-7' })] }))
      .mockResolvedValueOnce(json({}, 404));
    await expect(upsertXeroItem(ctx, payload(), { remoteEntityId: 'xi-7', remoteSyncToken: null }, TAX))
      .rejects.toMatchObject({ kind: 'not_found', providerCode: 'remote_missing' });
  });

  it('refuses a non-numeric unit price before any call', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(upsertXeroItem(ctx, payload({ unitPrice: 'abc' }), null, TAX)).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces insufficient_scope from the create and never retries it (Review Focus 5)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Items: [] }))
      .mockResolvedValueOnce(new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer error="insufficent_scope"' } }));
    await expect(upsertXeroItem(ctx, payload(), null, TAX)).rejects.toMatchObject({ kind: 'validation', providerCode: 'insufficient_scope' });
    expect(methods(fetchMock)).toEqual(['GET', 'PUT']);
  });

  it.each([
    ['list', () => listXeroItems(ctx)],
    ['get', () => getXeroItem(ctx, 'xi-1')],
    ['upsert', () => upsertXeroItem(ctx, payload(), null, TAX)],
  ])('propagates a limiter refusal untouched (%s)', async (_name, call) => {
    const refusal = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'slot', retryAfterMs: 1000, throttleSource: 'local' });
    slotMock.mockImplementationOnce(async () => { throw refusal; });
    await expect(call()).rejects.toBe(refusal);
  });
});
