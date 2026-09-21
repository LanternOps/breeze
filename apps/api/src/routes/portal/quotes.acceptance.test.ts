import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// DB mock: select().from().where().limit()/orderBy() resolves to the next queued
// row set, consumed FIFO in call order. Mirrors quotes.test.ts.
//
// orderBy's direction is made observable: it inspects the drizzle `desc()`
// SQL wrapper (its `queryChunks` contain a trailing " desc" value chunk) and,
// if descending, sorts the queued rows about to resolve by `signedAt` — so a
// test that queues acceptance rows in ascending signedAt order and asserts the
// LATEST one wins actually exercises the route's `desc(...)` call.
const isDescOrderBy = (arg: unknown): boolean => {
  const chunks = (arg as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return false;
  return chunks.some((chunk) => {
    const value = (chunk as { value?: unknown })?.value;
    return Array.isArray(value) && value.some((v) => typeof v === 'string' && v.includes('desc'));
  });
};
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../../db', () => {
  let descending = false;
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'limit', 'where']) chain[m] = vi.fn(() => chain);
    chain.orderBy = vi.fn((arg: unknown) => { descending = isDescOrderBy(arg); return chain; });
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = dbResults.shift() ?? [];
      const ordered = descending && (rows as any[]).every((r) => 'signedAt' in r)
        ? [...(rows as any[])].sort((a, b) => (a.signedAt < b.signedAt ? 1 : a.signedAt > b.signedAt ? -1 : 0))
        : rows;
      descending = false;
      return Promise.resolve(ordered).then(resolve);
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

  it('picks the LATEST acceptance by signedAt when more than one row exists', async () => {
    queueDetailReads();
    dbResults.push([]); // successor SELECT
    // Queued in ascending signedAt order (earliest first) — a wrong (ascending)
    // orderBy would hand back 'customer' (the earlier row's origin) instead.
    dbResults.push([
      { origin: 'customer', signedAt: '2026-09-19T00:00:00.000Z' },
      { origin: 'on_behalf', signedAt: '2026-09-20T00:00:00.000Z' },
    ]);

    const res = await app().request(`/quotes/${QUOTE_ID}`, { method: 'GET' });
    const body = await res.json();
    expect(body.data.quote.acceptanceOrigin).toBe('on_behalf');
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
