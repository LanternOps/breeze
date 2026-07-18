import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — routes are thin; we assert wiring, validation, error mapping.
vi.mock('../../services/quoteService', () => ({
  createQuote: vi.fn(),
  cloneQuote: vi.fn(),
  getQuote: vi.fn(),
  listQuotes: vi.fn(),
  updateQuote: vi.fn(),
  deleteDraftQuote: vi.fn(),
  addBlock: vi.fn(),
  updateBlock: vi.fn(),
  deleteBlock: vi.fn(),
  addManualLine: vi.fn(),
  addCatalogLine: vi.fn(),
  updateLine: vi.fn(),
  removeLine: vi.fn(),
  reorderBlocks: vi.fn(),
  reorderLines: vi.fn(),
  moveLineToBlock: vi.fn(),
}));

// QuoteServiceError lives in quoteTypes; routes import the class from there.
vi.mock('../../services/quoteTypes', () => ({
  QuoteServiceError: class QuoteServiceError extends Error {
    constructor(msg: string, public status = 400, public code?: string) { super(msg); }
  }
}));

// Contract-block serialization has its own unit tests (contractTemplateRender.test.ts);
// here we only assert the route's WIRING — it calls renderContractBlocksForClient
// with the right args and threads the result into the response. Default identity
// pass-through so every other GET /:id test (no contract blocks) is unaffected.
vi.mock('../../services/contractTemplateRender', () => ({
  renderContractBlocksForClient: vi.fn(async (blocks: unknown[]) => blocks),
  // Task 14: the PDF route's pre-fetch for contract-block render data + uploaded
  // PDFs. Default empty (no contract blocks) so every other GET /:id/pdf test is
  // unaffected; mergeUploadedContractPdfs is real (pdf-lib) but a no-op on an
  // empty uploads array, so the mocked '%PDF-1.4 test' buffer passes through.
  loadContractPdfInputs: vi.fn(async () => ({ contractRenderData: new Map(), uploads: [] })),
  // ADMIN-only authoring fields for the editor. Default empty map so every other
  // GET /:id test is unaffected (no `authoring` merged onto contract blocks).
  loadContractBlockAuthoring: vi.fn(async () => new Map()),
  // Real implementation (not a bare vi.fn()) — mirrors contractTemplateRender.ts's
  // attachContractAuthoring exactly, so the "merges authoring onto contract
  // blocks" test below exercises the actual merge semantics the route relies on.
  attachContractAuthoring: vi.fn((blocks: Array<{ id: string; blockType: string; content: unknown }>, authoring: Map<string, unknown>) => {
    if (authoring.size === 0) return blocks;
    return blocks.map((block) => {
      const a = authoring.get(block.id);
      if (!a || block.blockType !== 'contract') return block;
      return { ...block, content: { ...(block.content as Record<string, unknown>), authoring: a } };
    });
  }),
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
import { renderContractBlocksForClient, loadContractBlockAuthoring } from '../../services/contractTemplateRender';
import { ContractTemplateServiceError } from '../../services/contractTemplateService';

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

  it('POST /:id/clone clones a quote into a new draft (bodyless legacy call → no retarget)', async () => {
    (svc.cloneQuote as any).mockResolvedValue({ id: BLOCK_ID, status: 'draft' });
    const res = await app().request(`/${QUOTE_ID}/clone`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ id: BLOCK_ID, status: 'draft' });
    expect(svc.cloneQuote).toHaveBeenCalledWith(QUOTE_ID, expect.anything(), {});
  });

  it('POST /:id/clone passes retarget/rename options through to the service', async () => {
    (svc.cloneQuote as any).mockResolvedValue({ id: BLOCK_ID, status: 'draft' });
    const res = await app().request(`/${QUOTE_ID}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID, title: 'Clone of Q-1' }),
    });

    expect(res.status).toBe(200);
    expect(svc.cloneQuote).toHaveBeenCalledWith(QUOTE_ID, expect.anything(), { orgId: ORG_ID, title: 'Clone of Q-1' });
  });

  it('POST /:id/clone honors a JSON retarget body even without a content-type header', async () => {
    // No content-type gate: a caller that forgets the header must still get the
    // retarget it asked for, never a silent same-org clone.
    (svc.cloneQuote as any).mockResolvedValue({ id: BLOCK_ID, status: 'draft' });
    const res = await app().request(`/${QUOTE_ID}/clone`, {
      method: 'POST',
      body: JSON.stringify({ orgId: ORG_ID }),
    });

    expect(res.status).toBe(200);
    expect(svc.cloneQuote).toHaveBeenCalledWith(QUOTE_ID, expect.anything(), { orgId: ORG_ID });
  });

  it('POST /:id/clone rejects a non-JSON body instead of silently cloning', async () => {
    const res = await app().request(`/${QUOTE_ID}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `orgId=${ORG_ID}`,
    });

    expect(res.status).toBe(400);
    expect(svc.cloneQuote).not.toHaveBeenCalled();
  });

  it('POST /:id/clone rejects a malformed retarget body instead of silently cloning', async () => {
    // A mis-keyed field must 400 (strict schema), not fall back to a same-org clone.
    const res = await app().request(`/${QUOTE_ID}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgID: ORG_ID }),
    });

    expect(res.status).toBe(400);
    expect(svc.cloneQuote).not.toHaveBeenCalled();
  });

  it('POST /:id/clone rejects an invalid quote id before calling the service', async () => {
    const res = await app().request('/not-a-uuid/clone', { method: 'POST' });

    expect(res.status).toBe(400);
    expect(svc.cloneQuote).not.toHaveBeenCalled();
  });

  it('POST /:id/clone is blocked by the write-permission gate', async () => {
    const { HTTPException } = await import('hono/http-exception');
    gate.permGate = async () => { throw new HTTPException(403, { message: 'Permission denied' }); };

    const res = await app().request(`/${QUOTE_ID}/clone`, { method: 'POST' });

    expect(res.status).toBe(403);
    expect(svc.cloneQuote).not.toHaveBeenCalled();
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
    (svc.getQuote as any).mockResolvedValue({
      quote: { id: QUOTE_ID },
      blocks: [],
      lines: [],
      pax8OrderId: '55555555-5555-5555-5555-555555555555',
      pax8OrderLineCount: 2,
    });
    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.quote.id).toBe(QUOTE_ID);
    expect(body.data).toMatchObject({
      pax8OrderId: '55555555-5555-5555-5555-555555555555',
      pax8OrderLineCount: 2,
    });
    expect(svc.getQuote).toHaveBeenCalledWith(QUOTE_ID, expect.anything());
  });

  it('GET /:id denies callers without quotes:read before loading the staged-order summary', async () => {
    const { HTTPException } = await import('hono/http-exception');
    gate.permGate = async () => { throw new HTTPException(403, { message: 'Permission denied' }); };

    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });

    expect(res.status).toBe(403);
    expect(svc.getQuote).not.toHaveBeenCalled();
  });

  it('GET /:id threads blocks through renderContractBlocksForClient with a /quotes/:id/contract-file/:blockId fileUrl builder', async () => {
    const rawContractBlock = { id: BLOCK_ID, blockType: 'contract', content: { templateId: 'tmpl-1', templateVersionId: 'ver-1', variableValues: {} } };
    (svc.getQuote as any).mockResolvedValue({
      quote: { id: QUOTE_ID, orgId: ORG_ID },
      blocks: [rawContractBlock],
      lines: [],
    });
    const renderedContent = { templateName: 'MSA', versionNumber: 2, sourceType: 'authored', renderedHtml: '<p>Acme Co</p>', fileUrl: null };
    (renderContractBlocksForClient as any).mockResolvedValueOnce([{ ...rawContractBlock, content: renderedContent }]);

    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.blocks[0].content).toEqual(renderedContent);

    expect(renderContractBlocksForClient).toHaveBeenCalledWith(
      [rawContractBlock],
      expect.objectContaining({ id: QUOTE_ID }),
      expect.any(Function),
    );
    const fileUrlFor = (renderContractBlocksForClient as any).mock.calls[0][2] as (blockId: string) => string;
    expect(fileUrlFor(BLOCK_ID)).toBe(`/quotes/${QUOTE_ID}/contract-file/${BLOCK_ID}`);
  });

  it('GET /:id (ADMIN) merges the raw authoring fields onto each contract block for the editor', async () => {
    const rawContractBlock = { id: BLOCK_ID, blockType: 'contract', content: { templateId: 'tmpl-1', templateVersionId: 'ver-1', variableValues: { initial_term: '12 months' } } };
    (svc.getQuote as any).mockResolvedValue({
      quote: { id: QUOTE_ID, orgId: ORG_ID },
      blocks: [rawContractBlock],
      lines: [],
    });
    const renderedContent = { templateName: 'MSA', versionNumber: 1, sourceType: 'authored', renderedHtml: '<p>Acme Co</p>', fileUrl: null };
    (renderContractBlocksForClient as any).mockResolvedValueOnce([{ ...rawContractBlock, content: renderedContent }]);
    const authoring = {
      templateId: 'tmpl-1', templateVersionId: 'ver-1', variableValues: { initial_term: '12 months' },
      declaredVariables: [{ name: 'client.name', kind: 'auto' }, { name: 'initial_term', kind: 'manual' }],
      latestPublishedVersionId: 'ver-2', latestPublishedVersionNumber: 2,
    };
    (loadContractBlockAuthoring as any).mockResolvedValueOnce(new Map([[BLOCK_ID, authoring]]));

    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The display render shape is preserved AND the authoring block is attached.
    expect(body.data.blocks[0].content).toEqual({ ...renderedContent, authoring });
    expect(loadContractBlockAuthoring).toHaveBeenCalledWith([rawContractBlock]);
  });

  it('GET /:id maps a ContractTemplateServiceError (e.g. an orphaned contract block) to its status/code', async () => {
    (svc.getQuote as any).mockResolvedValue({ quote: { id: QUOTE_ID, orgId: ORG_ID }, blocks: [], lines: [] });
    (renderContractBlocksForClient as any).mockRejectedValueOnce(
      new ContractTemplateServiceError('Contract block references a missing or mismatched template version', 404, 'VERSION_NOT_FOUND'),
    );
    const res = await app().request(`/${QUOTE_ID}`, { method: 'GET' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('VERSION_NOT_FOUND');
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
    expect(svc.addCatalogLine).toHaveBeenCalledWith(QUOTE_ID, ORG_ID, 3, undefined, expect.anything(), { partNumber: null });
  });

  it('DELETE /:id deletes a draft quote', async () => {
    (svc.deleteDraftQuote as any).mockResolvedValue(undefined);
    const res = await app().request(`/${QUOTE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ok).toBe(true);
    expect(svc.deleteDraftQuote).toHaveBeenCalledWith(QUOTE_ID, expect.anything());
  });

  it('PATCH /:id/blocks/:blockId updates a heading block (200, forwards body)', async () => {
    (svc.updateBlock as any).mockResolvedValue({ id: BLOCK_ID, blockType: 'heading', content: { text: 'New title', level: 2 } });
    const res = await app().request(`/${QUOTE_ID}/blocks/${BLOCK_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockType: 'heading', content: { text: 'New title', level: 2 } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.content.text).toBe('New title');
    expect(svc.updateBlock).toHaveBeenCalledWith(
      QUOTE_ID, BLOCK_ID,
      { blockType: 'heading', content: { text: 'New title', level: 2 } },
      expect.anything(),
    );
  });

  it('PATCH /:id/blocks/:blockId rejects an invalid content shape (400)', async () => {
    const res = await app().request(`/${QUOTE_ID}/blocks/${BLOCK_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blockType: 'heading', content: { text: '' } }), // empty heading text
    });
    expect(res.status).toBe(400);
    expect(svc.updateBlock).not.toHaveBeenCalled();
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

  const LINE_ID = '44444444-4444-4444-4444-444444444444';

  describe('PATCH /:id/blocks/reorder', () => {
    it('returns 200 { ok: true } and calls reorderBlocks with blockIds + actor', async () => {
      (svc.reorderBlocks as any).mockResolvedValue(undefined);
      const res = await app().request(`/${QUOTE_ID}/blocks/reorder`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockIds: [BLOCK_ID] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.ok).toBe(true);
      expect(svc.reorderBlocks).toHaveBeenCalledWith(QUOTE_ID, [BLOCK_ID], expect.anything());
    });

    it('rejects empty blockIds array (400, service not called)', async () => {
      const res = await app().request(`/${QUOTE_ID}/blocks/reorder`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockIds: [] }),
      });
      expect(res.status).toBe(400);
      expect(svc.reorderBlocks).not.toHaveBeenCalled();
    });

    it('rejects non-UUID in blockIds (400, service not called)', async () => {
      const res = await app().request(`/${QUOTE_ID}/blocks/reorder`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockIds: ['not-a-uuid'] }),
      });
      expect(res.status).toBe(400);
      expect(svc.reorderBlocks).not.toHaveBeenCalled();
    });

    it('maps REORDER_IDS_MISMATCH to 400', async () => {
      (svc.reorderBlocks as any).mockRejectedValue(
        new QuoteServiceError('Block IDs do not match quote blocks', 400, 'REORDER_IDS_MISMATCH')
      );
      const res = await app().request(`/${QUOTE_ID}/blocks/reorder`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockIds: [BLOCK_ID] }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.code).toBe('REORDER_IDS_MISMATCH');
    });
  });

  describe('PATCH /:id/blocks/:blockId/lines/reorder', () => {
    it('returns 200 { ok: true } and calls reorderLines with blockId + lineIds + actor', async () => {
      (svc.reorderLines as any).mockResolvedValue(undefined);
      const res = await app().request(`/${QUOTE_ID}/blocks/${BLOCK_ID}/lines/reorder`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lineIds: [LINE_ID] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.ok).toBe(true);
      expect(svc.reorderLines).toHaveBeenCalledWith(QUOTE_ID, BLOCK_ID, [LINE_ID], expect.anything());
    });

    it('rejects non-UUID lineId (400, service not called)', async () => {
      const res = await app().request(`/${QUOTE_ID}/blocks/${BLOCK_ID}/lines/reorder`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lineIds: ['not-a-uuid'] }),
      });
      expect(res.status).toBe(400);
      expect(svc.reorderLines).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:id/lines/:lineId/move', () => {
    const LINE_ID = '44444444-4444-4444-4444-444444444444';
    it('returns 200 { data: line } and calls moveLineToBlock with ids + actor', async () => {
      (svc.moveLineToBlock as any).mockResolvedValue({ id: LINE_ID, blockId: BLOCK_ID, sortOrder: 3 });
      const res = await app().request(`/${QUOTE_ID}/lines/${LINE_ID}/move`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockId: BLOCK_ID }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.blockId).toBe(BLOCK_ID);
      expect(svc.moveLineToBlock).toHaveBeenCalledWith(QUOTE_ID, LINE_ID, BLOCK_ID, expect.anything());
    });

    it('400s on a non-guid blockId without calling the service', async () => {
      const res = await app().request(`/${QUOTE_ID}/lines/${LINE_ID}/move`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockId: 'nope' }),
      });
      expect(res.status).toBe(400);
      expect(svc.moveLineToBlock).not.toHaveBeenCalled();
    });

    it('maps QuoteServiceError to its status + code', async () => {
      (svc.moveLineToBlock as any).mockRejectedValue(
        new QuoteServiceError('Target block is not a pricing table', 400, 'BLOCK_NOT_LINE_ITEMS')
      );
      const res = await app().request(`/${QUOTE_ID}/lines/${LINE_ID}/move`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockId: BLOCK_ID }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('BLOCK_NOT_LINE_ITEMS');
    });

    it('is blocked by the write-permission gate', async () => {
      gate.permGate = async (c: any) => c.json({ error: 'forbidden' }, 403);
      const res = await app().request(`/${QUOTE_ID}/lines/${LINE_ID}/move`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockId: BLOCK_ID }),
      });
      expect(res.status).toBe(403);
      expect(svc.moveLineToBlock).not.toHaveBeenCalled();
    });
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
      ],
      // getQuote resolves the customer bill-to (from the org for drafts); the route
      // overlays it onto the render payload.
      billTo: { name: 'Acme Customer', address: null, taxId: null }
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
