import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('./accountingRateLimit', () => ({
  withProviderCallSlot: (_p: string, _s: unknown, _c: string, fn: () => unknown) => fn(),
  noteDailyRemaining: vi.fn(async () => {}),
}));

import {
  createXeroPayment, deleteXeroPayment, embedXeroPaymentMarker, extractXeroPaymentMarker, readXeroPaymentChanges,
  toChangeSetPaymentLine, XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE, xeroPaymentHumanReference, xeroPaymentIdempotencyKey,
  xeroPaymentPreflight, XERO_PAYMENT_REF_MAX, XERO_RECONCILE_PAGE_SIZE,
} from './xeroPayments';
import { buildPaymentPrivateNote } from './accountingPaymentMarker';
import { XERO_RATE_LIMIT } from './xeroProvider';
import type { AccountingConnection } from './accountingConnectionService';
import type { AccountingPaymentPayload } from './types';

const PAY_ID = '0f3c6f4e-5a1b-4c2d-9e8f-7a6b5c4d3e2f';
const MARKER = buildPaymentPrivateNote(PAY_ID);
const TENANT = '11111111-2222-3333-4444-555555555555';
const INV = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ctx = { connectionId: 'conn-1', tenantId: TENANT, accessToken: 'at', rate: XERO_RATE_LIMIT };
const conn = (over: Partial<AccountingConnection> = {}) => ({
  id: 'conn-1', partnerId: 'p1', provider: 'xero', realmId: TENANT, accessToken: 'at',
  homeCurrency: 'GBP', createdAt: new Date('2026-09-01T00:00:00Z'), ...over,
}) as AccountingConnection;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const msDate = (iso: string) => `/Date(${Date.parse(iso)}+0000)/`;
const payment = (over: Record<string, unknown> = {}) => ({
  PaymentID: 'xp-1', PaymentType: 'ACCRECPAYMENT', Status: 'AUTHORISED', Date: msDate('2026-09-20T00:00:00Z'),
  Amount: 150.5, Reference: 'CHQ 1001', IsReconciled: false, UpdatedDateUTC: msDate('2026-09-20T10:00:00Z'),
  Invoice: { InvoiceID: INV, Type: 'ACCREC', CurrencyCode: 'GBP' }, ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('payment marker (refinement 14)', () => {
  it.each([
    [null, MARKER],
    ['', MARKER],
    ['  ', MARKER],
    ['pi_3PqRsT0123456789abcdefgh', `${MARKER} | pi_3PqRsT0123456789abcdefgh`],
  ])('embed(%j) → %j and extract recovers the id', (ref, embedded) => {
    expect(embedXeroPaymentMarker(ref, MARKER)).toBe(embedded);
    expect(extractXeroPaymentMarker(embedded)).toBe(PAY_ID);
  });

  it('recovers the id for a max-length reference, and caps the field (obligation 3)', () => {
    const ref = 'R'.repeat(XERO_PAYMENT_REF_MAX + 40);
    const embedded = embedXeroPaymentMarker(ref, MARKER);
    expect(embedded.length).toBe(MARKER.length + 3 + XERO_PAYMENT_REF_MAX);
    expect(extractXeroPaymentMarker(embedded)).toBe(PAY_ID);
  });

  it('a reference that itself contains the separator or another marker cannot move ownership', () => {
    const other = buildPaymentPrivateNote('99999999-8888-7777-6666-555555555555');
    expect(extractXeroPaymentMarker(embedXeroPaymentMarker(`a | ${other}`, MARKER))).toBe(PAY_ID);
  });

  it.each([
    [`Paid via ${MARKER}`],                               // mentions, does not start with, the marker
    [MARKER.toUpperCase()],                               // grammar is lowercase-uuid only
    [`${MARKER}x`],                                       // not followed by the separator
    ['CHQ 1001'],
    [null],
  ])('%j carries no Breeze claim', (text) => {
    expect(extractXeroPaymentMarker(text)).toBeNull();
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(extractXeroPaymentMarker(`  ${MARKER} | x \n`)).toBe(PAY_ID);
  });

  it('the human reference strips our marker, keeps a foreign reference whole, and clamps to 255', () => {
    expect(xeroPaymentHumanReference(`${MARKER} | pi_1`)).toBe('pi_1');
    expect(xeroPaymentHumanReference(MARKER)).toBeNull();
    expect(xeroPaymentHumanReference('CHQ 1001')).toBe('CHQ 1001');
    expect(xeroPaymentHumanReference('X'.repeat(300))).toHaveLength(255);
    expect(xeroPaymentHumanReference('   ')).toBeNull();
  });

  it.each([[`${MARKER} |`], [`${MARKER} | `]])('a bare trailing separator (%j) still claims, with no human reference', (text) => {
    expect(extractXeroPaymentMarker(text)).toBe(PAY_ID);
    expect(xeroPaymentHumanReference(text)).toBeNull();
  });

  it('a bare trailing separator does not loosen the anchor', () => {
    expect(extractXeroPaymentMarker(`Paid via ${MARKER} |`)).toBeNull();
  });
});

describe('toChangeSetPaymentLine (refinements 10, 12, 13, 20)', () => {
  it('maps an AR payment to one neutral line', () => {
    expect(toChangeSetPaymentLine(payment({ Reference: `${MARKER} | pi_1` }), conn())).toEqual({
      remoteInvoiceId: INV,
      remotePaymentId: 'xp-1',
      amountMinor: 15050,
      currency: 'GBP',
      txnDate: '2026-09-20',
      remotePaymentVersion: '2026-09-20T10:00:00.000Z',
      paymentMethodName: null,
      method: 'other',
      paymentRefNum: 'pi_1',
      breezePaymentId: PAY_ID,
    });
  });

  it('falls back to the connection home currency when the nested invoice omits it', () => {
    expect(toChangeSetPaymentLine(payment({ Invoice: { InvoiceID: INV } }), conn())?.currency).toBe('GBP');
  });

  it.each([
    ['a refund (AROVERPAYMENTPAYMENT)', { PaymentType: 'AROVERPAYMENTPAYMENT' }],
    ['a bill payment', { PaymentType: 'ACCPAYPAYMENT' }],
    ['a payment on a non-ACCREC document', { Invoice: { InvoiceID: INV, Type: 'ACCPAY' } }],
    ['a payment with no invoice', { Invoice: undefined }],
    ['a deleted payment (handled as a deletion, not a line)', { Status: 'DELETED' }],
    ['a payment with no id', { PaymentID: undefined }],
    ['a non-numeric amount', { Amount: 'abc' }],
  ])('skips %s', (_label, over) => {
    expect(toChangeSetPaymentLine(payment(over), conn())).toBeNull();
  });
});

describe('readXeroPaymentChanges (refinements 9, 11)', () => {
  const since = new Date('2026-09-20T09:00:00Z');
  let fetchMock: MockInstance<typeof fetch>;
  const urlOf = (i: number) => String(fetchMock.mock.calls[i]![0]);
  const headerOf = (i: number, h: string) => new Headers((fetchMock.mock.calls[i]![1] as RequestInit).headers).get(h);

  beforeEach(() => {
    fetchMock = vi.spyOn(globalThis, 'fetch');
  });

  it('reads AR payments and voided/deleted AR invoices since cursor − 5 min, in two calls', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [payment(), payment({ PaymentID: 'xp-2', Status: 'DELETED', UpdatedDateUTC: msDate('2026-09-20T11:00:00Z') })] }))
      .mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'inv-v', Type: 'ACCREC', Status: 'VOIDED', UpdatedDateUTC: msDate('2026-09-20T10:30:00Z') }] }));

    const changes = await readXeroPaymentChanges(ctx, conn(), since);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urlOf(0)).toBe('https://api.xero.com/api.xro/2.0/Payments?where=PaymentType%3D%3D%22ACCRECPAYMENT%22&order=UpdatedDateUTC%20ASC&page=1&pageSize=1000');
    expect(urlOf(1)).toBe('https://api.xero.com/api.xro/2.0/Invoices?Statuses=VOIDED%2CDELETED&where=Type%3D%3D%22ACCREC%22&order=UpdatedDateUTC%20ASC&page=1&pageSize=1000');
    expect(headerOf(0, 'if-modified-since')).toBe('2026-09-20T08:55:00');
    expect(headerOf(1, 'if-modified-since')).toBe('2026-09-20T08:55:00');
    expect(changes.payments.map((l) => l.remotePaymentId)).toEqual(['xp-1']);
    expect(changes.deletedPayments).toEqual(['xp-2']);
    expect(changes.unappliedPayments).toEqual([]);
    expect(changes.deletedInvoices).toEqual(['inv-v']);
    expect(changes.cursor.toISOString()).toBe('2026-09-20T11:00:00.000Z'); // newest UpdatedDateUTC read
    expect(changes.overflowed).toBe(false);
  });

  it('a first run (no cursor) reads from the connection creation', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [] })).mockResolvedValueOnce(json({ Invoices: [] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), null);
    expect(headerOf(0, 'if-modified-since')).toBe('2026-08-31T23:55:00');
    expect(changes.cursor.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('nothing changed (304 or empty) leaves the cursor where it was — never moves it backwards', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 })).mockResolvedValueOnce(json({ Invoices: [] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(changes.cursor.toISOString()).toBe(since.toISOString());
    expect(changes.payments).toEqual([]);
  });

  it('seeks: a full page is followed by page 1 again, from its last row − 1 s (never page=2)', async () => {
    const full = Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) =>
      payment({ PaymentID: `xp-${i}`, UpdatedDateUTC: msDate(`2026-09-20T10:00:${String(i % 60).padStart(2, '0')}Z`) }));
    full[full.length - 1] = payment({ PaymentID: 'xp-end', UpdatedDateUTC: msDate('2026-09-20T10:30:00Z') });
    fetchMock
      .mockResolvedValueOnce(json({ Payments: full }))
      .mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: 'last', UpdatedDateUTC: msDate('2026-09-20T12:00:00Z') })] }))
      .mockResolvedValueOnce(json({ Invoices: [] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(urlOf(1)).toContain('page=1');
    expect(urlOf(1)).not.toContain('page=2');
    expect(headerOf(1, 'if-modified-since')).toBe('2026-09-20T10:29:59');
    expect(changes.payments).toHaveLength(XERO_RECONCILE_PAGE_SIZE + 1);
    expect(changes.cursor.toISOString()).toBe('2026-09-20T12:00:00.000Z');
  });

  it('a row updated between two requests is not lost, and its later read wins (quorum finding 1)', async () => {
    const full = Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) =>
      payment({ PaymentID: `xp-${i}`, UpdatedDateUTC: msDate('2026-09-20T10:00:00Z') }));
    full[full.length - 1] = payment({ PaymentID: 'xp-end', UpdatedDateUTC: msDate('2026-09-20T10:10:00Z') });
    fetchMock
      .mockResolvedValueOnce(json({ Payments: full }))
      // xp-0 was deleted after the first read; 'unseen' was the row offset paging would have skipped.
      .mockResolvedValueOnce(json({ Payments: [
        payment({ PaymentID: 'unseen', UpdatedDateUTC: msDate('2026-09-20T10:11:00Z') }),
        payment({ PaymentID: 'xp-0', Status: 'DELETED', UpdatedDateUTC: msDate('2026-09-20T10:12:00Z') }),
      ] }))
      .mockResolvedValueOnce(json({ Invoices: [] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(changes.payments.map((l) => l.remotePaymentId)).toContain('unseen');
    expect(changes.payments.map((l) => l.remotePaymentId)).not.toContain('xp-0');
    expect(changes.deletedPayments).toEqual(['xp-0']);
  });

  it('pages inside the 5-minute overlap do not use up the progress budget (quorum finding 7)', async () => {
    // 5 full pages inside the overlap (≤ windowStart 09:00), then 6 past it: 11 full pages,
    // more than XERO_RECONCILE_MAX_REQUESTS, of which only the 6 count against it.
    const ends = ['08:55', '08:56', '08:57', '08:58', '08:59', '09:01', '09:02', '09:03', '09:04', '09:05', '09:06'];
    let n = 0;
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes('/Invoices')) return json({ Invoices: [] });
      if (n >= ends.length) return json({ Payments: [payment({ PaymentID: 'fresh', UpdatedDateUTC: msDate('2026-09-20T09:10:00Z') })] });
      const at = msDate(`2026-09-20T${ends[n]}:00Z`);
      const rows = Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) => payment({ PaymentID: `o${n}-${i}`, UpdatedDateUTC: at }));
      n += 1;
      return json({ Payments: rows });
    });
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/Payments'))).toHaveLength(ends.length + 1);
    expect(changes.overflowed).toBe(false);
    expect(changes.cursor.toISOString()).toBe('2026-09-20T09:10:00.000Z');
  });

  it('more than 10 full pages inside the overlap alone is no progress: overflowed, cursor held', async () => {
    let at = Date.parse('2026-09-20T08:55:00Z');       // 30 s steps, every page end ≤ windowStart (09:00)
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes('/Invoices')) return json({ Invoices: [] });
      const rows = Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) => payment({ PaymentID: `q${at}-${i}`, UpdatedDateUTC: `/Date(${at}+0000)/` }));
      at += 30_000;
      return json({ Payments: rows });
    });
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/Payments'))).toHaveLength(10); // overlap cap
    expect(changes.overflowed).toBe(true);
    expect(changes.cursor.toISOString()).toBe(since.toISOString());
  });

  it('a list that hits the request cap moves the cursor only to its last row, not to the other list\'s newest', async () => {
    let t = Date.parse('2026-09-20T09:30:00Z');
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/Invoices')) return json({ Invoices: [{ InvoiceID: 'v', Type: 'ACCREC', Status: 'VOIDED', UpdatedDateUTC: msDate('2026-09-20T23:00:00Z') }] });
      const rows = Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) => payment({ PaymentID: `p${t}-${i}`, UpdatedDateUTC: `/Date(${t}+0000)/` }));
      t += 60_000;
      return json({ Payments: rows });
    });
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/Payments'))).toHaveLength(10); // cap
    expect(changes.overflowed).toBe(false);
    expect(changes.cursor.toISOString()).toBe(new Date(Date.parse('2026-09-20T09:30:00Z') + 9 * 60_000).toISOString());
  });

  it('when both lists hit the cap, the cursor stops at the EARLIER capped list\'s last row', async () => {
    let tp = Date.parse('2026-09-20T09:30:00Z');
    let ti = Date.parse('2026-09-20T10:30:00Z');
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes('/Invoices')) {
        const rows = Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) => ({ InvoiceID: `v${ti}-${i}`, Type: 'ACCREC', Status: 'VOIDED', UpdatedDateUTC: `/Date(${ti}+0000)/` }));
        ti += 60_000;
        return json({ Invoices: rows });
      }
      const rows = Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) => payment({ PaymentID: `p${tp}-${i}`, UpdatedDateUTC: `/Date(${tp}+0000)/` }));
      tp += 60_000;
      return json({ Payments: rows });
    });
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/Invoices'))).toHaveLength(10);
    expect(changes.overflowed).toBe(false);
    expect(changes.cursor.toISOString()).toBe('2026-09-20T09:39:00.000Z'); // payments' last row, not invoices' 10:39
  });

  it('1,000 rows inside one second stall the list: overflowed, cursor held (the worker surfaces it)', async () => {
    fetchMock.mockImplementation(async (input) => String(input).includes('/Invoices')
      ? json({ Invoices: [] })
      : json({ Payments: Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) => payment({ PaymentID: `p-${i}`, UpdatedDateUTC: msDate('2026-09-20T10:00:00Z') })) }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(changes.overflowed).toBe(true);
    expect(changes.cursor.toISOString()).toBe(since.toISOString());
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/Payments'))).toHaveLength(2); // stopped, no spin
  });

  it('keeps DELETED ids unique and drops payments on bills and credit notes', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [
        payment({ PaymentID: 'd', Status: 'DELETED' }),
        payment({ PaymentID: 'd', Status: 'DELETED' }),
        payment({ PaymentID: 'bill', Invoice: { InvoiceID: INV, Type: 'ACCPAY' } }),
      ] }))
      .mockResolvedValueOnce(json({ Invoices: [{ InvoiceID: 'bill-v', Type: 'ACCPAY', Status: 'VOIDED' }] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(changes.deletedPayments).toEqual(['d']);
    expect(changes.payments).toEqual([]);
    expect(changes.deletedInvoices).toEqual([]);
  });

  it('a DELETED receipt with no Invoice is still a deletion (reversal keys on PaymentID alone)', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: 'gone', Status: 'DELETED', Invoice: undefined })] }))
      .mockResolvedValueOnce(json({ Invoices: [] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(changes.deletedPayments).toEqual(['gone']);
  });

  it('a DELETED payment on a bill (Invoice.Type ACCPAY) is not a deletion', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: 'bill-d', Status: 'DELETED', Invoice: { InvoiceID: INV, Type: 'ACCPAY' } })] }))
      .mockResolvedValueOnce(json({ Invoices: [] }));
    const changes = await readXeroPaymentChanges(ctx, conn(), since);
    expect(changes.deletedPayments).toEqual([]);
  });
});

describe('payment create (refinements 15, 17, 19)', () => {
  const XI = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const payload = (over: Partial<AccountingPaymentPayload> = {}): AccountingPaymentPayload => ({
    invoicePaymentId: PAY_ID, remoteCustomerId: 'xc-1', remoteInvoiceId: XI, amount: '107.00', currencyCode: 'GBP',
    txnDate: '2026-09-02', reference: 'pi_1', marker: MARKER, pushGeneration: 0, ...over,
  });
  const reference = `${MARKER} | pi_1`;
  const account = { defaultPaymentAccountRef: 'bank-acc-1' };
  const ours = (over: Record<string, unknown> = {}) => payment({ PaymentID: 'xp-ours', Amount: 107, Reference: reference, Invoice: { InvoiceID: XI, Type: 'ACCREC' }, ...over });
  let fetchMock: MockInstance<typeof fetch>;
  const callsOf = () => fetchMock.mock.calls.map(([u, init]) => `${(init as RequestInit)?.method ?? 'GET'} ${String(u).replace('https://api.xero.com/api.xro/2.0/', '')}`);

  beforeEach(() => { fetchMock = vi.spyOn(globalThis, 'fetch'); });

  it('the key names the request identity: stable per (tenant, payment, generation), ≤128 chars', () => {
    const k = xeroPaymentIdempotencyKey(TENANT, PAY_ID, 0);
    expect(k).toMatch(/^breeze-pay-[0-9a-f]{64}$/);
    expect(k.length).toBeLessThanOrEqual(128);
    expect(xeroPaymentIdempotencyKey(TENANT, PAY_ID, 0)).toBe(k);
    expect(xeroPaymentIdempotencyKey(TENANT, PAY_ID, 1)).not.toBe(k);
    expect(xeroPaymentIdempotencyKey('other-tenant', PAY_ID, 0)).not.toBe(k);
  });

  it('preflight: no bank account → the operator message; an account → null', () => {
    expect(xeroPaymentPreflight({ defaultPaymentAccountRef: null })).toBe(XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE);
    expect(xeroPaymentPreflight({ defaultPaymentAccountRef: '  ' })).toBe(XERO_PAYMENT_ACCOUNT_MISSING_MESSAGE);
    expect(xeroPaymentPreflight(account)).toBeNull();
  });

  it('looks up by invoice first, then PUTs one payment with the explicit key and the exact body', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Payments: [ours({ UpdatedDateUTC: msDate('2026-09-27T09:00:00Z') })] }));

    await expect(createXeroPayment(ctx, account, payload(), reference))
      .resolves.toEqual({ id: 'xp-ours', remoteVersion: '2026-09-27T09:00:00.000Z' });

    expect(callsOf()).toEqual([
      // xeroQuery uses encodeURIComponent, which leaves ( and ) literal.
      `GET Payments?where=Invoice.InvoiceID%3D%3Dguid(%22${XI}%22)&page=1&pageSize=1000`,
      'PUT Payments?summarizeErrors=true',
    ]);
    const put = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(new Headers(put.headers).get('idempotency-key')).toBe(xeroPaymentIdempotencyKey(TENANT, PAY_ID, 0));
    expect(JSON.parse(String(put.body))).toEqual({ Payments: [{
      Invoice: { InvoiceID: XI }, Account: { AccountID: 'bank-acc-1' }, Date: '2026-09-02', Amount: 107, Reference: reference,
    }] });
  });

  it('adopts instead of creating when our marker is already on the invoice (lost earlier response)', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [ours()] }));
    await expect(createXeroPayment(ctx, account, payload(), reference)).resolves.toMatchObject({ id: 'xp-ours' });
    expect(callsOf()).toEqual([expect.stringMatching(/^GET Payments\?where=/)]);
  });

  it('ignores foreign and other-invoice payments in the lookup (a re-owned push also ignores its DELETED predecessor)', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [
        ours({ PaymentID: 'gone', Status: 'DELETED' }),
        payment({ PaymentID: 'hand', Reference: 'CHQ 1', Invoice: { InvoiceID: XI } }),
        ours({ PaymentID: 'elsewhere', Invoice: { InvoiceID: 'ffffffff-ffff-ffff-ffff-ffffffffffff' } }),
      ] }))
      .mockResolvedValueOnce(json({ Payments: [ours({ PaymentID: 'new' })] }));
    await expect(createXeroPayment(ctx, account, payload({ pushGeneration: 2 }), reference)).resolves.toMatchObject({ id: 'new' });
  });

  it('two live hits refuse with duplicate_key (never guess)', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [ours({ PaymentID: 'a' }), ours({ PaymentID: 'b' })] }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
  });

  it('a live hit with a different amount is never adopted (quorum finding 6)', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [ours({ Amount: 99.99 })] }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
    expect(callsOf()).toHaveLength(1); // no PUT
  });

  it('a live hit in a different currency is never adopted (quorum finding 6)', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [ours({ Invoice: { InvoiceID: XI, Type: 'ACCREC', CurrencyCode: 'USD' } })] }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
    expect(callsOf()).toHaveLength(1); // no PUT
  });

  it('only a DELETED hit on a first push: refuse remote_deleted, never resurrect (quorum finding 4)', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [ours({ Status: 'DELETED' })] }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_deleted' });
    expect(callsOf()).toHaveLength(1);
  });

  it('only a DELETED hit on a RE-OWNED push (generation > 0): creates anew', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [ours({ Status: 'DELETED' })] }))
      .mockResolvedValueOnce(json({ Payments: [ours({ PaymentID: 'xp-new' })] }));
    await expect(createXeroPayment(ctx, account, payload({ pushGeneration: 1 }), reference)).resolves.toMatchObject({ id: 'xp-new' });
  });

  it('a lookup that cannot be enumerated in one page fails closed (quorum finding 5)', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: Array.from({ length: XERO_RECONCILE_PAGE_SIZE }, (_, i) => payment({ PaymentID: `p${i}`, Invoice: { InvoiceID: XI } })) }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'duplicate_key' });
    expect(callsOf()).toHaveLength(1);
  });

  it('a timed-out or 5xx create looks again and adopts what landed', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Message: 'Service unavailable' }, 503))
      .mockResolvedValueOnce(json({ Payments: [ours()] }));
    await expect(createXeroPayment(ctx, account, payload(), reference)).resolves.toMatchObject({ id: 'xp-ours' });
  });

  it('a key-reuse 400 (transient) looks again and adopts', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Elements: [{ ValidationErrors: [{ Message: 'Idempotency Key: breeze-pay-x is used with a different request.' }] }] }, 400))
      .mockResolvedValueOnce(json({ Payments: [ours()] }));
    await expect(createXeroPayment(ctx, account, payload(), reference)).resolves.toMatchObject({ id: 'xp-ours' });
  });

  it('a transient outcome with nothing found rethrows the original (retryable) error', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Message: 'Service unavailable' }, 503))
      .mockResolvedValueOnce(json({ Payments: [] }));
    await expect(createXeroPayment(ctx, account, payload(), reference)).rejects.toMatchObject({ kind: 'transient', httpStatus: 503 });
  });

  it('a 2xx element carrying ValidationErrors is a classified validation failure (refinement 19)', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Payments: [{ HasValidationErrors: true, ValidationErrors: [{ Message: 'Payment amount exceeds the amount outstanding on this document' }] }] }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'amount_exceeds_due' });
  });

  it('a 2xx create whose row is already DELETED is never recorded as created', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [] }))
      .mockResolvedValueOnce(json({ Payments: [ours({ Status: 'DELETED' })] }));
    await expect(createXeroPayment(ctx, account, payload(), reference))
      .rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_deleted' });
  });

  it('a non-GUID invoice id is refused before any call (it is interpolated into a where clause)', async () => {
    await expect(createXeroPayment(ctx, account, payload({ remoteInvoiceId: 'x")||true||("' }), reference))
      .rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses without a bank account, before any call (defence behind the core preflight)', async () => {
    await expect(createXeroPayment(ctx, { defaultPaymentAccountRef: null }, payload(), reference)).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('payment delete (refinement 18)', () => {
  const XP = '12345678-1234-1234-1234-123456789012';
  let fetchMock: MockInstance<typeof fetch>;
  beforeEach(() => { fetchMock = vi.spyOn(globalThis, 'fetch'); });

  it('reads, then POSTs Status DELETED without an idempotency key', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: XP })] }))
      .mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: XP, Status: 'DELETED' })] }));
    await expect(deleteXeroPayment(ctx, XP)).resolves.toBe('deleted');
    const post = fetchMock.mock.calls[1]!;
    expect(String(post[0])).toBe(`https://api.xero.com/api.xro/2.0/Payments/${XP}`);
    expect((post[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ Status: 'DELETED' });
    expect(new Headers((post[1] as RequestInit).headers).get('idempotency-key')).toBeNull();
  });

  it.each([
    ['a 404 on the read', () => fetchMock.mockResolvedValueOnce(json({ Message: 'not found' }, 404))],
    ['an already DELETED payment', () => fetchMock.mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: XP, Status: 'DELETED' })] }))],
  ])('%s is already_absent with no write', async (_l, arrange) => {
    arrange();
    await expect(deleteXeroPayment(ctx, XP)).resolves.toBe('already_absent');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an empty Payments list', { Payments: [] }],
    ['a null body', null],
  ])('a 2xx read with %s is transient, never already_absent (fail closed), and writes nothing', async (_l, body) => {
    fetchMock.mockResolvedValueOnce(json(body));
    await expect(deleteXeroPayment(ctx, XP)).rejects.toMatchObject({ kind: 'transient' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a reconciled payment is refused as remote_locked without writing', async () => {
    fetchMock.mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: XP, IsReconciled: true })] }));
    await expect(deleteXeroPayment(ctx, XP)).rejects.toMatchObject({ kind: 'validation', providerCode: 'remote_locked' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 404 on the POST (deleted in between) is already_absent', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ Payments: [payment({ PaymentID: XP })] }))
      .mockResolvedValueOnce(json({ Message: 'not found' }, 404));
    await expect(deleteXeroPayment(ctx, XP)).resolves.toBe('already_absent');
  });

  it('a non-GUID payment id is refused before any call', async () => {
    await expect(deleteXeroPayment(ctx, '181')).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
