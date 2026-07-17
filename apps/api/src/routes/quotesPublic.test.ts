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
const TEMPLATE_ID = '44444444-4444-4444-4444-444444444444';
const VERSION_ID = '55555555-5555-5555-5555-555555555555';
const BLOCK_ID = '66666666-6666-6666-6666-666666666666';

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

  // Cosmetic view-stamping must never fail the unauthenticated render — a
  // transient markQuoteViewed failure is swallowed (console.error'd) and the
  // route still returns 200 with the quote payload. Mirrors the authenticated
  // counterpart's coverage in routes/portal/quotes.test.ts.
  it('still returns 200 with the quote payload when markQuoteViewed rejects', async () => {
    (markQuoteViewed as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('transient db failure'));
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      quoteNumber: 'Q-1', currencyCode: 'USD', taxRate: null,
      depositType: 'none', depositPercent: null,
    }]); // quote SELECT
    dbResults.push([]); // quoteBlocks SELECT
    dbResults.push([]); // quoteLines SELECT
    dbResults.push([{ name: 'Lantern IT' }]); // partners SELECT
    dbResults.push([]); // portalBranding SELECT

    const res = await app().request(`/quotes/public/${TOKEN}`, { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.quote.id).toBe(QUOTE_ID);
  });

  it('serializes an authored contract block with renderedHtml containing the substituted client name; no raw {{ tokens }} anywhere in the payload', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      quoteNumber: 'Q-1', title: 'Managed Services', currencyCode: 'USD', taxRate: null,
      depositType: 'none', depositPercent: null, expiryDate: '2026-08-01',
      billToName: 'Acme Co', billToAddress: null, sellerSnapshot: null,
      oneTimeTotal: '0.00', monthlyRecurringTotal: '0.00', annualRecurringTotal: '0.00', total: '0.00',
    }]); // quote SELECT
    dbResults.push([
      { id: BLOCK_ID, quoteId: QUOTE_ID, orgId: ORG_ID, blockType: 'contract', content: { templateId: TEMPLATE_ID, templateVersionId: VERSION_ID, variableValues: { governing_state: 'Texas' } }, sortOrder: 0 },
    ]); // quoteBlocks SELECT
    dbResults.push([]); // quoteLines SELECT
    dbResults.push([{ name: 'Lantern IT' }]); // partners SELECT
    dbResults.push([]); // portalBranding SELECT
    dbResults.push([{
      id: VERSION_ID, templateId: TEMPLATE_ID, orgId: null, partnerId: PARTNER_ID, versionNumber: 2, status: 'published',
      sourceType: 'authored', bodyHtml: '<p>{{client.name}} agrees to {{governing_state}}</p>', fileData: null, mime: null, byteSize: null,
      sha256: 'sha', declaredVariables: [{ name: 'client.name', kind: 'auto' }, { name: 'governing_state', kind: 'manual' }],
      publishedAt: new Date('2026-07-01T00:00:00Z'), createdBy: 'user-1', createdAt: new Date('2026-07-01T00:00:00Z'),
    }]); // contractTemplateVersions SELECT (loadContractBlockRenderData, system context)
    dbResults.push([{
      id: TEMPLATE_ID, orgId: null, partnerId: PARTNER_ID, name: 'MSA', description: null, status: 'active',
      createdBy: 'user-1', createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z'),
    }]); // contractTemplates SELECT

    const res = await app().request(`/quotes/public/${TOKEN}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('{{');

    const contractBlock = body.data.blocks.find((b: { id: string }) => b.id === BLOCK_ID);
    expect(contractBlock.content.sourceType).toBe('authored');
    expect(contractBlock.content.renderedHtml).toContain('Acme Co');
    expect(contractBlock.content.renderedHtml).toContain('Texas');
    expect(contractBlock.content.fileUrl).toBeNull();
    expect(contractBlock.content.templateName).toBe('MSA');
    expect(contractBlock.content.versionNumber).toBe(2);
    expect(contractBlock.content).not.toHaveProperty('templateId');
    expect(contractBlock.content).not.toHaveProperty('templateVersionId');
    // Parity: the ADMIN editor gets an `authoring` block; the public
    // (unauthenticated) payload must NEVER carry it.
    expect(contractBlock.content).not.toHaveProperty('authoring');
  });

  it('serializes an uploaded contract block with a null renderedHtml and a token-gated contract-file fileUrl', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      quoteNumber: 'Q-1', currencyCode: 'USD', taxRate: null, depositType: 'none', depositPercent: null,
    }]); // quote SELECT
    dbResults.push([
      { id: BLOCK_ID, quoteId: QUOTE_ID, orgId: ORG_ID, blockType: 'contract', content: { templateId: TEMPLATE_ID, templateVersionId: VERSION_ID, variableValues: {} }, sortOrder: 0 },
    ]); // quoteBlocks SELECT
    dbResults.push([]); // quoteLines SELECT
    dbResults.push([{ name: 'Lantern IT' }]); // partners SELECT
    dbResults.push([]); // portalBranding SELECT
    dbResults.push([{
      id: VERSION_ID, templateId: TEMPLATE_ID, orgId: null, partnerId: PARTNER_ID, versionNumber: 1, status: 'published',
      sourceType: 'uploaded', bodyHtml: null, fileData: Buffer.from('%PDF-1.4'), mime: 'application/pdf', byteSize: 8,
      sha256: 'sha2', declaredVariables: [], publishedAt: new Date('2026-07-01T00:00:00Z'), createdBy: 'user-1', createdAt: new Date('2026-07-01T00:00:00Z'),
    }]); // contractTemplateVersions SELECT
    dbResults.push([{
      id: TEMPLATE_ID, orgId: null, partnerId: PARTNER_ID, name: 'Uploaded MSA', description: null, status: 'active',
      createdBy: 'user-1', createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z'),
    }]); // contractTemplates SELECT

    const res = await app().request(`/quotes/public/${TOKEN}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    const contractBlock = body.data.blocks.find((b: { id: string }) => b.id === BLOCK_ID);
    expect(contractBlock.content.sourceType).toBe('uploaded');
    expect(contractBlock.content.renderedHtml).toBeNull();
    expect(contractBlock.content.fileUrl).toBe(`/quotes/public/${encodeURIComponent(TOKEN)}/contract-file/${BLOCK_ID}`);
  });
});

describe('quotesPublic GET /:token/contract-file/:blockId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
    (verifyQuoteAcceptToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      quoteId: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: 'jti-1',
    });
    (isQuoteAcceptJtiRevoked as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  });

  it('streams application/pdf for an uploaded contract block on the token\'s own quote', async () => {
    dbResults.push([{ id: QUOTE_ID }]); // quotes SELECT (token-resolved org/quote)
    dbResults.push([
      { id: BLOCK_ID, quoteId: QUOTE_ID, orgId: ORG_ID, blockType: 'contract', content: { templateId: TEMPLATE_ID, templateVersionId: VERSION_ID, variableValues: {} } },
    ]); // quoteBlocks SELECT (scoped to this quote id + blockType contract)
    dbResults.push([{
      id: VERSION_ID, templateId: TEMPLATE_ID, orgId: null, partnerId: PARTNER_ID, versionNumber: 1, status: 'published',
      sourceType: 'uploaded', bodyHtml: null, fileData: Buffer.from('%PDF-1.4'), mime: 'application/pdf', byteSize: 8,
      sha256: 'sha3', declaredVariables: [], publishedAt: new Date('2026-07-01T00:00:00Z'), createdBy: 'user-1', createdAt: new Date('2026-07-01T00:00:00Z'),
    }]); // contractTemplateVersions SELECT
    dbResults.push([{
      id: TEMPLATE_ID, orgId: null, partnerId: PARTNER_ID, name: 'MSA', description: null, status: 'active',
      createdBy: 'user-1', createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z'),
    }]); // contractTemplates SELECT

    const res = await app().request(`/quotes/public/${TOKEN}/contract-file/${BLOCK_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.toString()).toBe('%PDF-1.4');
  });

  it('404s a blockId that does not belong to this token\'s quote (cross-quote blockId)', async () => {
    dbResults.push([{ id: QUOTE_ID }]); // quotes SELECT succeeds — token resolves QUOTE_ID
    dbResults.push([]); // quoteBlocks SELECT — the quoteId filter excludes a block from a different quote
    const res = await app().request(`/quotes/public/${TOKEN}/contract-file/${BLOCK_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('401s an invalid/expired token without querying the DB', async () => {
    (verifyQuoteAcceptToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await app().request(`/quotes/public/${TOKEN}/contract-file/${BLOCK_ID}`, { method: 'GET' });
    expect(res.status).toBe(401);
  });
});
