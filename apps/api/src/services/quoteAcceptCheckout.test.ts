import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createInvoicePayLink: vi.fn(),
  isPartnerOnlinePaymentAvailable: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('./invoiceCheckout', () => ({ createInvoicePayLink: mocks.createInvoicePayLink }));
vi.mock('./partnerStripe', () => ({ isPartnerOnlinePaymentAvailable: mocks.isPartnerOnlinePaymentAvailable }));
vi.mock('./sentry', () => ({ captureException: mocks.captureException, captureMessage: mocks.captureMessage }));
vi.mock('./portalUrl', () => ({ portalBase: () => 'https://portal.example.com/portal' }));

import {
  resolveAcceptCheckoutUrl, isPayOnAcceptAvailable, publicInvoiceCheckoutUrls, ACCEPT_CHECKOUT_TIMEOUT_MS,
} from './quoteAcceptCheckout';
import { InvoiceServiceError } from './invoiceTypes';

const RES = { invoiceId: 'inv-1', invoiceIssued: true, quote: { partnerId: 'p-1', orgId: 'o-1' } };
const INVOICE_URL = 'https://portal.example.com/portal/invoice/tok';
const CLIENT = { ip: '203.0.113.9', userAgent: 'UA' };

describe('publicInvoiceCheckoutUrls', () => {
  it('returns session-id-only urls that resolve through /invoice/return', () => {
    expect(publicInvoiceCheckoutUrls()).toEqual({
      successUrl: 'https://portal.example.com/portal/invoice/return?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://portal.example.com/portal/invoice/return?canceled=1&session_id={CHECKOUT_SESSION_ID}',
      idempotencySuffix: '_pub',
    });
  });
});

describe('isPayOnAcceptAvailable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('follows the partner online-payment connection', async () => {
    mocks.isPartnerOnlinePaymentAvailable.mockResolvedValue(false);
    expect(await isPayOnAcceptAvailable('p-1')).toBe(false);
    mocks.isPartnerOnlinePaymentAvailable.mockResolvedValue(true);
    expect(await isPayOnAcceptAvailable('p-1')).toBe(true);
    expect(mocks.isPartnerOnlinePaymentAvailable).toHaveBeenCalledWith('p-1');
  });
});

describe('resolveAcceptCheckoutUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isPartnerOnlinePaymentAvailable.mockResolvedValue(true);
    mocks.createInvoicePayLink.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/x' });
  });
  afterEach(() => vi.useRealTimers());

  it('mints a public-link-family session for the invoice as an org-scoped anonymous actor', async () => {
    expect(await resolveAcceptCheckoutUrl(RES, INVOICE_URL, CLIENT)).toBe('https://checkout.stripe.com/c/pay/x');
    expect(mocks.createInvoicePayLink).toHaveBeenCalledWith(
      'inv-1',
      { userId: null, partnerId: null, accessibleOrgIds: ['o-1'] },
      { ...publicInvoiceCheckoutUrls(), ip: '203.0.113.9', userAgent: 'UA' },
    );
  });

  it('does nothing when no invoice was issued (recurring-only / $0)', async () => {
    expect(await resolveAcceptCheckoutUrl({ ...RES, invoiceIssued: false }, null, CLIENT)).toBeNull();
    expect(mocks.createInvoicePayLink).not.toHaveBeenCalled();
  });

  it('does nothing without a durable invoice url to return to (payDeferred)', async () => {
    expect(await resolveAcceptCheckoutUrl(RES, null, CLIENT)).toBeNull();
    expect(mocks.createInvoicePayLink).not.toHaveBeenCalled();
  });

  it('does nothing when the partner cannot take online payment', async () => {
    mocks.isPartnerOnlinePaymentAvailable.mockResolvedValue(false);
    expect(await resolveAcceptCheckoutUrl(RES, INVOICE_URL, CLIENT)).toBeNull();
    expect(mocks.createInvoicePayLink).not.toHaveBeenCalled();
  });

  it.each([
    ['NOTHING_TO_PAY'], ['STRIPE_NOT_CONNECTED'], ['STRIPE_REVOCATION_PENDING'], ['COLLECTION_IN_PROGRESS'],
  ])('falls back quietly on a known 409 (%s) — no Sentry', async (code) => {
    mocks.createInvoicePayLink.mockRejectedValue(new InvoiceServiceError('no', 409, code as never));
    expect(await resolveAcceptCheckoutUrl(RES, INVOICE_URL, CLIENT)).toBeNull();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it.each([
    ['ORG_DENIED', 403], ['INVOICE_NOT_FOUND', 404], ['NOT_PAYABLE', 409], ['INVALID_STATE', 409],
    ['STRIPE_CURRENCY_UNSUPPORTED', 409], ['STRIPE_INIT_FAILED', 500],
  ])('falls back but captures an unexpected refusal (%s)', async (code, status) => {
    const err = new InvoiceServiceError('no', status as never, code as never);
    mocks.createInvoicePayLink.mockRejectedValue(err);
    expect(await resolveAcceptCheckoutUrl(RES, INVOICE_URL, CLIENT)).toBeNull();
    expect(mocks.captureException).toHaveBeenCalledWith(err);
  });

  it('falls back and captures an unexpected failure (never throws past a committed accept)', async () => {
    const boom = new Error('stripe is down');
    mocks.createInvoicePayLink.mockRejectedValue(boom);
    expect(await resolveAcceptCheckoutUrl(RES, INVOICE_URL, CLIENT)).toBeNull();
    expect(mocks.captureException).toHaveBeenCalledWith(boom);
  });

  it('falls back and captures when the availability read itself fails', async () => {
    mocks.isPartnerOnlinePaymentAvailable.mockRejectedValue(new Error('db gone'));
    expect(await resolveAcceptCheckoutUrl(RES, INVOICE_URL, CLIENT)).toBeNull();
    expect(mocks.captureException).toHaveBeenCalled();
  });

  // Todd 10-09: the accept response must not wait on a slow Stripe. A bounded
  // wait, then the same fallback as a mint failure, reported as a warning.
  it('gives up after ACCEPT_CHECKOUT_TIMEOUT_MS and falls back to the invoice page', async () => {
    vi.useFakeTimers();
    let finishLate!: (v: { url: string }) => void;
    mocks.createInvoicePayLink.mockReturnValue(new Promise((resolve) => { finishLate = resolve; }));
    const pending = resolveAcceptCheckoutUrl(RES, INVOICE_URL, CLIENT);
    await vi.advanceTimersByTimeAsync(ACCEPT_CHECKOUT_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(mocks.captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventCode: 'quote_accept_checkout_timeout', level: 'warning' }),
    );
    expect(mocks.captureException).not.toHaveBeenCalled();
    // The Stripe call finishing afterwards is harmless: nothing throws, nothing
    // is reported, and its session stays reachable from the invoice page's Pay
    // (same request key — pinned by the integration suite).
    finishLate({ url: 'https://checkout.stripe.com/c/pay/late' });
    await vi.runAllTimersAsync();
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('a mint that FAILS after the timeout is swallowed (no unhandled rejection)', async () => {
    vi.useFakeTimers();
    let failLate!: (e: unknown) => void;
    mocks.createInvoicePayLink.mockReturnValue(new Promise((_r, reject) => { failLate = reject; }));
    const pending = resolveAcceptCheckoutUrl(RES, INVOICE_URL, CLIENT);
    await vi.advanceTimersByTimeAsync(ACCEPT_CHECKOUT_TIMEOUT_MS);
    expect(await pending).toBeNull();
    failLate(new Error('late stripe failure'));
    await vi.runAllTimersAsync();
    expect(mocks.captureException).toHaveBeenCalledTimes(1);
  });

  it('is about five seconds', () => {
    expect(ACCEPT_CHECKOUT_TIMEOUT_MS).toBe(5_000);
  });
});
