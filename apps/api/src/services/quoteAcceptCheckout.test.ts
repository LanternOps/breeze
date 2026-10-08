import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createInvoicePayLink: vi.fn(),
  isPartnerOnlinePaymentAvailable: vi.fn(),
  readOrgAutopayEnrollment: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {},
  runOutsideDbContext: <T>(fn: () => T): T => fn(),
  withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock('./invoiceCheckout', () => ({ createInvoicePayLink: mocks.createInvoicePayLink }));
vi.mock('./partnerStripe', () => ({ isPartnerOnlinePaymentAvailable: mocks.isPartnerOnlinePaymentAvailable }));
vi.mock('./autopay/customerInvoiceStatus', () => ({ readOrgAutopayEnrollment: mocks.readOrgAutopayEnrollment }));
vi.mock('./sentry', () => ({ captureException: mocks.captureException }));
vi.mock('./portalUrl', () => ({ portalBase: () => 'https://portal.example.com/portal' }));

import { resolveAcceptCheckoutUrl, isPayOnAcceptAvailable, publicInvoiceCheckoutUrls } from './quoteAcceptCheckout';
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

  it('is false without an online payment connection (autopay not even read)', async () => {
    mocks.isPartnerOnlinePaymentAvailable.mockResolvedValue(false);
    expect(await isPayOnAcceptAvailable('p-1', 'o-1')).toBe(false);
    expect(mocks.readOrgAutopayEnrollment).not.toHaveBeenCalled();
  });

  it('is false for an org enrolled in automatic payments', async () => {
    mocks.isPartnerOnlinePaymentAvailable.mockResolvedValue(true);
    mocks.readOrgAutopayEnrollment.mockResolvedValue({ enrolled: true });
    expect(await isPayOnAcceptAvailable('p-1', 'o-1')).toBe(false);
    expect(mocks.readOrgAutopayEnrollment).toHaveBeenCalledWith(expect.anything(), 'o-1');
  });

  it('is true when connected and not enrolled', async () => {
    mocks.isPartnerOnlinePaymentAvailable.mockResolvedValue(true);
    mocks.readOrgAutopayEnrollment.mockResolvedValue({ enrolled: false });
    expect(await isPayOnAcceptAvailable('p-1', 'o-1')).toBe(true);
  });
});

describe('resolveAcceptCheckoutUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isPartnerOnlinePaymentAvailable.mockResolvedValue(true);
    mocks.readOrgAutopayEnrollment.mockResolvedValue({ enrolled: false });
    mocks.createInvoicePayLink.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/x' });
  });

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

  it('does nothing for an autopay-enrolled org', async () => {
    mocks.readOrgAutopayEnrollment.mockResolvedValue({ enrolled: true });
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
});
