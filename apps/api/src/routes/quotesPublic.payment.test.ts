import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// FIFO DB mock (same shape as quotesPublic.test.ts): each awaited chain
// resolves to the next queued row set, in call order.
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'update', 'set', 'returning', 'for']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
  return {
    db: chain,
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});
vi.mock('../services/quoteAcceptToken', () => ({
  verifyQuoteAcceptToken: vi.fn(),
  isQuoteAcceptJtiRevoked: vi.fn(),
  revokeQuoteAcceptJti: vi.fn(),
}));
vi.mock('../services/orgMerge', () => ({ resolveMergedOrgIds: vi.fn(async (orgId: string) => [orgId]) }));
vi.mock('../services/publicLinkOrgGate', async (importActual) => {
  const actual = await importActual<typeof import('../services/publicLinkOrgGate')>();
  return { ...actual, resolveQuoteLinkOrgGate: vi.fn(async () => actual.PUBLIC_LINK_ORG_GATE_OPEN) };
});
vi.mock('../services/quoteLifecycle', () => ({ markQuoteViewed: vi.fn() }));
vi.mock('../services/quoteOutcomeNotify', () => ({ notifyQuoteOutcome: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/portalUrl', () => ({ portalBase: () => 'https://portal.example.com/portal' }));
vi.mock('../services/quotePay', () => ({ getConvertedInvoicePayment: vi.fn() }));
vi.mock('../services/invoiceCheckout', () => ({ createInvoicePayLink: vi.fn() }));
vi.mock('../services/contractTemplateRender', () => ({ loadContractBlockRenderData: vi.fn(async () => []) }));
vi.mock('../services/quoteAcceptService', () => ({
  acceptQuote: vi.fn(),
  emitAcceptInvoiceIssued: vi.fn(async () => undefined),
  resolveAcceptInvoiceUrl: vi.fn(),
  autoEmailAcceptedInvoice: vi.fn(async () => undefined),
}));
vi.mock('../services/quoteAcceptCheckout', async (importActual) => ({
  ...(await importActual<typeof import('../services/quoteAcceptCheckout')>()),
  resolveAcceptCheckoutUrl: vi.fn(async () => null),
}));

import { quotesPublicRoutes } from './quotesPublic';
import { verifyQuoteAcceptToken, isQuoteAcceptJtiRevoked } from '../services/quoteAcceptToken';
import { resolveQuoteLinkOrgGate } from '../services/publicLinkOrgGate';
import { getConvertedInvoicePayment } from '../services/quotePay';
import { createInvoicePayLink } from '../services/invoiceCheckout';
import { publicInvoiceCheckoutUrls } from '../services/quoteAcceptCheckout';
import { acceptQuote, resolveAcceptInvoiceUrl } from '../services/quoteAcceptService';
import { InvoiceServiceError } from '../services/invoiceTypes';

const QUOTE_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const INVOICE_ID = '44444444-4444-4444-4444-444444444444';
const TOKEN = 'a-valid-looking-token-1234567890';
const JTI = 'jti-accepting';
const PAYMENT = { amount: '324.00', currencyCode: 'USD', isDeposit: false, invoiceNumber: 'INV-0042' };

function app() {
  const a = new Hono();
  a.route('/quotes/public', quotesPublicRoutes);
  return a;
}

/** A quote this token accepted: converted, with the durable consumption record naming its jti. */
function acceptedRow(over: Record<string, unknown> = {}) {
  return {
    id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'converted',
    convertedInvoiceId: INVOICE_ID, publicLinkRevokedAt: null,
    publicResponseJti: JTI, publicResponseOutcome: 'accepted',
    ...over,
  };
}

function setToken({ spent }: { spent: boolean }) {
  vi.mocked(verifyQuoteAcceptToken).mockResolvedValue({ quoteId: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: JTI });
  vi.mocked(isQuoteAcceptJtiRevoked).mockResolvedValue(spent);
}

const getPayment = () => app().request(`/quotes/public/${TOKEN}/payment`);
const postPay = (headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  app().request(`/quotes/public/${TOKEN}/pay`, { method: 'POST', headers, body: '{}' });

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  vi.mocked(getConvertedInvoicePayment).mockResolvedValue(PAYMENT);
  vi.mocked(createInvoicePayLink).mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/x' });
});

describe('GET /quotes/public/:token/payment (#3740 — revisit after accept)', () => {
  it('offers the converted invoice\'s payment to the token that accepted the quote, even though it is spent', async () => {
    setToken({ spent: true });
    dbResults.push([acceptedRow()], [{ name: 'Lantern IT' }]);

    const res = await getPayment();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { partnerName: 'Lantern IT', payment: PAYMENT } });
    expect(getConvertedInvoicePayment).toHaveBeenCalledWith(INVOICE_ID, ORG_ID);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves a live token on a quote accepted elsewhere (portal / on behalf)', async () => {
    setToken({ spent: false });
    dbResults.push([acceptedRow({ publicResponseJti: null, publicResponseOutcome: null })], [{ name: 'Lantern IT' }]);

    const res = await getPayment();

    expect(res.status).toBe(200);
    expect((await res.json()).data.payment).toEqual(PAYMENT);
  });

  it('answers payment:null when nothing can be paid online', async () => {
    setToken({ spent: true });
    vi.mocked(getConvertedInvoicePayment).mockResolvedValue(null);
    dbResults.push([acceptedRow()], [{ name: 'Lantern IT' }]);

    const res = await getPayment();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { partnerName: 'Lantern IT', payment: null } });
  });

  it.each([
    ['a different token accepted it', { publicResponseJti: 'someone-elses-jti' }],
    ['the token was spent by a decline', { status: 'declined', convertedInvoiceId: null, publicResponseOutcome: 'declined' }],
    ['the quote is not converted', { status: 'viewed', convertedInvoiceId: null, publicResponseJti: null, publicResponseOutcome: null }],
    ['the link was revoked', { publicLinkRevokedAt: new Date('2026-09-01T00:00:00Z') }],
  ])('refuses a spent token with a generic 401 when %s', async (_name, over) => {
    setToken({ spent: true });
    dbResults.push([acceptedRow(over)]);

    const res = await getPayment();

    expect(res.status).toBe(401);
    expect(getConvertedInvoicePayment).not.toHaveBeenCalled();
  });

  it('refuses when the quote is not under the token\'s org (row not found)', async () => {
    setToken({ spent: true });
    dbResults.push([]);

    const res = await getPayment();

    expect(res.status).toBe(401);
    expect(getConvertedInvoicePayment).not.toHaveBeenCalled();
  });

  it('refuses a forged / expired token without touching the DB', async () => {
    vi.mocked(verifyQuoteAcceptToken).mockResolvedValue(null);

    const res = await getPayment();

    expect(res.status).toBe(401);
    expect(getConvertedInvoicePayment).not.toHaveBeenCalled();
  });

  it('answers 409 NOT_CONVERTED to a live token whose quote is still open', async () => {
    setToken({ spent: false });
    dbResults.push([acceptedRow({ status: 'viewed', convertedInvoiceId: null, publicResponseJti: null, publicResponseOutcome: null })]);

    const res = await getPayment();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_CONVERTED');
  });

  it('honours the org-lifecycle gate', async () => {
    setToken({ spent: true });
    vi.mocked(resolveQuoteLinkOrgGate).mockResolvedValueOnce({ orgId: ORG_ID, status: 'archived', partnerStatus: 'active', blocked: true } as never);

    const res = await getPayment();

    expect(res.status).toBe(410);
    expect(getConvertedInvoicePayment).not.toHaveBeenCalled();
  });
});

describe('POST /quotes/public/:token/pay (#3740)', () => {
  it('mints the public-link checkout for the converted invoice, scoped to the quote org', async () => {
    setToken({ spent: true });
    dbResults.push([acceptedRow()]);

    const res = await postPay({ 'content-type': 'application/json', 'user-agent': 'UA' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { url: 'https://checkout.stripe.com/c/pay/x' } });
    expect(createInvoicePayLink).toHaveBeenCalledWith(
      INVOICE_ID,
      { userId: null, partnerId: null, accessibleOrgIds: [ORG_ID] },
      { ...publicInvoiceCheckoutUrls(), ip: null, userAgent: 'UA' },
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('refuses a spent token that did not accept this quote', async () => {
    setToken({ spent: true });
    dbResults.push([acceptedRow({ publicResponseJti: 'someone-elses-jti' })]);

    const res = await postPay();

    expect(res.status).toBe(401);
    expect(createInvoicePayLink).not.toHaveBeenCalled();
  });

  it('refuses once the quote link was revoked, even for the accepting token', async () => {
    setToken({ spent: true });
    dbResults.push([acceptedRow({ publicLinkRevokedAt: new Date('2026-09-01T00:00:00Z') })]);

    const res = await postPay();

    expect(res.status).toBe(401);
    expect(createInvoicePayLink).not.toHaveBeenCalled();
  });

  it('refuses a non-JSON (cross-site form) request before resolving anything', async () => {
    setToken({ spent: true });

    const res = await postPay({ 'content-type': 'application/x-www-form-urlencoded' });

    expect(res.status).toBe(400);
    expect(verifyQuoteAcceptToken).not.toHaveBeenCalled();
    expect(createInvoicePayLink).not.toHaveBeenCalled();
  });

  it('answers 409 NOT_CONVERTED to a live token whose quote is still open', async () => {
    setToken({ spent: false });
    dbResults.push([acceptedRow({ status: 'sent', convertedInvoiceId: null, publicResponseJti: null, publicResponseOutcome: null })]);

    const res = await postPay();

    expect(res.status).toBe(409);
    expect(createInvoicePayLink).not.toHaveBeenCalled();
  });

  it('passes the mint\'s own refusals through (NOTHING_TO_PAY once paid)', async () => {
    setToken({ spent: true });
    dbResults.push([acceptedRow()]);
    vi.mocked(createInvoicePayLink).mockRejectedValue(new InvoiceServiceError('Nothing to pay', 409, 'NOTHING_TO_PAY'));

    const res = await postPay();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOTHING_TO_PAY');
  });

  it('words a missing Stripe connection for the customer, not the partner', async () => {
    setToken({ spent: true });
    dbResults.push([acceptedRow()]);
    vi.mocked(createInvoicePayLink).mockRejectedValue(
      new InvoiceServiceError('Online payment is not available — connect Stripe first', 409, 'STRIPE_NOT_CONNECTED'));

    const res = await postPay();

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('STRIPE_NOT_CONNECTED');
    expect(body.error).not.toContain('connect Stripe');
  });
});

describe('POST /quotes/public/:token/accept — payDeferred carries the payment step (#3740)', () => {
  const acceptResult = {
    quote: { id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'converted' },
    invoiceId: INVOICE_ID, invoiceIssued: true, pax8OrderId: null,
  };
  const accept = () => app().request(`/quotes/public/${TOKEN}/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signerName: 'Pat Prospect' }),
  });

  it('returns what is due when the durable invoice link could not be minted', async () => {
    setToken({ spent: false });
    dbResults.push([]); // contract blocks
    vi.mocked(acceptQuote).mockResolvedValue(acceptResult as never);
    vi.mocked(resolveAcceptInvoiceUrl).mockResolvedValue(null);

    const res = await accept();

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.payDeferred).toBe(true);
    expect(data.payment).toEqual(PAYMENT);
    expect(getConvertedInvoicePayment).toHaveBeenCalledWith(INVOICE_ID, ORG_ID);
  });

  it('carries no payment step when the customer is being sent to the durable invoice page', async () => {
    setToken({ spent: false });
    dbResults.push([]);
    vi.mocked(acceptQuote).mockResolvedValue(acceptResult as never);
    vi.mocked(resolveAcceptInvoiceUrl).mockResolvedValue('https://portal.example.com/portal/invoice/tok');

    const { data } = await (await accept()).json();

    expect(data.payDeferred).toBe(false);
    expect(data.payment).toBeNull();
    expect(getConvertedInvoicePayment).not.toHaveBeenCalled();
  });
});
