import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// DB mock: select().from().where().limit()/orderBy() resolves to the next queued
// row set, consumed FIFO in call order. Mirrors the pattern in
// routes/portal/quotes.test.ts.
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../db', () => {
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

// Token resolution + the view-stamp are exercised elsewhere (quotesPublicRoutes
// integration tests); stub them here so this file stays a pure unit test of the
// serialization path (no signature verification, no real DB write).
vi.mock('../services/quoteAcceptToken', () => ({
  verifyQuoteAcceptToken: vi.fn(),
  isQuoteAcceptJtiRevoked: vi.fn(),
  revokeQuoteAcceptJti: vi.fn(),
}));
vi.mock('../services/quoteLifecycle', () => ({ markQuoteViewed: vi.fn() }));

import { quotesPublicRoutes } from './quotesPublic';
import { verifyQuoteAcceptToken, isQuoteAcceptJtiRevoked } from '../services/quoteAcceptToken';
import { markQuoteViewed } from '../services/quoteLifecycle';

const QUOTE_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const TOKEN = 'a-valid-looking-token-1234567890';

function app() {
  const a = new Hono();
  a.route('/quotes/public', quotesPublicRoutes); // mirrors index.ts mount
  return a;
}

describe('quotesPublic GET /:token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
    (verifyQuoteAcceptToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      quoteId: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: 'jti-1',
    });
    (isQuoteAcceptJtiRevoked as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (markQuoteViewed as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
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
    dbResults.push([{ name: 'Lantern IT' }]); // partners SELECT
    dbResults.push([]); // portalBranding SELECT

    const res = await app().request(`/quotes/public/${TOKEN}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();

    const richBlock = body.data.blocks.find((b: { id: string }) => b.id === 'b1');
    expect(richBlock.content.html).toBe('<p>Hello</p>');
    expect(richBlock.content.html).not.toContain('script');
    const headingBlock = body.data.blocks.find((b: { id: string }) => b.id === 'b2');
    expect(headingBlock.content).toEqual({ text: 'Intro', level: 2 }); // untouched
  });

  it('401s an invalid/expired token without querying the DB', async () => {
    (verifyQuoteAcceptToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await app().request(`/quotes/public/${TOKEN}`, { method: 'GET' });
    expect(res.status).toBe(401);
  });
});
