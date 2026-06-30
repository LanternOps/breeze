import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../../middleware/auth';

const { enrichCatalogItem, polishCatalogText, EnrichmentError } = vi.hoisted(() => {
  const enrichCatalogItem = vi.fn();
  const polishCatalogText = vi.fn();
  class EnrichmentError extends Error {
    code: string; status: number;
    constructor(m: string, c: string, s: number) { super(m); this.code = c; this.status = s; }
  }
  return { enrichCatalogItem, polishCatalogText, EnrichmentError };
});
vi.mock('../../services/catalogEnrichmentService', () => ({ enrichCatalogItem, polishCatalogText, EnrichmentError }));

// Auth middleware stubs: inject an auth context and pass through.
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { CATALOG_WRITE: { resource: 'catalog', action: 'write' } },
}));

import { catalogEnrichRoutes } from './enrich';

const fakeAuth = { user: { id: 'u1' }, orgId: 'o1', accessibleOrgIds: ['o1'] } as unknown as AuthContext;

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('auth', fakeAuth); await next(); });
  a.route('/', catalogEnrichRoutes);
  return a;
}

beforeEach(() => { enrichCatalogItem.mockReset(); polishCatalogText.mockReset(); });

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

describe('POST /catalog/polish', () => {
  it('returns the polished name + description', async () => {
    polishCatalogText.mockResolvedValueOnce({ name: 'Clean Name', description: 'Clean desc.', changed: true });
    const res = await app().request('/polish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'spl clean name disti', description: 'clean desc' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ name: 'Clean Name', description: 'Clean desc.', changed: true });
    expect(polishCatalogText).toHaveBeenCalledWith(
      { name: 'spl clean name disti', description: 'clean desc' },
      { userId: 'u1', orgId: 'o1' },
    );
  });

  it('400s when neither name nor description is provided', async () => {
    const res = await app().request('/polish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ', description: '' }),
    });
    expect(res.status).toBe(400);
    expect(polishCatalogText).not.toHaveBeenCalled();
  });

  it('maps a fact-drift EnrichmentError to 502 / AI_FACT_DRIFT', async () => {
    polishCatalogText.mockRejectedValueOnce(new EnrichmentError('changed details', 'AI_FACT_DRIFT', 502));
    const res = await app().request('/polish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'apc 600va' }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('AI_FACT_DRIFT');
  });
});
