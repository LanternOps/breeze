import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// DB mock: select().from().where().limit()/orderBy() resolves to the next queued
// row set, consumed FIFO in call order. Mirrors quotes.test.ts.
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'orderBy', 'limit', 'where']) chain[m] = vi.fn(() => chain);
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

const { renderQuotePdfMock } = vi.hoisted(() => ({ renderQuotePdfMock: vi.fn() }));
vi.mock('../../services/quotePdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/quotePdf')>();
  return { ...actual, renderQuotePdf: renderQuotePdfMock };
});

const { mergeMock } = vi.hoisted(() => ({ mergeMock: vi.fn() }));
vi.mock('../../services/pdfMerge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/pdfMerge')>();
  return { ...actual, mergeUploadedContractPdfs: mergeMock };
});

const { acceptQuoteMock, emitAcceptInvoiceIssuedMock, declineQuoteByActorMock } = vi.hoisted(() => ({
  acceptQuoteMock: vi.fn(),
  emitAcceptInvoiceIssuedMock: vi.fn(),
  declineQuoteByActorMock: vi.fn(),
}));
vi.mock('../../services/quoteAcceptService', () => ({
  acceptQuote: acceptQuoteMock,
  emitAcceptInvoiceIssued: emitAcceptInvoiceIssuedMock,
  autoEmailAcceptedInvoice: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/quoteLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/quoteLifecycle')>();
  return { ...actual, declineQuoteByActor: declineQuoteByActorMock };
});

import { quoteRoutes as portalQuoteRoutes } from './quotes';

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const QUOTE_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

function app(orgId = ORG_ID) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu1', orgId, email: 'c@example.test', name: 'Cust', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer',
      timezone: 'UTC',
    });
    await next();
  });
  a.route('/', portalQuoteRoutes);
  return a;
}

describe('portal GET /quotes/:id acceptanceOrigin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
  });

  const queueDetailReads = (over: Record<string, unknown> = {}) => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      quoteNumber: 'Q-1', currencyCode: 'USD', taxRate: null,
      depositType: 'none', depositPercent: null, ...over,
    }]); // quote SELECT
    dbResults.push([]); // quoteBlocks
    dbResults.push([]); // quoteLines
    dbResults.push([]); // markQuoteViewed's own quotes SELECT
    dbResults.push([{ name: 'Lantern IT' }]); // partners
    dbResults.push([]); // portalBranding
  };

  it('exposes the acceptance origin and nothing else', async () => {
    queueDetailReads();
    dbResults.push([]); // successor SELECT
    dbResults.push([{ origin: 'on_behalf' }]); // acceptance SELECT — origin only

    const res = await app().request(`/quotes/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.quote.acceptanceOrigin).toBe('on_behalf');
    // Method and reference are the MSP's internal evidence trail. Leaking them
    // to the customer's portal would publish free text a tech wrote about them.
    expect(JSON.stringify(body.data)).not.toContain('PO 4471');
    expect(JSON.stringify(body.data)).not.toContain('purchase_order');
  });

  it('reports null acceptanceOrigin when nobody has accepted', async () => {
    queueDetailReads();
    dbResults.push([]); // successor SELECT
    dbResults.push([]); // acceptance SELECT — nothing

    const res = await app().request(`/quotes/${QUOTE_ID}`, { method: 'GET' });
    const body = await res.json();
    expect(body.data.quote.acceptanceOrigin).toBeNull();
  });
});
