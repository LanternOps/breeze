import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the service layer — routes are thin; we assert wiring, validation, error mapping.
vi.mock('../../services/quoteService', () => ({
  createQuote: vi.fn(),
  getQuote: vi.fn(),
  listQuotes: vi.fn(),
  updateQuote: vi.fn(),
  deleteDraftQuote: vi.fn(),
  addBlock: vi.fn(),
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

describe('quote crud + lines routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-arm the default allow-through gate (a prior test may have flipped it).
    gate.permGate = async (_c: any, next: any) => next();
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
});
