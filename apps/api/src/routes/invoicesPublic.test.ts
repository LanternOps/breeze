import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// DB mock for the branding/lines/mapping reads (select chains resolve queued
// row sets; orderBy joins the chain for the lines query).
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit', 'orderBy']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(dbResults.shift() ?? []).then(resolve);
    return chain;
  };
  return {
    db: makeChain(),
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

const { resolveMock, mintMock } = vi.hoisted(() => ({ resolveMock: vi.fn(), mintMock: vi.fn() }));
vi.mock('../services/invoiceLinkToken', () => ({
  resolveInvoiceByLinkToken: resolveMock,
  getOrMintInvoiceLink: mintMock,
  buildPublicInvoiceUrl: (t: string) => `https://portal.example.test/portal/invoice/${t}`,
}));

const { markViewedMock } = vi.hoisted(() => ({ markViewedMock: vi.fn() }));
vi.mock('../services/invoiceService', () => ({
  toCustomerInvoiceHeader: (inv: Record<string, unknown>) => ({
    id: inv.id, invoiceNumber: inv.invoiceNumber, status: inv.status,
    total: inv.total, balance: inv.balance, depositDue: inv.depositDue,
  }),
  toCustomerInvoiceLine: (l: unknown) => l,
  markViewed: markViewedMock,
}));

const { payLinkMock } = vi.hoisted(() => ({ payLinkMock: vi.fn() }));
vi.mock('../services/invoiceCheckout', () => ({ createInvoicePayLink: payLinkMock }));

const { settleMock } = vi.hoisted(() => ({ settleMock: vi.fn() }));
vi.mock('../services/stripeSettle', () => ({ settleCheckoutSession: settleMock }));

const { getPdfMock, renderPdfMock } = vi.hoisted(() => ({ getPdfMock: vi.fn(), renderPdfMock: vi.fn() }));
vi.mock('../services/invoicePdf', () => ({ getInvoicePdf: getPdfMock, renderInvoicePdf: renderPdfMock }));

vi.mock('../services/portalUrl', () => ({ portalBase: () => 'https://portal.example.test/portal' }));
vi.mock('../services/redis', () => ({ getRedis: () => null })); // limiter fails open
vi.mock('../services/documentThemes', () => ({
  resolveThemeId: (t: unknown) => t ?? 'classic',
  resolvePageSize: (p: unknown) => p ?? 'letter',
}));

// Org-lifecycle gate (Wave 4 review fix C-A.1): each handler runs one extra
// system-context org-status read. Stubbed OPEN by default so it does not
// consume the FIFO dbResults queue; the gate's own query is covered by
// services/publicLinkOrgGate.test.ts and the 410s are pinned below.
vi.mock('../services/publicLinkOrgGate', async (importActual) => {
  const actual = await importActual<typeof import('../services/publicLinkOrgGate')>();
  return {
    ...actual,
    resolveOrgLinkGate: vi.fn(async () => actual.PUBLIC_LINK_ORG_GATE_OPEN),
  };
});

import { invoicesPublicRoutes } from './invoicesPublic';
import { InvoiceServiceError } from '../services/invoiceTypes';
import { resolveOrgLinkGate, PUBLIC_LINK_ORG_UNAVAILABLE } from '../services/publicLinkOrgGate';

const TOKEN = 'A'.repeat(43);
const INV_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INV_ID, orgId: ORG_ID, partnerId: 'p1',
    invoiceNumber: 'INV-2026-0007', status: 'sent',
    currencyCode: 'USD', dueDate: '2026-09-01',
    total: '100.00', amountPaid: '0.00', balance: '100.00', depositDue: null,
    paidAt: null, replacedByInvoiceId: null,
    publicLinkTokenHash: 'h', publicLinkTokenCt: 'ct',
    publicLinkExpiresAt: new Date(Date.now() + 3600_000),
    ...overrides,
  };
}

const PARTNER_ROW = [{ name: 'Lantern MSP', billingEmail: 'billing@lantern.test', documentTheme: null, documentPageSize: null }];
const BRAND_ROW = [{ logoUrl: null, primaryColor: null }];

function app() {
  const a = new Hono();
  a.route('/invoices/public', invoicesPublicRoutes);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  resolveMock.mockResolvedValue(null);
  settleMock.mockResolvedValue({ settled: true, invoiceId: INV_ID });
  mintMock.mockResolvedValue({ token: TOKEN, expiresAt: new Date(), origin: 'reproduced' });
});

describe('GET /invoices/public/:token', () => {
  it('401s with ONE generic message for an unknown token', async () => {
    const res = await app().request(`/invoices/public/${TOKEN}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'This link is invalid or has expired' });
  });

  it('returns the customer view with chargeNow + payable and stamps viewed', async () => {
    resolveMock.mockResolvedValue(invoice());
    dbResults.push(PARTNER_ROW, BRAND_ROW, [{ name: 'RMM seat', quantity: '5' }]);
    const res = await app().request(`/invoices/public/${TOKEN}`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.payable).toBe(true);
    expect(data.chargeNow).toMatchObject({ amount: '100.00' });
    expect(data.invoice.invoiceNumber).toBe('INV-2026-0007');
    expect(data.branding.partnerName).toBe('Lantern MSP');
    expect(markViewedMock).toHaveBeenCalledWith(INV_ID, ORG_ID);
  });

  it('renders the calm no-amounts state for a void invoice', async () => {
    resolveMock.mockResolvedValue(invoice({ status: 'void', replacedByInvoiceId: 'r1' }));
    dbResults.push(PARTNER_ROW, BRAND_ROW);
    const res = await app().request(`/invoices/public/${TOKEN}`);
    const { data } = await res.json();
    expect(data).toMatchObject({ payable: false, chargeNow: null, lines: [] });
    expect(data.invoice).toEqual({ id: INV_ID, invoiceNumber: 'INV-2026-0007', status: 'void', replaced: true });
    // No amounts anywhere in the void payload.
    expect(JSON.stringify(data.invoice)).not.toContain('100.00');
    expect(markViewedMock).not.toHaveBeenCalled();
  });

  it('a paid invoice resolves but is not payable', async () => {
    resolveMock.mockResolvedValue(invoice({ status: 'paid', balance: '0.00', paidAt: new Date() }));
    dbResults.push(PARTNER_ROW, BRAND_ROW, []);
    const { data } = await (await app().request(`/invoices/public/${TOKEN}`)).json();
    expect(data.payable).toBe(false);
  });

  it('sets the capability-url hardening headers', async () => {
    const res = await app().request(`/invoices/public/${TOKEN}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });
});

describe('POST /invoices/public/:token/pay', () => {
  const post = (token = TOKEN) => app().request(`/invoices/public/${token}/pay`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });

  it('401s for an unknown token', async () => {
    expect((await post()).status).toBe(401);
    expect(payLinkMock).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON request shape', async () => {
    resolveMock.mockResolvedValue(invoice());
    const res = await app().request(`/invoices/public/${TOKEN}/pay`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(payLinkMock).not.toHaveBeenCalled();
  });

  it('mints checkout with session-id-only return urls and the _pub idempotency family', async () => {
    resolveMock.mockResolvedValue(invoice());
    payLinkMock.mockResolvedValue({ url: 'https://checkout.stripe.com/c/x' });
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).data.url).toContain('checkout.stripe.com');
    const [id, actor, urls] = payLinkMock.mock.calls[0]!;
    expect(id).toBe(INV_ID);
    expect(actor).toEqual({ userId: null, partnerId: null, accessibleOrgIds: [ORG_ID] });
    expect(urls.idempotencySuffix).toBe('_pub');
    // The durable bearer token must never reach Stripe.
    expect(urls.successUrl).not.toContain(TOKEN);
    expect(urls.cancelUrl).not.toContain(TOKEN);
    expect(urls.successUrl).toContain('/invoice/return?session_id={CHECKOUT_SESSION_ID}');
  });

  it('maps STRIPE_NOT_CONNECTED to customer-facing wording', async () => {
    resolveMock.mockResolvedValue(invoice());
    payLinkMock.mockRejectedValue(new InvoiceServiceError('connect Stripe first', 409, 'STRIPE_NOT_CONNECTED'));
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('contact the sender');
    expect(body.error).not.toContain('Stripe');
  });

  it('maps STRIPE_CURRENCY_UNSUPPORTED to customer-safe wording (no account-setup detail)', async () => {
    resolveMock.mockResolvedValue(invoice({ currencyCode: 'CHF' }));
    payLinkMock.mockRejectedValue(new InvoiceServiceError(
      'Your Stripe account cannot accept payments in CHF. Enable CHF in your Stripe Dashboard.', 409, 'STRIPE_CURRENCY_UNSUPPORTED'));
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      error: 'Online payment is not available for this invoice — please contact the sender.',
      code: 'STRIPE_CURRENCY_UNSUPPORTED',
    });
    expect(body.error).not.toContain('Stripe');
  });

  it('returns only { data: { url } } — the partner currency-mismatch warning never reaches the customer', async () => {
    resolveMock.mockResolvedValue(invoice({ currencyCode: 'EUR' }));
    payLinkMock.mockResolvedValue({
      url: 'https://checkout.stripe.com/c/x',
      warning: { code: 'CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT', documentCurrency: 'EUR', accountCurrency: 'USD', message: 'FX spread' },
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { url: 'https://checkout.stripe.com/c/x' } });
  });

  it('passes through NOT_PAYABLE', async () => {
    resolveMock.mockResolvedValue(invoice({ status: 'paid' }));
    payLinkMock.mockRejectedValue(new InvoiceServiceError('Invoice is not payable', 409, 'NOT_PAYABLE'));
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('NOT_PAYABLE');
  });
});

describe('POST /invoices/public/settle-return', () => {
  const post = (sessionId = 'cs_test_123') => app().request('/invoices/public/settle-return', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });

  it('404s for a session we did not create', async () => {
    dbResults.push([]); // no mapping row
    expect((await post()).status).toBe(404);
    expect(settleMock).not.toHaveBeenCalled();
  });

  it('settles a pending mapping and returns the canonical public url', async () => {
    dbResults.push([{ invoiceId: INV_ID, status: 'pending', updatedAt: new Date() }]);
    dbResults.push([invoice()]);
    const res = await post();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.settled).toBe(true);
    expect(data.publicUrl).toBe(`https://portal.example.test/portal/invoice/${TOKEN}`);
    expect(settleMock).toHaveBeenCalledWith('p1', 'cs_test_123');
  });

  it('reports unsettled (not an error) when instant settle hiccups', async () => {
    dbResults.push([{ invoiceId: INV_ID, status: 'pending', updatedAt: new Date() }]);
    dbResults.push([invoice()]);
    settleMock.mockRejectedValue(new Error('stripe down'));
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).data.settled).toBe(false);
  });

  it('does not hand out the url for a stale, already-settled session', async () => {
    dbResults.push([{ invoiceId: INV_ID, status: 'succeeded', updatedAt: new Date(Date.now() - 2 * 3600_000) }]);
    dbResults.push([invoice()]);
    const res = await post();
    const { data } = await res.json();
    expect(data.settled).toBe(true);
    expect(data.publicUrl).toBeNull();
    // Already settled — no second settle call.
    expect(settleMock).not.toHaveBeenCalled();
  });

  it('a FAILED mapping is never reported settled (no false payment-received banner)', async () => {
    dbResults.push([{ invoiceId: INV_ID, status: 'failed', updatedAt: new Date() }]);
    dbResults.push([invoice()]);
    const res = await post();
    const { data } = await res.json();
    expect(data.settled).toBe(false);
    // Terminal non-success: no settle replay either.
    expect(settleMock).not.toHaveBeenCalled();
  });
});

// ── org-lifecycle gate (Wave 4 review fix C-A.1) ───────────────────────────
// The public invoice link is a DURABLE bearer capability, so it outlives an
// archive: without this gate an archived tenant keeps taking card payments for
// the whole retention window and then has the payment rows erased under it.
describe('invoicesPublic org-lifecycle gate', () => {
  const blocked = { orgId: ORG_ID, status: 'archived', blocked: true };

  // vi.clearAllMocks() (global beforeEach) clears CALLS but not
  // implementations, so a mockResolvedValue set by one case would leak into
  // the next and quietly make the live-org case vacuous.
  beforeEach(() => {
    vi.mocked(resolveOrgLinkGate).mockResolvedValue({ orgId: null, status: null, blocked: false });
  });

  it('410s the customer view for an archived org', async () => {
    resolveMock.mockResolvedValue(invoice());
    vi.mocked(resolveOrgLinkGate).mockResolvedValue(blocked);
    const res = await app().request(`/invoices/public/${TOKEN}`);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual(PUBLIC_LINK_ORG_UNAVAILABLE);
    expect(markViewedMock).not.toHaveBeenCalled();
  });

  it('410s the PDF download for an archived org', async () => {
    resolveMock.mockResolvedValue(invoice());
    vi.mocked(resolveOrgLinkGate).mockResolvedValue(blocked);
    const res = await app().request(`/invoices/public/${TOKEN}/pdf`);
    expect(res.status).toBe(410);
    expect(getPdfMock).not.toHaveBeenCalled();
  });

  it('410s the pay-link mint for an archived org (no Stripe session)', async () => {
    resolveMock.mockResolvedValue(invoice());
    vi.mocked(resolveOrgLinkGate).mockResolvedValue(blocked);
    const res = await app().request(`/invoices/public/${TOKEN}/pay`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(410);
    expect(payLinkMock).not.toHaveBeenCalled();
  });

  it('410s settle-return for an archived org WITHOUT settling', async () => {
    dbResults.push([{ invoiceId: INV_ID, status: 'pending', updatedAt: new Date() }]);
    dbResults.push([invoice()]);
    vi.mocked(resolveOrgLinkGate).mockResolvedValue(blocked);
    const res = await app().request('/invoices/public/settle-return', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cs_test_123' }),
    });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual(PUBLIC_LINK_ORG_UNAVAILABLE);
    expect(settleMock).not.toHaveBeenCalled();
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('serves normally for a live org (the gate is not a blanket refusal)', async () => {
    resolveMock.mockResolvedValue(invoice());
    dbResults.push(PARTNER_ROW, BRAND_ROW, []);
    const res = await app().request(`/invoices/public/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(resolveOrgLinkGate).toHaveBeenCalledWith(ORG_ID);
  });
});
