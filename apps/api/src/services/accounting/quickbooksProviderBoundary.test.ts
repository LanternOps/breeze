import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The QuickBooks provider's error BOUNDARY (Xero W01), end to end from a real
 * fetch reply. The core coordinators branch on `kind` only, and their tests
 * inject pre-translated fixtures — so if a public method ever lost its
 * `boundary()` wrapper, every core test would stay green while a revoked token
 * retried forever (no `reauth`) and a payment-linked void went back to five
 * retries (no `payment_linked`, #5180). These tests start from the wire.
 */
const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: captureExceptionMock }));
// Xero W01: the rate-limit call slot is a passthrough here (limiter has its own suite).
vi.mock('./accountingRateLimit', () => ({
  withProviderCallSlot: (_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn(),
}));

import { QuickbooksProvider, quickbooksProvider } from './quickbooksProvider';
import { AccountingProviderError } from './accountingProviderError';
import type { AccountingConnection } from './accountingConnectionService';

function conn(overrides: Partial<AccountingConnection> = {}): AccountingConnection {
  return {
    id: 'c1', partnerId: 'p1', provider: 'quickbooks',
    realmId: 'realm123', accessToken: 'tok', refreshToken: 'r',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    environment: 'sandbox', homeCurrency: 'USD', multiCurrencyEnabled: null,
    defaultIncomeAccountRef: null, defaultTaxCodeRef: null,
    defaultExemptTaxCodeRef: null, defaultPaymentAccountRef: null, providerConnectionRef: null,
    pushMode: 'auto', status: 'connected',
    createdAt: null, updatedAt: null, lastError: null,
    realmIdFingerprint: null, pullPayments: true, pushPayments: true, lastReconcileAt: null, cdcCursor: null,
    ...overrides,
  };
}

async function rejectionOf(p: Promise<unknown>): Promise<AccountingProviderError> {
  return p.then(
    () => { throw new Error('expected the provider call to reject'); },
    (e: unknown) => e as AccountingProviderError,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('QuickbooksProvider error boundary', () => {
  it('refresh(): a 400 invalid_grant token response rejects as kind reauth', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Token invalid' }),
      { status: 400 },
    ));

    const err = await rejectionOf(quickbooksProvider.refresh('revoked-rt'));

    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err.kind).toBe('reauth');
    expect(err.provider).toBe('quickbooks');
    expect(err.status).toBe(400);
  });

  // F6 (PR #7197 review): a throttled token endpoint often answers 429 with an
  // empty or HTML body. It must still classify as a (provider) throttle rather
  // than dying in JSON.parse as an unclassified transient.
  it.each([
    ['an empty body', () => new Response('', { status: 429 }), 60_000],
    ['a JSON body', () => new Response('{"error":"throttled"}', { status: 429 }), 60_000],
    ['an HTML body with Retry-After: 7', () => new Response('<html><body>Too Many Requests</body></html>', {
      status: 429, headers: { 'Retry-After': '7' },
    }), 7_000],
  ])('refresh(): a 429 with %s rejects as a provider rate_limited with its Retry-After', async (_label, reply, retryAfterMs) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(reply());

    const err = await rejectionOf(quickbooksProvider.refresh('r'));

    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err).toMatchObject({ kind: 'rate_limited', status: 429, retryAfterMs, throttleSource: 'provider' });
  });

  it('refresh(): a NON-429 non-JSON token reply keeps its pre-W01 behaviour (a raw parse failure, transient)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 502 }));

    const err = await rejectionOf(quickbooksProvider.refresh('r'));

    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err.kind).toBe('transient');
    expect(err.status).toBeUndefined();
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });

  it('voidInvoice(): a payment-linked 6000 fault rejects as kind payment_linked', async () => {
    const detail = 'Business Validation Error: You cannot void this invoice because it has payments applied to it.';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ Fault: { Error: [{ code: '6000', Message: 'Business Validation Error', Detail: detail }] } }),
      { status: 400 },
    ));

    const err = await rejectionOf(quickbooksProvider.voidInvoice(
      conn(),
      { invoiceId: 'inv-1', docNumber: 'INV-1', currencyCode: 'USD' },
      { remoteEntityId: '310', remoteSyncToken: '4' },
    ));

    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err.kind).toBe('payment_linked');
    expect(err.providerMessage).toBe('Business Validation Error');
    expect(err.telemetryTags).toEqual({ qbo_fault_code: '6000' });
  });

  it('pushInvoice(): a plain 500 rejects as kind transient and keeps the original message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream exploded', { status: 500 }));

    const err = await rejectionOf(quickbooksProvider.pushInvoice(conn(), {
      invoiceId: 'inv-1', docNumber: 'INV-1', txnDate: '2026-09-01', dueDate: '2026-09-15',
      customerRef: { id: '55' }, currencyCode: 'USD',
      subtotal: '100.00', taxTotal: '7.00', total: '107.00',
      lines: [{
        invoiceLineId: 'l1', description: 'Onsite support',
        quantity: '2.00', unitPrice: '50.00', lineTotal: '100.00', taxable: true,
      }],
      mapping: null,
    }, []));

    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err.kind).toBe('transient');
    expect(err.message).toBe('QuickBooks invoice push failed with 500');
    expect(err.status).toBe(500);
  });
});

/**
 * EVERY public async method must be wrapped (review finding, Xero W01). The
 * three tests above pin three methods' kinds; this pins the wrapper itself on
 * all of them, so a new or edited method that forgets `boundary()` leaks a raw
 * QBO error the core would treat as `transient` (an `invalid_grant` would never
 * mark reauth).
 */
describe('QuickbooksProvider boundary covers every public async method', () => {
  const qboFault = () => new Response(
    JSON.stringify({ Fault: { Error: [{ code: '6000', Message: 'Business Validation Error', Detail: 'rejected' }] } }),
    { status: 400 },
  );

  const invoicePayload = {
    invoiceId: 'inv-1', docNumber: 'INV-1', txnDate: '2026-09-01', dueDate: '2026-09-15',
    customerRef: { id: '55' }, currencyCode: 'USD',
    subtotal: '100.00', taxTotal: '7.00', total: '107.00',
    lines: [{
      invoiceLineId: 'l1', description: 'Onsite support',
      quantity: '2.00', unitPrice: '50.00', lineTotal: '100.00', taxable: true,
    }],
    mapping: null,
  };

  /** Minimal-but-valid calls: each one reaches `fetch` and then meets the 400 fault. */
  const CALLS: Record<string, (p: QuickbooksProvider) => Promise<unknown>> = {
    exchangeCode: (p) => p.exchangeCode('code', 'realm123'),
    refresh: (p) => p.refresh('rt'),
    listRemoteCustomers: (p) => p.listRemoteCustomers(conn()),
    listRemoteItems: (p) => p.listRemoteItems(conn()),
    fetchRealmSettings: (p) => p.fetchRealmSettings(conn()),
    listRemoteIncomeAccounts: (p) => p.listRemoteIncomeAccounts(conn()),
    upsertCustomer: (p) => p.upsertCustomer(conn(), {
      organizationId: 'org-1', displayName: 'Acme', billingEmail: null, taxId: null, currencyCode: 'USD',
    }, null),
    upsertItem: (p) => p.upsertItem(conn(), {
      catalogItemId: 'item-1', name: 'Support', description: null, type: 'Service',
      unitPrice: '50.00', currencyCode: 'USD', taxable: true, active: true, incomeAccountRef: '79',
    }, null),
    pushInvoice: (p) => p.pushInvoice(conn(), invoicePayload, []),
    voidInvoice: (p) => p.voidInvoice(
      conn(),
      { invoiceId: 'inv-1', docNumber: 'INV-1', currencyCode: 'USD' },
      { remoteEntityId: '310', remoteSyncToken: '4' },
    ),
    createPayment: (p) => p.createPayment(conn(), {
      invoicePaymentId: '11111111-1111-1111-1111-111111111111', remoteCustomerId: '55', remoteInvoiceId: '310',
      amount: '10.00', currencyCode: 'USD', txnDate: '2026-09-01', reference: null,
      marker: 'Breeze payment 11111111-1111-1111-1111-111111111111', pushGeneration: 0,
    }),
    deletePayment: (p) => p.deletePayment(conn(), { remotePaymentId: '900', remoteVersion: '0' }),
    postFeeEntry: (p) => p.postFeeEntry(conn(), {
      operationId: '75c63cda-0d5c-41dc-978b-97efdd340abf', remoteCustomerId: 'customer-1', amount: '1.50',
      currencyCode: 'USD', txnDate: '2026-10-01', direction: 'receipt', incomeRef: 'fee-item',
      bankAccountRef: 'bank-1', exemptTaxCodeRef: null, firstSubmittedAt: new Date().toISOString(),
    }),
    reconcileChanges: (p) => p.reconcileChanges(conn(), null),
  };

  /** Private async helpers the wrappers call — never reachable from the core. */
  const PRIVATE_ASYNC_HELPERS = new Set([
    'boundary', 'upsertEntity', 'readEntitySyncToken', 'readInvoiceSyncToken', 'readPaymentSyncToken',
    'postPaymentDelete', 'fetchCdcWindow', 'backfillOverflowedEntity', 'qboRequest', 'requestTokens',
  ]);

  it('the wrapped-method list is exactly the class\'s public async methods (a new one must be added here)', () => {
    const reflected = Object.getOwnPropertyNames(QuickbooksProvider.prototype).filter((name) => {
      if (name === 'constructor' || name.endsWith('Raw') || PRIVATE_ASYNC_HELPERS.has(name)) return false;
      const fn = (QuickbooksProvider.prototype as unknown as Record<string, unknown>)[name];
      return typeof fn === 'function' && fn.constructor.name === 'AsyncFunction';
    });
    expect(reflected.sort()).toEqual(Object.keys(CALLS).sort());
    expect(Object.keys(CALLS)).toHaveLength(14);
  });

  it.each(Object.keys(CALLS))('%s(): a 400 QBO fault rejects as an AccountingProviderError', async (method) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => qboFault());
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await rejectionOf(CALLS[method]!(new QuickbooksProvider()));

    expect(fetchSpy).toHaveBeenCalled();
    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err.provider).toBe('quickbooks');
  });
});
