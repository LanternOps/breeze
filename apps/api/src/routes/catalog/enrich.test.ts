import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { enrichCatalogItem, EnrichmentError } = vi.hoisted(() => {
  const enrichCatalogItem = vi.fn();
  class EnrichmentError extends Error {
    code: string; status: number;
    constructor(m: string, c: string, s: number) { super(m); this.code = c; this.status = s; }
  }
  return { enrichCatalogItem, EnrichmentError };
});
vi.mock('../../services/catalogEnrichmentService', () => ({ enrichCatalogItem, EnrichmentError }));

// Auth middleware stubs: inject an auth context and pass through.
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { CATALOG_WRITE: { resource: 'catalog', action: 'write' } },
}));
vi.mock('./catalog', () => ({
  catalogActorFrom: () => ({ userId: 'u1', orgId: 'o1' }),
}));

import { catalogEnrichRoutes } from './enrich';

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('auth', { user: { id: 'u1' }, orgId: 'o1', accessibleOrgIds: ['o1'] }); await next(); });
  a.route('/', catalogEnrichRoutes);
  return a;
}

beforeEach(() => enrichCatalogItem.mockReset());

describe('POST /catalog/enrich', () => {
  it('returns the enrichment result', async () => {
    enrichCatalogItem.mockResolvedValueOnce({ draft: { name: 'X' }, priceGuidance: null, provenance: { source: 'ai_enrich' } });
    const res = await app().request('/enrich', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'APC UPS' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.draft.name).toBe('X');
    expect(enrichCatalogItem).toHaveBeenCalledWith('APC UPS', undefined, { userId: 'u1', orgId: 'o1' });
  });

  it('400s an empty query', async () => {
    const res = await app().request('/enrich', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '' }),
    });
    expect(res.status).toBe(400);
    expect(enrichCatalogItem).not.toHaveBeenCalled();
  });

  it('maps EnrichmentError to its status + code', async () => {
    enrichCatalogItem.mockRejectedValueOnce(new EnrichmentError('budget gone', 'AI_LIMIT', 429));
    const res = await app().request('/enrich', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    });
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('AI_LIMIT');
  });
});
