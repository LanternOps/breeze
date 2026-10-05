const bankRoutes=vi.hoisted(()=>({setup:vi.fn(),collect:vi.fn(),offer:vi.fn(async()=>null)}));
vi.mock('../../services/autopay/bankPayment',async original=>({
 ...await original<typeof import('../../services/autopay/bankPayment')>(),
 startInvoiceBankSetup:bankRoutes.setup,collectAfterBankSetup:bankRoutes.collect,getBankAutopayOffer:bankRoutes.offer,
}));
import { prepareCardPayAndSave } from '../../services/autopay/payAndSave';
const confirmation = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock('../../services/autopay/confirmPayment', () => ({ releaseInvoiceConfirmation: confirmation.release }));
const reservation = vi.hoisted(() => ({ assert: vi.fn(), held: vi.fn(async () => false), lock: vi.fn(), inFlight: vi.fn(), invoice: null as Record<string, unknown> | null }));
vi.mock('../../services/autopay/reservation', () => ({ assertNoActiveCollection: reservation.assert, holdsClientMoney: reservation.held, lockInvoiceForCollection: reservation.lock, readInFlightCollection: reservation.inFlight }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { db } from '../../db';

// Service-layer mocks — the route is a thin org-scoped consumer.
const { getCustomerInvoiceMock, markViewedMock } = vi.hoisted(() => ({
  getCustomerInvoiceMock: vi.fn(),
  markViewedMock: vi.fn(),
}));
// toCustomerInvoiceLine is deliberately kept REAL (importActual) — it is the
// serialization boundary this suite's leak-guard test exists to police. A
// hand-written stub here would only ever assert itself: it silently drifted
// from the real field list when `name` was added (#3319), leaving the keyset
// test documenting a keyset the route never actually returns.
vi.mock('../../services/invoiceService', async (importActual) => {
  const actual = await importActual<typeof import('../../services/invoiceService')>();
  return {
    getCustomerInvoice: getCustomerInvoiceMock,
    markViewed: markViewedMock,
    toCustomerInvoiceLine: actual.toCustomerInvoiceLine,
  };
});

const { getInvoicePdfMock, renderInvoicePdfMock } = vi.hoisted(() => ({
  getInvoicePdfMock: vi.fn(),
  renderInvoicePdfMock: vi.fn(),
}));
vi.mock('../../services/invoicePdf', () => ({
  getInvoicePdf: getInvoicePdfMock,
  renderInvoicePdf: renderInvoicePdfMock,
}));

// DB mock for the list query: select().from().where() resolves to either the
// count row or the data rows depending on call order. insert().values() is a
// thenable so the pay route's mapping INSERT awaits cleanly.
const { dbResults, insertValuesMock, mappings, ctx } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  insertValuesMock: vi.fn(),
  mappings: new Map<string,Record<string,unknown>>(),
  ctx: { depth: 0 },
}));
// SEC-150: the fail-closed Checkout-session revocation phases run BEFORE this
// suite's transaction and issue their own queries. This file drives a
// hand-rolled Drizzle mock whose result queue would be consumed by them, so the
// revocation is stubbed out here and proved for real — against Postgres, with a
// mocked Stripe SDK — in __tests__/integration/stripeSessionRevocation.integration.test.ts.
vi.mock('../../services/stripeSessionRevocation', () => ({
  requestInvoiceSessionRevocation: vi.fn(async () => ({
    requested: 0, revoked: 0, charged: 0, blocked: 0, stillPending: 0,
  })),
  assertInvoiceSessionsRevoked: vi.fn(async () => undefined),
  assertNoPendingRevocation: vi.fn(async () => undefined),
  markSiblingRevocationIntentInTx: vi.fn(async () => 0),
  markSessionChargedRepair: vi.fn(async () => false),
  REVOCATION_PENDING_CODE: 'STRIPE_REVOCATION_PENDING',
}));

vi.mock('../../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'offset', 'for']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = dbResults.shift() ?? [];
      const first = rows[0];
      if (first && typeof first === 'object' && 'currencyCode' in first && 'balance' in first) reservation.invoice = first as Record<string, unknown>;
      return Promise.resolve(rows).then(resolve);
    };
    (chain as { insert: unknown }).insert = vi.fn(() => ({
      values: (v: any) => { insertValuesMock(v);let ignore=false;
        const result:any={onConflictDoNothing:()=>{ignore=true;return result;},returning:()=>result,
          then:(resolve:any,reject:any)=>{const prior=mappings.get(v.stripeObjectId);if(prior&&!ignore)return Promise.reject(new Error('invoice_stripe_payments_object_uq')).then(resolve,reject);
            if(!prior)mappings.set(v.stripeObjectId,v);return Promise.resolve(prior?[]:[{invoiceId:v.invoiceId}]).then(resolve,reject);}};return result; },
    }));
    return chain;
  };
  // runOutsideDbContext/withSystemDbAccessContext are transparent pass-throughs in
  // unit tests (no AsyncLocalStorage). The real RLS-scope behaviour of the
  // system-context connection read is covered by the integration test.
  return {
    db: makeChain(),
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    // Tracks nesting so a test can prove the settle runs with NO context held (#7065).
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => {
      ctx.depth++;
      try { return await fn(); } finally { ctx.depth--; }
    },
  };
});

// Stripe client + connect service mocks for the pay route.
// Partner Stripe-key mocks for the pay route (API-key model — no Connect). The
// pay route builds the partner's own client and charges directly on their account.
const { sessionsCreateMock, getPartnerStripeClientMock, onlinePayMock } = vi.hoisted(() => ({
  onlinePayMock: vi.fn(),
  sessionsCreateMock: vi.fn(),
  getPartnerStripeClientMock: vi.fn(),
}));
vi.mock('../../services/partnerStripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/partnerStripe')>();
  return {
    PartnerStripeError: actual.PartnerStripeError,
    getPartnerStripeClient: getPartnerStripeClientMock,
    isPartnerOnlinePaymentAvailable: onlinePayMock,
  };
});

// Verify-on-return settle primitive (system-scoped in the route).
const { settleCheckoutSessionMock, HeldCtxError } = vi.hoisted(() => ({
  settleCheckoutSessionMock: vi.fn(),
  HeldCtxError: class HeldDbContextForStripeError extends Error {},
}));
vi.mock('../../services/stripeSettle', () => ({
  settleCheckoutSession: settleCheckoutSessionMock,
  assertNoHeldDbContextForStripe: vi.fn(),
  HeldDbContextForStripeError: HeldCtxError,
}));

// Real InvoiceServiceError / PartnerStripeError so `instanceof` branches in the route fire.
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { PartnerStripeError } from '../../services/partnerStripe';
import { invoiceRoutes as portalInvoiceRoutes } from './invoices';

// A fake partner Stripe client whose checkout.sessions.create is the shared spy.
const partnerClient = (stripeAccountId = 'acct_9') => ({
  stripe: { checkout: { sessions: { create: sessionsCreateMock } } },
  stripeAccountId,
});

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const INV_ID = '11111111-1111-1111-1111-111111111111';

// Wrap the route with a portalAuth-injecting middleware (mirrors portalAuthMiddleware).
function app(orgId = ORG_ID, authMethod: 'bearer' | 'cookie' = 'bearer') {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      // contactId is REQUIRED on PortalAuthContext (#3258 W03); invoice routes
      // do not read it, so the null (contact-less login) case is stated.
      user: { id: 'pu1', orgId, email: 'c@example.test', name: 'Cust', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't', authMethod,
      timezone: 'UTC',
    });
    await next();
  });
  a.route('/', portalInvoiceRoutes);
  return a;
}

// Drizzle SQL objects are circular (column → table → column), so JSON.stringify
// can't walk them. Collect Param values by descending queryChunks instead.
function boundParams(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  const n = node as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
  if ('encoder' in n && 'value' in n) out.push(n.value);
  for (const c of n.queryChunks ?? []) boundParams(c, out, seen);
  return out;
}

import { checkoutSessionExpiry } from '../../services/invoiceCheckout';

describe('portal invoices routes', () => {
  it.each([
    ['stale disclosure', 409, 'The terms changed. Review them and try again.', 'INVALID_STATE'],
    ['unavailable enrollment', 409, 'Request automatic payments first', 'INVALID_STATE'],
    ['disabled rollout', 404, 'Automatic payments unavailable', 'autopay_not_enabled'],
  ] as const)('pay preserves the customer response for %s', async (_case, status, message, code) => {
    dbResults.push([{ id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'USD', invoiceNumber: 'INV-1' }]);
    vi.mocked(prepareCardPayAndSave).mockRejectedValueOnce(new InvoiceServiceError(message, status, 'INVALID_STATE'));
    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saveForAutopay: true, consentAccepted: true, disclosureHash: 'a'.repeat(64) }) });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: code === 'autopay_not_enabled' ? 'Automatic payments are not enabled' : message, code });
    expect(sessionsCreateMock).not.toHaveBeenCalled();
    expect(getPartnerStripeClientMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

it('portal invoice pay rejects missing authorization before Stripe', async () => {
  const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ saveForAutopay: true }) });
  expect(res.status).toBe(400); expect(sessionsCreateMock).not.toHaveBeenCalled();
});

  beforeEach(() => {
    reservation.invoice = null; reservation.assert.mockResolvedValue(undefined); reservation.lock.mockImplementation(async () => ({ invoice: reservation.invoice, reservedAmount: '0.00' })); vi.clearAllMocks(); reservation.inFlight.mockResolvedValue({ inProgress: false, amount: '0.00' }); dbResults.length = 0; insertValuesMock.mockReset(); mappings.clear(); onlinePayMock.mockResolvedValue(true); });

  it.each(['pay', 'settle'])('rejects cookie-authenticated POST /invoices/:id/%s without CSRF before side effects', async (action) => {
    const res = await app(ORG_ID, 'cookie').request(`/invoices/${INV_ID}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: 'breeze_portal_session=t; breeze_portal_csrf_token=csrf-token',
      },
      body: action === 'settle' ? JSON.stringify({ sessionId: 'cs_test' }) : undefined,
    });
    expect(res.status).toBe(403);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
    expect(settleCheckoutSessionMock).not.toHaveBeenCalled();
  });

it('portal pay returns 409 while captured money for the invoice is unapplied, before contacting Stripe', async () => {
  dbResults.push([{ id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent', currencyCode: 'USD', balance: '100.00' }]);
  reservation.held.mockResolvedValueOnce(true);
  const response = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
  expect(sessionsCreateMock).not.toHaveBeenCalled();
});
it('portal pay returns 409 for a reservation before contacting Stripe', async () => {
  dbResults.push([{ id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent', currencyCode: 'USD', balance: '100.00' }]);
  reservation.assert.mockRejectedValueOnce(new InvoiceServiceError('A payment is already processing', 409, 'COLLECTION_IN_PROGRESS'));
  const response = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'COLLECTION_IN_PROGRESS' });
  expect(sessionsCreateMock).not.toHaveBeenCalled();
});

  it('rejects a form-urlencoded settle body for bearer auth', async () => {
    const res = await app().request(`/invoices/${INV_ID}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'sessionId=cs_test',
    });
    expect(res.status).toBe(415);
    expect(settleCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('GET /invoices lists this org non-draft invoices', async () => {
    dbResults.push([{ count: 2 }]);             // count query
    dbResults.push([{ id: INV_ID, status: 'sent' }, { id: 'i2', status: 'paid' }]); // data
    const res = await app().request('/invoices', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
  });

  it('derived title subselects correlate on a QUALIFIED outer column', async () => {
    // Drizzle renders an interpolated column (`${invoices.id}`) as bare `"id"`,
    // which inside a correlated subselect resolves to the SUBQUERY's own table
    // and correlates it with itself — always false, title always null, and the
    // mocked db chain here can't see it. Pin the source: the correlation must
    // be the hand-qualified `invoices.id`.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./invoices.ts', import.meta.url), 'utf8');
    const start = src.indexOf('invoiceDerivedTitleSql = sql');
    const fragment = src.slice(start, src.indexOf(')`;', start));
    expect(fragment).toContain('q.converted_invoice_id = invoices.id');
    expect(fragment).toContain('il.invoice_id = invoices.id');
    expect(fragment).not.toContain('${invoices.id}');
  });

  it('GET /invoices/:id returns the customer view + stamps viewed', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [{ id: 'l1' }] });
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invoice.id).toBe(INV_ID);
    expect(body.lines).toHaveLength(1);
    expect(getCustomerInvoiceMock).toHaveBeenCalledWith(INV_ID, ORG_ID);
    expect(markViewedMock).toHaveBeenCalledWith(INV_ID, ORG_ID);
  });

  it.each([[true], [false]])('GET /invoices/:id reports onlinePaymentAvailable=%s from the shared resolver (#7509)', async (available) => {
    onlinePayMock.mockResolvedValue(available);
    getCustomerInvoiceMock.mockResolvedValue({ partnerId: 'p1', invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    const body = await (await app().request(`/invoices/${INV_ID}`, { method: 'GET' })).json();
    expect(body.onlinePaymentAvailable).toBe(available);
    expect(onlinePayMock).toHaveBeenCalledWith('p1');
  });

  it('GET /invoices/:id reports an in-flight autopay collection from the server-side reservation (#7824)', async () => {
    reservation.inFlight.mockResolvedValue({ inProgress: true, amount: '50.00' });
    getCustomerInvoiceMock.mockResolvedValue({ partnerId: 'p1', invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    const body = await (await app().request(`/invoices/${INV_ID}`, { method: 'GET' })).json();
    expect(body.collectionInProgress).toEqual({ amount: '50.00', actionRequired: false });
    expect(reservation.inFlight).toHaveBeenCalledWith(expect.anything(), INV_ID);
  });

  it('GET /invoices/:id tells the customer when the autopay payment is waiting on their bank', async () => {
    reservation.inFlight.mockResolvedValue({ inProgress: true, amount: '50.00', actionRequired: true });
    getCustomerInvoiceMock.mockResolvedValue({ partnerId: 'p1', invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    const body = await (await app().request(`/invoices/${INV_ID}`, { method: 'GET' })).json();
    expect(body.collectionInProgress).toEqual({ amount: '50.00', actionRequired: true });
  });

  it('POST /invoices/:id/autopay-confirmation releases the off-session payment for the portal user\'s own org', async () => {
    confirmation.release.mockResolvedValue({ outcome: 'released' });
    const res = await app().request(`/invoices/${INV_ID}/autopay-confirmation`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'released' });
    expect(confirmation.release).toHaveBeenCalledWith({ invoiceId: INV_ID, orgId: ORG_ID });
  });

  it('POST /invoices/:id/autopay-confirmation 404s another org\'s invoice', async () => {
    confirmation.release.mockRejectedValue(new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND'));
    const res = await app('99999999-9999-4999-8999-999999999999').request(`/invoices/${INV_ID}/autopay-confirmation`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404);
    expect(confirmation.release).toHaveBeenCalledWith({ invoiceId: INV_ID, orgId: '99999999-9999-4999-8999-999999999999' });
  });

  it('POST /invoices/:id/autopay-confirmation requires a JSON body and cookie CSRF before Stripe', async () => {
    expect((await app().request(`/invoices/${INV_ID}/autopay-confirmation`, { method: 'POST' })).status).toBe(415);
    expect((await app(ORG_ID, 'cookie').request(`/invoices/${INV_ID}/autopay-confirmation`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect(confirmation.release).not.toHaveBeenCalled();
  });

  it('GET /invoices/:id reports collectionInProgress=null when nothing is in flight (#7824)', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ partnerId: 'p1', invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    const body = await (await app().request(`/invoices/${INV_ID}`, { method: 'GET' })).json();
    expect(body.collectionInProgress).toBeNull();
  });

  it('GET /invoices/:id still renders (fail-safe null) when the in-flight read throws (#7824)', async () => {
    reservation.inFlight.mockRejectedValue(new Error('db down'));
    getCustomerInvoiceMock.mockResolvedValue({ partnerId: 'p1', invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect((await res.json()).collectionInProgress).toBeNull();
  });

  it('GET /invoices/:id fails closed (200, unavailable) when the availability lookup throws (#7509)', async () => {
    onlinePayMock.mockRejectedValue(new Error('db down'));
    getCustomerInvoiceMock.mockResolvedValue({ partnerId: 'p1', invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect((await res.json()).onlinePaymentAvailable).toBe(false);
  });

  it('GET /invoices/:id serializes the exact safe line keyset even if the service row has internal fields', async () => {
    getCustomerInvoiceMock.mockResolvedValue({
      invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' },
      lines: [{
        id: 'internal-line-id', sourceType: 'time_entry', sourceId: 'source-1',
        costBasis: '10.00', revenueAllocation: { labor: '25.00' }, isUnapprovedTime: true,
        name: 'Support retainer',
        description: 'Support', quantity: '1.00', unitPrice: '25.00', taxable: true, lineTotal: '25.00',
        // #6467: worked-vs-billed disclosure — structured data, deliberately
        // IN the safe keyset (ordinary numeric fact, like quantity), unlike
        // sourceType/sourceId/costBasis/revenueAllocation/isUnapprovedTime above.
        workedMinutes: 30,
      }],
    });

    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.lines[0]).sort()).toEqual([
      'description', 'lineTotal', 'name', 'quantity', 'taxable', 'ticketCategory', 'ticketNumber', 'unitPrice', 'workedMinutes',
    ]);
    expect(body.lines[0]).not.toHaveProperty('sourceType');
    expect(body.lines[0]).not.toHaveProperty('sourceId');
    // The customer-facing title survives the route boundary (#3319) — this is
    // the assertion the stubbed serializer used to make vacuous.
    expect(body.lines[0].name).toBe('Support retainer');
    expect(body.lines[0].description).toBe('Support');
    // #6467: workedMinutes itself survives the route boundary too.
    expect(body.lines[0].workedMinutes).toBe(30);
  });

  it('GET /invoices/:id resolves branding from the OUT-OF-HEADER partnerId', async () => {
    // The shipped bug read `result.invoice.partnerId` (stripped by the
    // serialization boundary) and sent undefined into the partners query.
    getCustomerInvoiceMock.mockResolvedValue({
      invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [], partnerId: 'partner-7',
    });
    dbResults.push([{ name: 'Lantern IT' }]);                                          // partners (system ctx)
    dbResults.push([{ logoUrl: 'https://cdn/logo.png', primaryColor: '#123456' }]);    // portal_branding
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.branding).toEqual({ partnerName: 'Lantern IT', logoUrl: 'https://cdn/logo.png', primaryColor: '#123456' });
    // Walk the bound params of the partners where(): undefined must never reach postgres.js.
    const whereArg = (db as unknown as { where: { mock: { calls: unknown[][] } } }).where.mock.calls[0]![0];
    const params = boundParams(whereArg);
    expect(params).toContain('partner-7');
    expect(params).not.toContain(undefined);
  });

  it('GET /invoices/:id still renders with null branding when the lookups return nothing', async () => {
    getCustomerInvoiceMock.mockResolvedValue({
      invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [], partnerId: 'partner-7',
    });
    dbResults.push([]); dbResults.push([]);
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect((await res.json()).branding).toEqual({ partnerName: null, logoUrl: null, primaryColor: null });
  });

  it('GET /invoices/:id maps a cross-tenant 404 from the service', async () => {
    getCustomerInvoiceMock.mockRejectedValue(new InvoiceServiceError('Invoice not found', 404, 'INVOICE_NOT_FOUND'));
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(markViewedMock).not.toHaveBeenCalled();
  });

  it('GET /invoices/:id never exposes a draft (404)', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'draft' }, lines: [] });
    const res = await app().request(`/invoices/${INV_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(markViewedMock).not.toHaveBeenCalled();
  });

  it('GET /invoices/:id/pdf streams the stored PDF', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    getInvoicePdfMock.mockResolvedValue(Buffer.from('%PDF-portal'));
    const res = await app().request(`/invoices/${INV_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="INV-1.pdf"');
    expect(renderInvoicePdfMock).not.toHaveBeenCalled();
  });

  it('GET /invoices/:id/pdf renders on demand if no artifact exists', async () => {
    getCustomerInvoiceMock.mockResolvedValue({ invoice: { id: INV_ID, status: 'sent', invoiceNumber: 'INV-1' }, lines: [] });
    getInvoicePdfMock.mockResolvedValueOnce(null).mockResolvedValueOnce(Buffer.from('%PDF-rendered'));
    const res = await app().request(`/invoices/${INV_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(renderInvoicePdfMock).toHaveBeenCalledWith(INV_ID);
  });

  it('POST /invoices/:id/pay charges directly on the partner key (no Connect) + carries session_id', async () => {
    // invoice SELECT → a payable sent invoice with a 100.00 balance
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'USD', invoiceNumber: 'INV-1',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
    sessionsCreateMock.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1', payment_intent: 'pi_1' });
    dbResults.push([{ id: 'connection' }]);

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: expect.stringContaining('checkout.stripe.com') });
    expect(getPartnerStripeClientMock).toHaveBeenCalledWith('p1');
    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'payment',
        // v1 is card-only — the session must restrict to card so completion
        // never arrives 'unpaid' from an async method.
        payment_method_types: ['card'],
        // metadata key matches the design spec (section 6 step 3).
        expires_at: checkoutSessionExpiry().expiresAt,
        metadata: expect.objectContaining({ invoice_balance_cents: '10000' }),
        // The return URL must carry {CHECKOUT_SESSION_ID} for verify-on-return settle.
        success_url: expect.stringContaining('session_id={CHECKOUT_SESSION_ID}'),
      }),
      // No Connect stripeAccount option — the client is already the partner's. Only an
      // idempotency key keyed on (invoice, balance, phase) so a double-click reuses
      // the session.
      { idempotencyKey: `inv_${INV_ID}_10000_bal_e${checkoutSessionExpiry().quantum}` },
    );
    // the Stripe object → payment mapping row is recorded
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: INV_ID, stripeObjectId: 'cs_1', stripeAccountId: 'acct_9', status: 'pending',
    }));
  });

  it('POST /invoices/:id/pay uses currency-aware minor units for a zero-decimal currency (no 100x overcharge)', async () => {
    // A JPY invoice with a 1000-yen balance: JPY is zero-decimal, so unit_amount
    // must be 1000 (not 100000). The mapping amount stays the major-unit string.
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '1000.00', currencyCode: 'JPY', invoiceNumber: 'INV-JPY',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
    sessionsCreateMock.mockResolvedValue({ id: 'cs_jpy', url: 'https://checkout.stripe.com/c/cs_jpy', payment_intent: 'pi_jpy' });
    dbResults.push([{ id: 'connection' }]);

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({ unit_amount: 1000, currency: 'jpy' }),
        })],
        expires_at: checkoutSessionExpiry().expiresAt,
        metadata: expect.objectContaining({ invoice_balance_cents: '1000' }),
      }),
      { idempotencyKey: `inv_${INV_ID}_1000_bal_e${checkoutSessionExpiry().quantum}` },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      stripeObjectId: 'cs_jpy', amount: '1000.00', currency: 'JPY',
    }));
  });

  it('POST /invoices/:id/pay charges the deposit-remaining amount while the deposit is unmet', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '10000.00', depositDue: '3000.00', amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-DEP',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
    sessionsCreateMock.mockResolvedValue({ id: 'cs_dep', url: 'https://checkout.stripe.com/c/cs_dep', payment_intent: 'pi_dep' });
    dbResults.push([{ id: 'connection' }]);

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({
            unit_amount: 300000,
            product_data: { name: 'Deposit — Invoice INV-DEP' },
          }),
        })],
        expires_at: checkoutSessionExpiry().expiresAt,
        metadata: expect.objectContaining({ invoice_balance_cents: '300000' }),
      }),
      { idempotencyKey: `inv_${INV_ID}_300000_dep_e${checkoutSessionExpiry().quantum}` },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ amount: '3000.00' }));
  });

  it('POST /invoices/:id/pay charges the remaining balance (plain name) once the deposit is satisfied', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'partially_paid',
      balance: '7000.00', depositDue: '3000.00', amountPaid: '3000.00',
      currencyCode: 'USD', invoiceNumber: 'INV-DEP',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
    sessionsCreateMock.mockResolvedValue({ id: 'cs_dep2', url: 'https://checkout.stripe.com/c/cs_dep2', payment_intent: 'pi_dep2' });
    dbResults.push([{ id: 'connection' }]);

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(sessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [expect.objectContaining({
          price_data: expect.objectContaining({
            unit_amount: 700000,
            product_data: { name: 'Invoice INV-DEP' },
          }),
        })],
        expires_at: checkoutSessionExpiry().expiresAt,
        metadata: expect.objectContaining({ invoice_balance_cents: '700000' }),
      }),
      { idempotencyKey: `inv_${INV_ID}_700000_bal_e${checkoutSessionExpiry().quantum}` },
    );
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ amount: '7000.00' }));
  });

  it('POST /invoices/:id/pay deposit-phase and balance-phase idempotency keys differ for the SAME charge amount', async () => {
    // Mirrors the equivalent invoiceCheckout.test.ts case: a 50%-deposit invoice
    // where depositDue equals the eventual balance charge, so chargeMinor is
    // identical across the two sessions — only the dep/bal suffix disambiguates.
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '10000.00', depositDue: '5000.00', amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-EQ',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
    sessionsCreateMock.mockResolvedValue({ id: 'cs_dep_eq', url: 'https://checkout.stripe.com/c/cs_dep_eq', payment_intent: 'pi_dep_eq' });
    dbResults.push([{ id: 'connection' }]);
    await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    const depositKey = (sessionsCreateMock.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey;
    expect(depositKey).toBe(`inv_${INV_ID}_500000_dep_e${checkoutSessionExpiry().quantum}`);

    vi.clearAllMocks();
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'partially_paid',
      balance: '5000.00', depositDue: '5000.00', amountPaid: '5000.00',
      currencyCode: 'USD', invoiceNumber: 'INV-EQ',
    }]);
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));
    sessionsCreateMock.mockResolvedValue({ id: 'cs_bal_eq', url: 'https://checkout.stripe.com/c/cs_bal_eq', payment_intent: 'pi_bal_eq' });
    dbResults.push([{ id: 'connection' }]);
    await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    const balanceKey = (sessionsCreateMock.mock.calls[0]?.[1] as { idempotencyKey: string }).idempotencyKey;
    expect(balanceKey).toBe(`inv_${INV_ID}_500000_bal_e${checkoutSessionExpiry().quantum}`);

    expect(depositKey).not.toBe(balanceKey);
  });

  it('POST /invoices/:id/pay returns 409 Nothing to pay when the charge-now amount is zero', async () => {
    // A payable-status invoice whose charge-now amount computes to zero must be
    // rejected BEFORE any Stripe work (the guard now fires on chargeMinor, the
    // computeChargeNow output, not the raw balance).
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '0.00', depositDue: null, amountPaid: '0.00',
      currencyCode: 'USD', invoiceNumber: 'INV-ZERO',
    }]);

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'Nothing to pay' });
    expect(getPartnerStripeClientMock).not.toHaveBeenCalled();
    expect(sessionsCreateMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it('POST /invoices/:id/pay returns 409 when the partner has no Stripe key configured', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'USD', invoiceNumber: 'INV-2',
    }]);
    getPartnerStripeClientMock.mockRejectedValue(new PartnerStripeError('not connected', 'NO_STRIPE_KEY'));

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  it('POST /invoices/:id/pay returns 500 (not 409) when the stored key is unreadable', async () => {
    // A corrupt/undecryptable key is an internal fault — surfacing it as 409
    // "not available" would lie about why payment failed (mirrors createInvoicePayLink).
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'USD', invoiceNumber: 'INV-3',
    }]);
    getPartnerStripeClientMock.mockRejectedValue(new PartnerStripeError('unreadable', 'STRIPE_KEY_UNREADABLE'));

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(sessionsCreateMock).not.toHaveBeenCalled();
  });

  it('POST /invoices/:id/pay maps a Stripe currency rejection to a customer-safe 409 STRIPE_CURRENCY_UNSUPPORTED', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'CHF', invoiceNumber: 'INV-CHF',
    }]);
    getPartnerStripeClientMock.mockResolvedValue({ ...partnerClient(), defaultCurrency: 'USD' });
    sessionsCreateMock.mockRejectedValue(Object.assign(new Error('Invalid currency: chf'), {
      type: 'StripeInvalidRequestError', code: 'currency_not_supported',
    }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Online payment is not available for this invoice — please contact the sender.',
      code: 'STRIPE_CURRENCY_UNSUPPORTED',
    });
    expect(insertValuesMock).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('[portal/invoices] Stripe rejected currency', expect.objectContaining({ invoiceId: INV_ID, currency: 'CHF' }));
    errSpy.mockRestore();
  });

  it('POST /invoices/:id/pay never surfaces the partner currency-mismatch warning to the customer', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'EUR', invoiceNumber: 'INV-EUR',
    }]);
    getPartnerStripeClientMock.mockResolvedValue({ ...partnerClient(), defaultCurrency: 'USD' });
    sessionsCreateMock.mockResolvedValue({ id: 'cs_eur', url: 'https://checkout.stripe.com/c/cs_eur', payment_intent: 'pi_eur' });
    dbResults.push([{ id: 'connection' }]);

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.com/c/cs_eur' });
  });

  it('does not return a Checkout URL when the connected account changes during session creation', async () => {
    dbResults.push([{
      id: INV_ID, orgId: ORG_ID, partnerId: 'p1', status: 'sent',
      balance: '100.00', currencyCode: 'USD', invoiceNumber: 'INV-RACE',
    }]);
    dbResults.push([]); // final FOR SHARE revalidation sees replacement/disconnect
    getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_old'));
    sessionsCreateMock.mockResolvedValue({
      id: 'cs_orphan_candidate', url: 'https://checkout.stripe.com/c/cs_orphan_candidate', payment_intent: 'pi_race',
    });

    const res = await app().request(`/invoices/${INV_ID}/pay`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  // ---- verify-on-return settle ----

  function settle(sessionId: unknown, orgId = ORG_ID) {
    return app(orgId).request(`/invoices/${INV_ID}/settle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  }

  it('POST /invoices/:id/settle settles the session for this invoice and returns the result', async () => {
    dbResults.push([{ id: INV_ID, partnerId: 'p1' }]);   // invoice SELECT
    dbResults.push([{ id: 'map_1' }]);                    // mapping SELECT (session belongs to this invoice)
    settleCheckoutSessionMock.mockResolvedValue({ settled: true, invoiceId: INV_ID });

    const res = await settle('cs_123');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settled: true, invoiceId: INV_ID });
    expect(settleCheckoutSessionMock).toHaveBeenCalledWith('p1', 'cs_123');
  });

  it('POST /invoices/:id/settle settles with NO DB context held (#7065)', async () => {
    dbResults.push([{ id: INV_ID, partnerId: 'p1' }]);   // invoice SELECT
    dbResults.push([{ id: 'map_1' }]);                    // mapping SELECT
    let depthAtSettle = -1;
    settleCheckoutSessionMock.mockImplementation(async () => {
      depthAtSettle = ctx.depth;
      return { settled: true, invoiceId: INV_ID };
    });
    const res = await settle('cs_123');
    expect(res.status).toBe(200);
    expect(depthAtSettle).toBe(0);
  });

  it('POST /invoices/:id/settle returns settled:false (no settle call) for a session not tied to this invoice', async () => {
    dbResults.push([{ id: INV_ID, partnerId: 'p1' }]);   // invoice SELECT
    dbResults.push([]);                                   // mapping SELECT → none (foreign/unknown session)

    const res = await settle('cs_foreign');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settled: false });
    expect(settleCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('POST /invoices/:id/settle 404s for an invoice not in this org', async () => {
    dbResults.push([]);                                   // invoice SELECT → none (cross-tenant)

    const res = await settle('cs_123');
    expect(res.status).toBe(404);
    expect(settleCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('POST /invoices/:id/settle swallows a settle error as settled:false (sweep is the backstop)', async () => {
    dbResults.push([{ id: INV_ID, partnerId: 'p1' }]);   // invoice SELECT
    dbResults.push([{ id: 'map_1' }]);                    // mapping SELECT
    settleCheckoutSessionMock.mockRejectedValue(new Error('stripe timeout'));

    const res = await settle('cs_123');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settled: false });
  });

  it('POST /invoices/:id/settle does NOT swallow the held-DB-context assertion (#7065)', async () => {
    dbResults.push([{ id: INV_ID, partnerId: 'p1' }]);   // invoice SELECT
    dbResults.push([{ id: 'map_1' }]);                    // mapping SELECT
    settleCheckoutSessionMock.mockRejectedValue(new HeldCtxError('held'));

    const res = await settle('cs_123');
    expect(res.status).toBe(500);
  });
});

vi.mock('../../services/autopay/payAndSave', async importOriginal => {
  const actual = await importOriginal<typeof import('../../services/autopay/payAndSave')>();
  return { ...actual, getInvoiceAutopayOffer: vi.fn(async () => null),
    bindCardPayAndSave:vi.fn(async()=>{}),
    prepareCardPayAndSave: vi.fn(async (_invoiceId: string, _orgId: string, input: { saveForAutopay?: boolean }) => {
      if (input.saveForAutopay) throw new Error('Unexpected accepted save in ordinary-payment fixture');
      return null;
    }) };
});

it('reuses a portal Checkout mapping on repeated create',async()=>{
 mappings.clear();dbResults.length=0;
 getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));sessionsCreateMock.mockResolvedValue({id:'cs_reuse',url:'https://checkout.stripe.com/c/cs_reuse'});
 for(let i=0;i<2;i++){
  dbResults.push([{id:INV_ID,orgId:ORG_ID,partnerId:'p1',status:'sent',balance:'100.00',currencyCode:'USD'}],[{id:'connection'}],[]);if(i)dbResults.push([{invoiceId:INV_ID,stripeAccountId:'acct_9'}]);
  const response=await app().request(`/invoices/${INV_ID}/pay`,{method:'POST'});
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({url:'https://checkout.stripe.com/c/cs_reuse'});
 }
 expect(mappings.size).toBe(1);
 // Ordinary portal payments save nothing; Link stays available there.
 for(const [params] of sessionsCreateMock.mock.calls)expect(params).not.toHaveProperty('wallet_options');
});
it('portal pay-and-save forwards consent and binds card-only off-session Checkout',async()=>{
 mappings.clear();dbResults.length=0;
 const capture={id:'33333333-3333-4333-8333-333333333333',stripeCustomerId:'cus_saved'};
 vi.mocked(prepareCardPayAndSave).mockResolvedValueOnce(capture as any);
 dbResults.push([{id:INV_ID,orgId:ORG_ID,partnerId:'p1',status:'sent',balance:'100.00',currencyCode:'USD'}],[{id:'connection'}],[]);
 getPartnerStripeClientMock.mockResolvedValue(partnerClient('acct_9'));sessionsCreateMock.mockResolvedValue({id:'cs_saved',url:'https://checkout.stripe.com/c/cs_saved',payment_intent:'pi_saved'});
 const response=await app().request(`/invoices/${INV_ID}/pay`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({saveForAutopay:true,consentAccepted:true,disclosureHash:'a'.repeat(64)})});
 expect(response.status).toBe(200);
 expect(prepareCardPayAndSave).toHaveBeenCalledWith(INV_ID,ORG_ID,expect.objectContaining({saveForAutopay:true,consentAccepted:true,disclosureHash:'a'.repeat(64)}),expect.any(String));
 expect(sessionsCreateMock).toHaveBeenCalledWith(expect.objectContaining({payment_method_types:['card'],customer:'cus_saved',payment_intent_data:{setup_future_usage:'off_session',metadata:{autopay_setup_attempt_id:capture.id}},
  wallet_options:{link:{display:'never'}}}),expect.anything());
 const {bindCardPayAndSave}=await import('../../services/autopay/payAndSave');
 expect(bindCardPayAndSave).toHaveBeenCalledWith(capture,expect.objectContaining({id:'cs_saved'}));
});

it('bank pay validates strict consent and preserves the setup envelope',async()=>{
 dbResults.length=0;dbResults.push([{id:INV_ID,orgId:ORG_ID,partnerId:'p1',status:'sent',balance:'100.00',currencyCode:'USD'}]);
 bankRoutes.setup.mockResolvedValue({url:'https://checkout.stripe.com/setup'});
 const body={methodType:'us_bank_account',phase:'setup',consentAccepted:true,principal:'100.00',fee:'0.00',currency:'USD',disclosureHash:'a'.repeat(64)};
 const response=await app().request(`/invoices/${INV_ID}/pay`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 expect(response.status).toBe(200);expect(await response.json()).toEqual({url:'https://checkout.stripe.com/setup'});
 expect(bankRoutes.setup).toHaveBeenCalledWith(expect.objectContaining({invoiceId:INV_ID,orgId:ORG_ID,returnTo:'portal'}));
 const invalid=await app().request(`/invoices/${INV_ID}/pay`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,consentAccepted:false})});
 expect(invalid.status).toBe(400);
});
it('bank collect requires invoice admission and never treats the session ID as authority',async()=>{
 bankRoutes.collect.mockClear();
 dbResults.length=0;
 const response=await app().request(`/invoices/${INV_ID}/pay`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
  methodType:'us_bank_account',phase:'collect',consentAccepted:true,principal:'100.00',fee:'0.00',currency:'USD',disclosureHash:'a'.repeat(64),setupSessionId:'cs_test',
 })});
 expect(response.status).toBe(404);expect(bankRoutes.collect).not.toHaveBeenCalled();
});

it.each(['refused','deferred','failed','canceled'])('bank %s is a conflict rather than a successful payment',async outcome=>{
 dbResults.length=0;dbResults.push([{id:INV_ID,orgId:ORG_ID,partnerId:'p1',status:'sent',balance:'100.00',currencyCode:'USD'}]);
 bankRoutes.collect.mockResolvedValue({attemptId:null,outcome,reason:'unavailable'});
 const response=await app().request(`/invoices/${INV_ID}/pay`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
 methodType:'us_bank_account',phase:'collect',consentAccepted:true,principal:'100.00',fee:'0.00',currency:'USD',disclosureHash:'a'.repeat(64),setupSessionId:'cs_test'
 })});
 expect(response.status).toBe(409);
});
