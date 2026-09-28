import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('./accountingRateLimit', () => ({
  withProviderCallSlot: (_p: string, _s: unknown, _c: string, fn: () => unknown) => fn(),
  noteDailyRemaining: vi.fn(async () => {}),
}));

import {
  embedXeroPaymentMarker, extractXeroPaymentMarker, readXeroPaymentChanges, toChangeSetPaymentLine,
  xeroPaymentHumanReference, XERO_PAYMENT_REF_MAX, XERO_RECONCILE_PAGE_SIZE,
} from './xeroPayments';
import { buildPaymentPrivateNote } from './accountingPaymentMarker';
import { XERO_RATE_LIMIT } from './xeroProvider';
import type { AccountingConnection } from './accountingConnectionService';

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
});
