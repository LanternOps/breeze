import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — routes are thin; we assert wiring, validation, error mapping.
vi.mock('../../services/quoteService', () => ({
  createQuote: vi.fn(),
  getQuote: vi.fn(),
  listQuotes: vi.fn(),
  updateQuote: vi.fn(),
  deleteDraftQuote: vi.fn(),
  addBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn()
}));

// QuoteServiceError lives in quoteTypes; routes import the class from there.
vi.mock('../../services/quoteTypes', () => ({
  QuoteServiceError: class QuoteServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  }
}));

// Mock the PDF renderer — the route is what we exercise here, not pdfkit. The
// renderer has its own unit tests (quotePdf.test.ts); the route only needs to
// wire getQuote + branding/image loads through to it and stream the bytes.
const pdf = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock('../../services/quotePdf', () => ({
  renderQuotePdf: (...args: any[]) => pdf.render(...args)
}));

// Mock the `db` proxy the route uses for branding (partners / portal_branding)
// and the image loader. Each select(...).from(...).where(...).limit(1) chain
// resolves to a mutable rows array a test can preset. Default: empty rows.
const dbRows = vi.hoisted(() => ({ next: [] as any[][], i: 0 }));
vi.mock('../../db', () => {
  const builder = () => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(dbRows.next[dbRows.i++] ?? [])
    };
    return chain;
  };
  return { db: { select: () => builder() } };
});

// Mock auth middleware to inject a partner-scoped actor with quote perms.
// The route binds requireScope/requirePermission once at module load, so the
// per-route middleware closures are frozen. To still flip RBAC per-test, those
// closures dispatch to a mutable `permGate` that each test can override.
// vi.hoisted lets the mock factory (hoisted above all imports) reference it.
const gate = vi.hoisted(() => ({ permGate: async (_c: any, next: any) => next() }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', orgId: null, scope: 'partner', accessibleOrgIds: null });
    await next();
  },
  requireScope: () => async (c: any, next: any) => gate.permGate(c, next),
  requirePermission: () => async (c: any, next: any) => gate.permGate(c, next)
}));

import { quoteRoutes } from './index';
import * as svc from '../../services/quoteService';
import { QuoteServiceError } from '../../services/quoteTypes';

function app() {
  // quoteRoutes already applies authMiddleware internally
  return quoteRoutes;
}

const QUOTE_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const BLOCK_ID = '33333333-3333-3333-3333-333333333333';

describe('quote crud + lines routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-arm the default allow-through gate (a prior test may have flipped it).
    gate.permGate = async (_c: any, next: any) => next();
    // Reset the db row queue (branding selects) consumed per request.
    dbRows.next = [];
    dbRows.i = 0;
  });

  it('GET / lists quotes', async () => {
    (svc.listQuotes as any).mockResolvedValue([{ id: QUOTE_ID }]);
    const res = await app().request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ id: QUOTE_ID }]);
    expect(svc.listQuotes).toHaveBeenCalledOnce();
  });

  it('POST / creates a quote', async () => {
    (svc.createQuote as any).mockResolvedValue({ id: QUOTE_ID, status: 'draft' });
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(QUOTE_ID);
    expect(svc.createQuote).toHaveBeenCalledOnce();
  });

  it('POST / rejects an invalid body (non-UUID orgId → 400, no service call)', async () => {
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: 'not-a-uuid' })
    });
    expect(res.status).toBe(400);
    expect(svc.createQuote).not.toHaveBeenCalled();
  });

  it('GET /:id fetches one quote', async () => {
    (svc.getQuote as any).mockResolvedValue({ quote: { id: QUOTE_ID }, blocks: [], lines: [] });
    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.quote.id).toBe(QUOTE_ID);
    expect(svc.getQuote).toHaveBeenCalledWith(QUOTE_ID, expect.anything());
  });

  it('POST /:id/lines adds a manual line', async () => {
    (svc.addManualLine as any).mockResolvedValue({ id: 'line1' });
    const res = await app().request(`/${QUOTE_ID}/lines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'manual', description: 'Onsite hour', quantity: 2, unitPrice: 150, taxable: true })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('line1');
    expect(svc.addManualLine).toHaveBeenCalledOnce();
  });

  it('POST /:id/lines rejects an invalid body (negative quantity → 400, no service call)', async () => {
    const res = await app().request(`/${QUOTE_ID}/lines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceType: 'manual', description: 'X', quantity: -1, unitPrice: 150, taxable: false })
    });
    expect(res.status).toBe(400);
    expect(svc.addManualLine).not.toHaveBeenCalled();
  });

  it('POST /:id/lines/catalog forwards catalogItemId, quantity, blockId', async () => {
    (svc.addCatalogLine as any).mockResolvedValue({ id: 'line2' });
    const res = await app().request(`/${QUOTE_ID}/lines/catalog`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catalogItemId: ORG_ID, quantity: 3 })
    });
    expect(res.status).toBe(200);
    expect(svc.addCatalogLine).toHaveBeenCalledWith(QUOTE_ID, ORG_ID, 3, undefined, expect.anything());
  });

  it('DELETE /:id deletes a draft quote', async () => {
    (svc.deleteDraftQuote as any).mockResolvedValue(undefined);
    const res = await app().request(`/${QUOTE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ok).toBe(true);
    expect(svc.deleteDraftQuote).toHaveBeenCalledWith(QUOTE_ID, expect.anything());
  });

  it('DELETE /:id/blocks/:blockId deletes a block (200, forwards ids)', async () => {
    (svc.deleteBlock as any).mockResolvedValue(undefined);
    const res = await app().request(`/${QUOTE_ID}/blocks/${BLOCK_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ok).toBe(true);
    expect(svc.deleteBlock).toHaveBeenCalledWith(QUOTE_ID, BLOCK_ID, expect.anything());
  });

  it('maps a QuoteServiceError to its status (NOT_A_DRAFT → 409)', async () => {
    (svc.createQuote as any).mockRejectedValue(
      new QuoteServiceError('Quote is not a draft', 409, 'NOT_A_DRAFT')
    );
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID })
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('NOT_A_DRAFT');
  });

  it('denies when the permission gate rejects (403, no service call)', async () => {
    // Flip the gate to deny; mirrors an RBAC failure before the handler runs.
    const { HTTPException } = await import('hono/http-exception');
    gate.permGate = async () => { throw new HTTPException(403, { message: 'Permission denied' }); };
    const res = await app().request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID })
    });
    expect(res.status).toBe(403);
    expect(svc.createQuote).not.toHaveBeenCalled();
  });

  describe('GET /:id/pdf', () => {
    // A heading block + a line_items block with one line — the minimal fixture
    // the route hands to renderQuotePdf (which we've mocked).
    const quoteFixture = {
      quote: {
        id: QUOTE_ID, quoteNumber: 'Q-2026-0001', partnerId: 'p1', orgId: ORG_ID,
        currencyCode: 'USD', terms: null
      },
      blocks: [
        { id: 'b1', blockType: 'heading', content: { text: 'Proposal' }, sortOrder: 0 },
        { id: 'b2', blockType: 'line_items', content: {}, sortOrder: 1 }
      ],
      lines: [
        { id: 'l1', blockId: 'b2', description: 'Onsite hour', quantity: '2', unitPrice: '150', lineTotal: '300', recurrence: 'one_time' }
      ]
    };

    it('streams the rendered PDF inline (200, application/pdf, inline filename)', async () => {
      (svc.getQuote as any).mockResolvedValue(quoteFixture);
      // Branding selects: partner row, then portal_branding row.
      dbRows.next = [
        [{ name: 'Acme MSP', footer: null, currency: 'USD' }],
        [{ logoUrl: null, primaryColor: null, footerText: null }]
      ];
      pdf.render.mockResolvedValue(Buffer.from('%PDF-1.4 test'));

      const res = await app().request(`/${QUOTE_ID}/pdf`, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      const disposition = res.headers.get('content-disposition') ?? '';
      expect(disposition).toContain('inline');
      // Filename carries the quote number.
      expect(disposition).toContain('Q-2026-0001');

      const body = Buffer.from(await res.arrayBuffer());
      expect(body.toString('latin1').startsWith('%PDF')).toBe(true);

      // Route loaded the quote and handed quote+blocks+lines to the renderer.
      expect(svc.getQuote).toHaveBeenCalledWith(QUOTE_ID, expect.anything());
      expect(pdf.render).toHaveBeenCalledOnce();
      const [q, blocks, lines] = pdf.render.mock.calls[0] as any[];
      expect(q.id).toBe(QUOTE_ID);
      expect(blocks).toHaveLength(2);
      expect(lines).toHaveLength(1);
    });

    it('returns 404 when the quote is not found / cross-tenant (QUOTE_NOT_FOUND)', async () => {
      (svc.getQuote as any).mockRejectedValue(
        new QuoteServiceError('Quote not found', 404, 'QUOTE_NOT_FOUND')
      );

      const res = await app().request(`/${QUOTE_ID}/pdf`, { method: 'GET' });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe('QUOTE_NOT_FOUND');
      expect(pdf.render).not.toHaveBeenCalled();
    });
  });
});
