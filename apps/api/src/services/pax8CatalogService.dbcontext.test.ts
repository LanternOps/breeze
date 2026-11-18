import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ inside: false, getPricing: vi.fn(), select: vi.fn(), outside: vi.fn() }));
vi.mock('../db', () => ({ db: { select: h.select }, withDbAccessContext: async (_ctx: unknown, fn: () => unknown) => { h.inside = true; try { return await fn(); } finally { h.inside = false; } }, runOutsideDbContext: async (fn: () => unknown) => { const prior = h.inside; h.inside = false; h.outside(); try { return await fn(); } finally { h.inside = prior; } } }));
vi.mock('./pax8SyncService', () => ({ createPax8ClientForIntegration: async () => { expect(h.inside).toBe(true); return { client: { getProductPricing: h.getPricing } }; } }));
import { getPax8ProductPricing } from './pax8CatalogService';
it('tool pricing resolves integration in a short tenant context and calls Pax8 outside it', async () => {
  const q: any = new Proxy({}, { get: (_t,k) => k === 'then' ? (resolve: any) => { expect(h.inside).toBe(true); resolve([{ id: 'example-integration' }]); } : () => q });
  h.select.mockReturnValue(q); h.getPricing.mockImplementation(async () => { expect(h.inside).toBe(false); return []; });
  await getPax8ProductPricing('example-product', { partnerId: 'example-partner', userId: null, accessibleOrgIds: null }, { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: ['example-partner'], userId: null, currentPartnerId: 'example-partner' });
  expect(h.getPricing).toHaveBeenCalledWith('example-product'); expect(h.outside).toHaveBeenCalled();
});
