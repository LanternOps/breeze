/**
 * Spec W01 / Codex quorum finding 1: QBO requestids are BYTE-IDENTICAL to
 * pre-W01. A create accepted by Intuit before a deploy, whose response was lost,
 * is retried after the deploy; only an identical requestid makes Intuit replay
 * the original instead of booking a duplicate in the customer's QuickBooks.
 * Changing any expected string below is a production money bug, not a refactor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../sentry', () => ({ captureException: vi.fn() }));
// Xero W01: the rate-limit call slot is a passthrough here (limiter has its own suite).
vi.mock('./accountingRateLimit', () => ({
  withProviderCallSlot: (_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn(),
}));
import { quickbooksProvider } from './quickbooksProvider';
import type { AccountingConnection } from './accountingConnectionService';

const conn = {
  id: 'c1', partnerId: 'p1', provider: 'quickbooks', realmId: 'realm123', accessToken: 'tok', refreshToken: 'r',
  accessTokenExpiresAt: new Date(Date.now() + 3_600_000), refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
  environment: 'sandbox', homeCurrency: 'USD', multiCurrencyEnabled: null, defaultIncomeAccountRef: null,
  defaultTaxCodeRef: null, pushMode: 'auto', status: 'connected', createdAt: null, updatedAt: null, lastError: null,
  realmIdFingerprint: null, pullPayments: true, pushPayments: true, lastReconcileAt: null, cdcCursor: null,
} as AccountingConnection;

function requestIdOf(fetchMock: ReturnType<typeof vi.spyOn>, call = 0): string | null {
  return new URL(String((fetchMock.mock.calls[call] as unknown[])[0])).searchParams.get('requestid');
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

afterEach(() => vi.restoreAllMocks());

describe('QuickBooks requestid pins (Xero W01)', () => {
  it('invoice create: requestid = invoiceId', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ Invoice: { Id: '9', SyncToken: '0', TotalAmt: 107, TxnTaxDetail: { TotalTax: 7 } } }));
    await quickbooksProvider.pushInvoice(conn, {
      invoiceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', docNumber: 'INV-1', txnDate: '2026-09-01', dueDate: null,
      customerRef: { id: '55' }, currencyCode: 'USD', subtotal: '100.00', taxTotal: '7.00', total: '107.00',
      lines: [{ invoiceLineId: 'l1', description: 'x', quantity: '1.00', unitPrice: '100.00', lineTotal: '100.00', taxable: true }],
      mapping: null,
    }, []);
    expect(requestIdOf(f)).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it.each([
    [0, '11111111-2222-3333-4444-555555555555'],
    [1, '11111111-2222-3333-4444-555555555555:g1'],
    [7, '11111111-2222-3333-4444-555555555555:g7'],
  ])('payment create at generation %i: requestid = %s', async (pushGeneration, expected) => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ Payment: { Id: '77', SyncToken: '0' } }));
    await quickbooksProvider.createPayment(conn, {
      invoicePaymentId: '11111111-2222-3333-4444-555555555555', remoteCustomerId: '55', remoteInvoiceId: '9',
      amount: '10.00', currencyCode: 'USD', txnDate: '2026-09-01', reference: null,
      marker: 'Breeze payment 11111111-2222-3333-4444-555555555555', pushGeneration,
    });
    expect(requestIdOf(f)).toBe(expected);
  });

  it('customer create: requestid = customer-<organizationId>', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ Customer: { Id: '5', SyncToken: '0' } }));
    await quickbooksProvider.upsertCustomer(conn, {
      organizationId: 'org-1', displayName: 'Acme', billingEmail: null, taxId: null, currencyCode: 'USD',
    }, null);
    expect(requestIdOf(f)).toBe('customer-org-1');
  });

  it('item create: requestid = item-<catalogItemId>', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(ok({ Item: { Id: '6', SyncToken: '0' } }));
    await quickbooksProvider.upsertItem(conn, {
      catalogItemId: 'item-1', name: 'Support', description: null, type: 'Service', unitPrice: '10.00',
      currencyCode: 'USD', taxable: true, active: true, incomeAccountRef: '1',
    }, null);
    expect(requestIdOf(f)).toBe('item-item-1');
  });
});
