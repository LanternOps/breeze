import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// DB mock: select().from().where().limit()/orderBy() resolves to the next queued
// row set, consumed FIFO in call order. Mirrors the pattern in
// routes/portal/quotes.test.ts.
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'orderBy', 'limit', 'update', 'set', 'returning', 'for']) chain[m] = vi.fn(() => chain);
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
import { db } from '../db';
import { verifyQuoteAcceptToken, isQuoteAcceptJtiRevoked, revokeQuoteAcceptJti } from '../services/quoteAcceptToken';
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

  it('returns an exact public quote header keyset without internal row fields', async () => {
    dbResults.push([{
      id: QUOTE_ID,
      partnerId: 'internal-partner-sentinel',
      orgId: 'internal-org-sentinel',
      siteId: 'internal-site-sentinel',
      quoteNumber: 'Q-1',
      title: 'Managed Services',
      status: 'sent',
      currencyCode: 'USD',
      issueDate: '2026-07-01',
      expiryDate: '2026-08-01',
      subtotal: '100.00',
      taxRate: null,
      taxTotal: '0.00',
      total: '100.00',
      oneTimeTotal: '100.00',
      monthlyRecurringTotal: '0.00',
      annualRecurringTotal: '0.00',
      depositType: 'none',
      depositPercent: null,
      depositAmount: null,
      billToName: 'Acme Co',
      introNotes: 'Welcome',
      terms: 'Net 30',
      sellerSnapshot: {
        name: 'Lantern IT',
        address: null,
        phone: null,
        email: null,
        website: null,
        internalSellerSentinel: 'do-not-serialize',
      },
      coverPage: {
        enabled: false,
        showPreparedBy: true,
        internalCoverSentinel: 'do-not-serialize',
      },
      termsAndConditions: 'Customer terms',
      declineReason: 'internal-decline-sentinel',
      convertedInvoiceId: 'internal-invoice-sentinel',
      pdfDocumentRef: 'internal-document-sentinel',
      pdfSha256: 'internal-sha-sentinel',
      sentAt: 'internal-sent-sentinel',
      sendScheduledAt: 'internal-schedule-sentinel',
      sendJobId: 'internal-job-sentinel',
      sendEmailReason: 'internal-failure-sentinel',
      firstViewedAt: 'internal-first-view-sentinel',
      viewedAt: 'internal-viewed-sentinel',
      createdBy: 'internal-creator-sentinel',
      createdAt: 'internal-created-sentinel',
      updatedAt: 'internal-updated-sentinel',
    }]);
    dbResults.push([]);
    dbResults.push([]);
    dbResults.push([{ name: 'Lantern IT' }]);
    dbResults.push([]);

    const res = await app().request(`/quotes/public/${TOKEN}`, { method: 'GET' });
    const body = await res.json();
    const header = body.data.quote;

    expect(Object.keys(header)).toEqual([
      'id',
      'quoteNumber',
      'title',
      'status',
      'currencyCode',
      'issueDate',
      'expiryDate',
      'subtotal',
      'taxRate',
      'taxTotal',
      'total',
      'oneTimeTotal',
      'monthlyRecurringTotal',
      'annualRecurringTotal',
      'depositType',
      'depositAmount',
      'dueOnAcceptanceTotal',
      'depositDueTotal',
      'categoryBreakdown',
      'billToName',
      'introNotes',
      'terms',
      'sellerSnapshot',
      'coverPage',
      'termsAndConditions',
    ]);
    expect(JSON.stringify(header)).not.toContain('internal-');
    expect(JSON.stringify(header)).not.toContain('do-not-serialize');
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

// #2875: the public decline/accept mutations consume the durable response
// capability (2026-08-06-c columns) and honor it as a replay backstop that
// holds even when the Redis jti-revocation marker has been lost.
describe('quotesPublic POST /:token/decline + durable response capability', () => {
  const JTI = 'jti-1';
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
    (verifyQuoteAcceptToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      quoteId: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: JTI,
    });
    (isQuoteAcceptJtiRevoked as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (revokeQuoteAcceptJti as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('decline writes the durable consumption columns in the same UPDATE as the status change', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      expiryDate: null, publicResponseJti: null, publicResponseConsumedAt: null, publicResponseOutcome: null,
    }]); // quote SELECT
    dbResults.push([{ id: QUOTE_ID }]); // UPDATE ... RETURNING

    const res = await app().request(`/quotes/public/${TOKEN}/decline`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Budget cut' }),
    });
    expect(res.status).toBe(200);

    const setCalls = (db as unknown as { set: { mock: { calls: unknown[][] } } }).set.mock.calls;
    expect(setCalls).toHaveLength(1);
    const setArg = setCalls[0]![0] as Record<string, unknown>;
    expect(setArg).toMatchObject({
      status: 'declined',
      declineReason: 'Budget cut',
      publicResponseJti: JTI,
      publicResponseOutcome: 'declined',
    });
    expect(setArg.publicResponseConsumedAt).toBeInstanceOf(Date);
    expect(revokeQuoteAcceptJti).toHaveBeenCalledWith(JTI);

    // Pin the guarded UPDATE's WHERE content: the write-time status re-check +
    // non-consumption re-assert are what close the concurrent-accept race, so
    // their removal must fail this test, not just the queued-rows simulation.
    const whereCalls = (db as unknown as { where: { mock: { calls: unknown[][] } } }).where.mock.calls;
    const updateWhere = whereCalls.at(-1)![0] as SQL;
    const rendered = new PgDialect().sqlToQuery(updateWhere);
    expect(rendered.sql).toContain('"status" in (');
    expect(rendered.sql).toContain('"public_response_consumed_at" is null');
    expect(rendered.params).toEqual(expect.arrayContaining(['sent', 'viewed']));
  });

  it('replayed decline 401s off the durable columns when the Redis marker is gone, without writing', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'declined',
      expiryDate: null, publicResponseJti: JTI,
      publicResponseConsumedAt: new Date('2026-07-27T00:00:00Z'), publicResponseOutcome: 'declined',
    }]); // quote SELECT — Redis says not revoked (marker lost), durable columns say consumed

    const res = await app().request(`/quotes/public/${TOKEN}/decline`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'again' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('RESPONSE_CONSUMED');
    const setCalls = (db as unknown as { set: { mock: { calls: unknown[][] } } }).set.mock.calls;
    expect(setCalls).toHaveLength(0); // no UPDATE issued
    // The lost Redis marker is re-armed so repeat replays die at the resolve() gate.
    expect(revokeQuoteAcceptJti).toHaveBeenCalledWith(JTI);
  });

  it('decline 401s when a version-1 row was issued a different jti (v1 forward-compat guard)', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      expiryDate: null, publicTokenVersion: 1, publicResponseJti: 'jti-issued-at-send',
      publicResponseConsumedAt: null, publicResponseOutcome: null,
    }]); // v1 row: jti persisted at send; presented token carries jti-1

    const res = await app().request(`/quotes/public/${TOKEN}/decline`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'mismatch' }),
    });
    expect(res.status).toBe(401);
    const setCalls = (db as unknown as { set: { mock: { calls: unknown[][] } } }).set.mock.calls;
    expect(setCalls).toHaveLength(0); // the stored jti is never rewritten
  });

  it('decline 409s (not consumed-401) when the row was consumed by a DIFFERENT jti', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'converted',
      expiryDate: null, publicResponseJti: 'jti-other',
      publicResponseConsumedAt: new Date('2026-07-27T00:00:00Z'), publicResponseOutcome: 'accepted',
    }]);

    const res = await app().request(`/quotes/public/${TOKEN}/decline`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });

  it('decline 409s when the write-time status re-check matches 0 rows (concurrent accept won the race)', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      expiryDate: null, publicResponseJti: null, publicResponseConsumedAt: null, publicResponseOutcome: null,
    }]); // quote SELECT reads 'sent'…
    dbResults.push([]); // …but the guarded UPDATE matches 0 rows (status changed underneath)

    const res = await app().request(`/quotes/public/${TOKEN}/decline`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'race' }),
    });
    expect(res.status).toBe(409);
    expect(revokeQuoteAcceptJti).not.toHaveBeenCalled();
  });

  it('replayed accept 401s off the durable columns when the Redis marker is gone (service backstop through the route)', async () => {
    dbResults.push([]); // quoteBlocks pre-fetch (accept route) — no contract blocks
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'converted',
      expiryDate: null, quoteNumber: 'Q-1', currencyCode: 'USD', taxRate: null, siteId: null,
      publicResponseJti: JTI,
      publicResponseConsumedAt: new Date('2026-07-27T00:00:00Z'), publicResponseOutcome: 'accepted',
    }]); // acceptQuote's SELECT ... FOR UPDATE

    const res = await app().request(`/quotes/public/${TOKEN}/accept`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signerName: 'Replay Ray' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe('RESPONSE_CONSUMED');
    // The lost Redis marker is re-armed so repeat replays die at the resolve() gate.
    expect(revokeQuoteAcceptJti).toHaveBeenCalledWith(JTI);
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

describe('quotesPublic GET /:token/line-image/:lineId', () => {
  const LINE_ID = '77777777-7777-7777-7777-777777777777';
  const CATALOG_ID = '88888888-8888-8888-8888-888888888888';
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
    (verifyQuoteAcceptToken as ReturnType<typeof vi.fn>).mockResolvedValue({
      quoteId: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, jti: 'jti-1',
    });
    (isQuoteAcceptJtiRevoked as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  });

  it('serves the per-line uploaded image for a valid token', async () => {
    dbResults.push([{ id: QUOTE_ID }]); // quote (token-resolved) lookup
    dbResults.push([{ imageId: 'img-1', catalogItemId: null, customerVisible: true }]); // line
    dbResults.push([{ data: Buffer.from('PNGDATA'), mime: 'image/png', byteSize: 7 }]); // readQuoteImage
    const res = await app().request(`/quotes/public/${TOKEN}/line-image/${LINE_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('falls back to the catalog item image', async () => {
    dbResults.push([{ id: QUOTE_ID }]);
    dbResults.push([{ imageId: null, catalogItemId: CATALOG_ID, customerVisible: true }]);
    dbResults.push([{ data: Buffer.from('JPEG'), mime: 'image/jpeg', byteSize: 4 }]);
    const res = await app().request(`/quotes/public/${TOKEN}/line-image/${LINE_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('rejects an invalid/expired token with 401 (no db read)', async () => {
    (verifyQuoteAcceptToken as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await app().request(`/quotes/public/${TOKEN}/line-image/${LINE_ID}`);
    expect(res.status).toBe(401);
  });

  it('404s a cross-quote / unknown lineId (line lookup scoped to the token quote)', async () => {
    dbResults.push([{ id: QUOTE_ID }]);
    dbResults.push([]); // no line on this quote
    const res = await app().request(`/quotes/public/${TOKEN}/line-image/${LINE_ID}`);
    expect(res.status).toBe(404);
  });
});
