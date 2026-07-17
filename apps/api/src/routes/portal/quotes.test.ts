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
// contractTemplateRender.ts also imports formatMoney/formatDate from this same
// module for auto-variable resolution — keep the REAL implementations for those
// (importOriginal) so a contract block's rendered totals/dates aren't silently
// undefined; only renderQuotePdf itself is a spy.
const { renderQuotePdfMock } = vi.hoisted(() => ({ renderQuotePdfMock: vi.fn() }));
vi.mock('../../services/quotePdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/quotePdf')>();
  return { ...actual, renderQuotePdf: renderQuotePdfMock };
});

// Spy on the dynamically-imported merge helper; keep the REAL PdfMergeError so the
// route's `instanceof PdfMergeError` mapping resolves against the same class.
const { mergeMock } = vi.hoisted(() => ({ mergeMock: vi.fn() }));
vi.mock('../../services/pdfMerge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/pdfMerge')>();
  return { ...actual, mergeUploadedContractPdfs: mergeMock };
});

import { quoteRoutes as portalQuoteRoutes } from './quotes';
import { PdfMergeError } from '../../services/pdfMerge';

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const QUOTE_ID = '11111111-1111-1111-1111-111111111111';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const TEMPLATE_ID = '44444444-4444-4444-4444-444444444444';
const VERSION_ID = '55555555-5555-5555-5555-555555555555';
const BLOCK_ID = '66666666-6666-6666-6666-666666666666';

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
    dbResults.push([{ name: 'Lantern IT' }]); // partners SELECT (system ctx)
    dbResults.push([]); // portalBranding SELECT

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

  it('carries branding (partner name + portal logo/color) mirroring the public token view', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      quoteNumber: 'Q-1', currencyCode: 'USD', taxRate: null,
      depositType: 'none', depositPercent: null,
    }]); // quote SELECT
    dbResults.push([]); // quoteBlocks SELECT
    dbResults.push([]); // quoteLines SELECT
    dbResults.push([]); // markQuoteViewed's own quotes SELECT
    dbResults.push([{ name: 'Lantern IT' }]); // partners SELECT (system ctx)
    dbResults.push([{ logoUrl: 'https://cdn.example.test/logo.png', primaryColor: '#123456' }]); // portalBranding SELECT

    const res = await app().request(`/quotes/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.branding).toEqual({
      partnerName: 'Lantern IT',
      logoUrl: 'https://cdn.example.test/logo.png',
      primaryColor: '#123456',
    });
  });

  it('falls back to null logo/color and a generic partner name when neither row exists', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      quoteNumber: 'Q-1', currencyCode: 'USD', taxRate: null,
      depositType: 'none', depositPercent: null,
    }]); // quote SELECT
    dbResults.push([]); // quoteBlocks SELECT
    dbResults.push([]); // quoteLines SELECT
    dbResults.push([]); // markQuoteViewed's own quotes SELECT
    dbResults.push([]); // partners SELECT (system ctx) → none
    dbResults.push([]); // portalBranding SELECT → none

    const res = await app().request(`/quotes/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.branding).toEqual({ partnerName: 'Proposal', logoUrl: null, primaryColor: null });
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
    dbResults.push([]); // markQuoteViewed's own quotes SELECT
    dbResults.push([{ name: 'Lantern IT' }]); // partners SELECT (system ctx)
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

    const res = await app().request(`/quotes/${QUOTE_ID}`, { method: 'GET' });
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
    expect(contractBlock.content).not.toHaveProperty('variableValues');
    // Parity: the ADMIN editor gets an `authoring` block (templateId/versionId/
    // variableValues/declaredVariables); the tenant-facing portal payload must
    // NEVER carry it.
    expect(contractBlock.content).not.toHaveProperty('authoring');
  });

  it('serializes an uploaded contract block with a null renderedHtml and a portal contract-file fileUrl', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      quoteNumber: 'Q-1', currencyCode: 'USD', taxRate: null, depositType: 'none', depositPercent: null,
    }]); // quote SELECT
    dbResults.push([
      { id: BLOCK_ID, quoteId: QUOTE_ID, orgId: ORG_ID, blockType: 'contract', content: { templateId: TEMPLATE_ID, templateVersionId: VERSION_ID, variableValues: {} }, sortOrder: 0 },
    ]); // quoteBlocks SELECT
    dbResults.push([]); // quoteLines SELECT
    dbResults.push([]); // markQuoteViewed's own quotes SELECT
    dbResults.push([{ name: 'Lantern IT' }]); // partners SELECT (system ctx)
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

    const res = await app().request(`/quotes/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    const contractBlock = body.data.blocks.find((b: { id: string }) => b.id === BLOCK_ID);
    expect(contractBlock.content.sourceType).toBe('uploaded');
    expect(contractBlock.content.renderedHtml).toBeNull();
    expect(contractBlock.content.fileUrl).toBe(`/portal/quotes/${QUOTE_ID}/contract-file/${BLOCK_ID}`);
  });
});

describe('portal quotes GET /quotes/:id/contract-file/:blockId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
  });

  it('streams application/pdf for an uploaded contract block on the caller\'s own quote', async () => {
    dbResults.push([{ id: QUOTE_ID }]); // quotes SELECT (org-scoped, non-draft)
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

    const res = await app().request(`/quotes/${QUOTE_ID}/contract-file/${BLOCK_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.toString()).toBe('%PDF-1.4');
  });

  it('404s a blockId that does not belong to this quote (cross-quote blockId)', async () => {
    dbResults.push([{ id: QUOTE_ID }]); // quotes SELECT succeeds — the caller owns QUOTE_ID
    dbResults.push([]); // quoteBlocks SELECT — the quoteId filter excludes a block from a different quote
    const res = await app().request(`/quotes/${QUOTE_ID}/contract-file/${BLOCK_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('404s when the quote is not the caller\'s own', async () => {
    dbResults.push([]); // quotes SELECT → none (org mismatch or draft)
    const res = await app().request(`/quotes/${QUOTE_ID}/contract-file/${BLOCK_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
  });
});

describe('portal quotes /:id/pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
    renderQuotePdfMock.mockResolvedValue(Buffer.from('%PDF-test'));
    // Default: pass the main PDF through unchanged (no uploaded contract merge).
    mergeMock.mockImplementation(async (pdf: Buffer) => pdf);
  });

  it('maps a PdfMergeError from the merge helper to a typed 4xx, not a 500', async () => {
    dbResults.push([{
      id: QUOTE_ID, orgId: ORG_ID, partnerId: PARTNER_ID, status: 'sent',
      quoteNumber: 'Q-1', currencyCode: 'USD', taxRate: null,
      depositType: 'none', depositPercent: null, sellerSnapshot: null, terms: null,
    }]); // quote SELECT
    dbResults.push([]); // quoteBlocks SELECT
    dbResults.push([]); // quoteLines SELECT
    dbResults.push([{ name: 'Lantern IT', billingCompanyName: null, billingEmail: null, billingPhone: null, billingWebsite: null, billingAddressLine1: null, billingAddressLine2: null, billingAddressCity: null, billingAddressRegion: null, billingAddressPostalCode: null, billingAddressCountry: null, invoiceFooter: null, currencyCode: 'USD' }]); // partners SELECT (system ctx)
    dbResults.push([]); // portalBranding SELECT
    // A legacy encrypted/corrupt uploaded contract PDF surfaces here.
    mergeMock.mockRejectedValueOnce(new PdfMergeError('An attached contract PDF could not be read'));

    const res = await app().request(`/quotes/${QUOTE_ID}/pdf`, { method: 'GET' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('CONTRACT_PDF_UNREADABLE');
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
