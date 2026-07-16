import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// DB mock: select().from().where().limit()/orderBy() resolves to the next queued
// row set, consumed FIFO in call order. Mirrors the pattern in
// routes/portal/invoices.test.ts and services/invoiceCheckout.test.ts.
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = dbResults.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  return {
    db: makeChain(),
    runOutsideDbContext: <T>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

// The route dynamically imports renderQuotePdf — vi.mock still intercepts it
// regardless of the static/dynamic import site. Spying (not exercising pdfkit)
// lets the test assert on exactly what the route computed and handed over.
const { renderQuotePdfMock } = vi.hoisted(() => ({ renderQuotePdfMock: vi.fn() }));
vi.mock('../../services/quotePdf', () => ({ renderQuotePdf: renderQuotePdfMock }));

import { quoteRoutes as portalQuoteRoutes } from './quotes';

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const QUOTE_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

function app(orgId = ORG_ID) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId, email: 'c@example.test', name: 'Cust', receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer',
    });
    await next();
  });
  a.route('/', portalQuoteRoutes);
  return a;
}

describe('portal quotes GET /quotes/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
  });

  it('sanitizes a legacy dirty rich_text block (script tag) before it leaves the API', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      quoteNumber: 'Q-1', currencyCode: 'USD', taxRate: null,
      depositType: 'none', depositPercent: null,
    }]); // quote SELECT
    dbResults.push([
      { id: 'b1', quoteId: QUOTE_ID, orgId: ORG_ID, blockType: 'rich_text', content: { html: '<p>Hello</p><script>alert(1)</script>' }, sortOrder: 0 },
      { id: 'b2', quoteId: QUOTE_ID, orgId: ORG_ID, blockType: 'heading', content: { text: 'Intro', level: 2 }, sortOrder: 1 },
    ]); // quoteBlocks SELECT — one legacy dirty row, one unrelated block type
    dbResults.push([]); // quoteLines SELECT
    dbResults.push([]); // markQuoteViewed's own quotes SELECT (no match → silent no-op)

    const res = await app().request(`/quotes/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();

    const richBlock = body.data.blocks.find((b: { id: string }) => b.id === 'b1');
    expect(richBlock.content.html).toBe('<p>Hello</p>');
    expect(richBlock.content.html).not.toContain('script');
    const headingBlock = body.data.blocks.find((b: { id: string }) => b.id === 'b2');
    expect(headingBlock.content).toEqual({ text: 'Intro', level: 2 }); // untouched
  });

  it('404s for a quote outside the customer org', async () => {
    dbResults.push([]); // quote SELECT → none
    const res = await app().request(`/quotes/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
  });
});

describe('portal quotes /:id/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
    renderQuotePdfMock.mockResolvedValue(Buffer.from('%PDF-test'));
  });

  it('sanitizes a legacy dirty rich_text block before handing blocks to the PDF renderer', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      quoteNumber: 'Q-1', currencyCode: 'USD', taxRate: null,
      depositType: 'none', depositPercent: null, sellerSnapshot: null, terms: null,
    }]); // quote SELECT
    dbResults.push([
      { id: 'b1', quoteId: QUOTE_ID, orgId: ORG_ID, blockType: 'rich_text', content: { html: '<p>Hi</p><script>alert(1)</script>' }, sortOrder: 0 },
    ]); // quoteBlocks SELECT
    dbResults.push([]); // quoteLines SELECT
    dbResults.push([{ name: 'Lantern IT', billingCompanyName: null, billingEmail: null, billingPhone: null, billingWebsite: null, billingAddressLine1: null, billingAddressLine2: null, billingAddressCity: null, billingAddressRegion: null, billingAddressPostalCode: null, billingAddressCountry: null, invoiceFooter: null, currencyCode: 'USD' }]); // partners SELECT (system ctx)
    dbResults.push([]); // portalBranding SELECT

    const res = await app().request(`/quotes/${QUOTE_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);

    const [, blocksArg] = renderQuotePdfMock.mock.calls[0] as [unknown, { content: { html: string } }[]];
    expect(blocksArg[0]!.content.html).toBe('<p>Hi</p>');
    expect(blocksArg[0]!.content.html).not.toContain('script');
  });

  it('feeds renderQuotePdf the same totals sweep as GET /quotes/:id (dueOnAcceptanceTotal + categoryBreakdown), not the raw tax-exclusive fallback', async () => {
    // One-time $6200 taxable hardware line (deposit-eligible) + $2400 taxable
    // labor line, 10% tax, selected_lines deposit on the hardware line only.
    // Reference numbers: dueOnAcceptanceTotal '9460.00', deposit '6820.00',
    // remaining balance '2640.00' (9460.00 - 6820.00).
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      quoteNumber: 'Q-1', currencyCode: 'USD', taxRate: '0.10',
      depositType: 'selected_lines', depositPercent: null, depositAmount: '6820.00',
      sellerSnapshot: null, terms: null,
    }]); // quote SELECT
    dbResults.push([]); // quoteBlocks SELECT
    dbResults.push([
      {
        id: 'l1', quoteId: QUOTE_ID, quantity: '1', unitPrice: '6200.00', unitCost: '4000.00',
        taxable: true, customerVisible: true, recurrence: 'one_time',
        depositEligible: true, itemType: 'hardware',
      },
      {
        id: 'l2', quoteId: QUOTE_ID, quantity: '1', unitPrice: '2400.00', unitCost: '1200.00',
        taxable: true, customerVisible: true, recurrence: 'one_time',
        depositEligible: false, itemType: 'service',
      },
    ]); // quoteLines SELECT
    dbResults.push([{ name: 'Lantern IT', billingCompanyName: null, billingEmail: null, billingPhone: null, billingWebsite: null, billingAddressLine1: null, billingAddressLine2: null, billingAddressCity: null, billingAddressRegion: null, billingAddressPostalCode: null, billingAddressCountry: null, invoiceFooter: null, currencyCode: 'USD' }]); // partners SELECT (system ctx)
    dbResults.push([]); // portalBranding SELECT

    const res = await app().request(`/quotes/${QUOTE_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');

    expect(renderQuotePdfMock).toHaveBeenCalledOnce();
    const [quoteArg] = renderQuotePdfMock.mock.calls[0] as [Record<string, unknown>, unknown, unknown, unknown, unknown];
    expect(quoteArg.dueOnAcceptanceTotal).toBe('9460.00');
    expect(quoteArg.categoryBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'hardware', oneTimeTotal: '6200.00' }),
        expect.objectContaining({ category: 'service', oneTimeTotal: '2400.00' }),
      ]),
    );
    // Deposit (frozen depositAmount, unrelated to the totals sweep) + the derived
    // due-on-acceptance together let the PDF renderer compute the correct
    // tax-inclusive remaining balance (9460.00 - 6820.00 = 2640.00), instead of
    // silently falling back to the tax-exclusive oneTimeTotal.
    expect(quoteArg.depositAmount).toBe('6820.00');
  });

  it('404s for a quote outside the customer org (no PDF render)', async () => {
    dbResults.push([]); // quote SELECT → none
    const res = await app().request(`/quotes/${QUOTE_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(404);
    expect(renderQuotePdfMock).not.toHaveBeenCalled();
  });
});
