import { beforeEach, describe, expect, it, vi } from 'vitest';

const PARTNER = '00000000-0000-4000-8000-0000000000a1';
const OTHER_PARTNER = '00000000-0000-4000-8000-0000000000a2';
const CAT = '00000000-0000-4000-8000-0000000000c1';
const CAT2 = '00000000-0000-4000-8000-0000000000c2';
const PARENT = '00000000-0000-4000-8000-0000000000c3';
const WT = '00000000-0000-4000-8000-0000000000d1';
const ORG = '00000000-0000-4000-8000-0000000000b1';

const { m } = vi.hoisted(() => {
  const queue: unknown[][] = [];
  const chain: Record<string, unknown> = {};
  for (const k of ['from', 'where', 'orderBy', 'limit', 'values', 'set']) chain[k] = vi.fn(() => chain);
  chain.returning = vi.fn(async () => queue.shift() ?? []);
  chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(queue.shift() ?? []).then(res, rej);
  return { m: { queue, chain, getActiveWorkType: vi.fn(), update: vi.fn(), insert: vi.fn(), systemCtx: vi.fn() } };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => m.chain),
    insert: vi.fn((...a: unknown[]) => { m.insert(...a); return m.chain; }),
    update: vi.fn((...a: unknown[]) => { m.update(...a); return m.chain; }),
  },
  runOutsideDbContext: async (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => { m.systemCtx(); return fn(); },
}));
vi.mock('../db/schema', () => ({
  organizations: new Proxy({}, { get: (_t, p) => `o.${String(p)}` }),
  ticketCategories: new Proxy({}, { get: (_t, p) => `c.${String(p)}` }),
}));
vi.mock('./workTypeService', () => ({ getActiveWorkType: m.getActiveWorkType }));

import type { AuthContext } from '../middleware/auth';
import { createCategory, deleteCategory, listCategoryRows, reorderCategories, updateCategory } from './aiToolsTicketCategories';

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' }, user: { id: 'u1', name: 'T', isPlatformAdmin: false }, token: {},
  partnerId: PARTNER, orgId: null, scope: 'partner', partnerOrgAccess: 'all', accessibleOrgIds: [ORG], ...over,
}) as unknown as AuthContext;
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  m.queue.length = 0;
  m.getActiveWorkType.mockResolvedValue({ id: WT });
});

describe('ticket categories (W06, mirrors routes/ticketCategories.ts)', () => {
  describe('write gate', () => {
    it.each([
      ['create', (a: AuthContext) => createCategory(a, { name: 'x' })],
      ['update', (a: AuthContext) => updateCategory(a, CAT, { name: 'x' })],
      ['delete', (a: AuthContext) => deleteCategory(a, CAT)],
      ['reorder', (a: AuthContext) => reorderCategories(a, [CAT])],
    ])('%s needs full partner access and a partner id', async (_n, fn) => {
      expect(parse(await fn(makeAuth({ partnerOrgAccess: 'selected' })))).toMatchObject({ code: 'ACCESS_DENIED' });
      expect(parse(await fn(makeAuth({ scope: 'system', partnerId: null })))).toMatchObject({ code: 'ACCESS_DENIED', error: 'Partner context required' });
      expect(m.insert).not.toHaveBeenCalled();
      expect(m.update).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('stamps the caller partner (ignoring one in data) and returns the projection', async () => {
      m.queue.push([{ id: CAT, name: 'Hardware' }]);
      expect(parse(await createCategory(makeAuth(), { name: 'Hardware', partnerId: OTHER_PARTNER }))).toEqual({ category: { id: CAT, name: 'Hardware' } });
      expect(m.chain.values).toHaveBeenCalledWith(expect.objectContaining({ name: 'Hardware', partnerId: PARTNER }));
    });

    it('applies the route validator (bounds, colour, retired pricing keys)', async () => {
      expect(parse(await createCategory(makeAuth(), { name: '' }))).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(parse(await createCategory(makeAuth(), { name: 'x', color: 'red' }))).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(parse(await createCategory(makeAuth(), { name: 'x', defaultHourlyRate: 100 }))).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(m.insert).not.toHaveBeenCalled();
    });

    it('a parent in another partner, and an inactive or foreign default work type, are clean tool errors (not a 23503)', async () => {
      m.queue.push([{ id: PARENT, partnerId: OTHER_PARTNER }]);
      expect(parse(await createCategory(makeAuth(), { name: 'x', parentId: PARENT }))).toEqual({ error: 'Parent category not found' });
      m.queue.push([]);
      expect(parse(await createCategory(makeAuth(), { name: 'x', parentId: PARENT }))).toEqual({ error: 'Parent category not found' });
      m.getActiveWorkType.mockResolvedValue(null);
      expect(parse(await createCategory(makeAuth(), { name: 'x', defaultWorkTypeId: WT }))).toEqual({ error: 'Default work type not found' });
      expect(m.getActiveWorkType).toHaveBeenCalledWith(WT, PARTNER);
      expect(m.insert).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('scopes the UPDATE to the caller partner for a partner token', async () => {
      m.queue.push([{ id: CAT, name: 'Renamed' }]);
      expect(parse(await updateCategory(makeAuth(), CAT, { name: 'Renamed' }))).toEqual({ category: { id: CAT, name: 'Renamed' } });
      const where = (m.chain.where as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      expect(JSON.stringify(where)).toContain(PARTNER);
    });

    it('a category of another partner updates nothing and reads as not found', async () => {
      m.queue.push([]);
      expect(parse(await updateCategory(makeAuth(), CAT, { name: 'x' }))).toEqual({ error: 'Category not found' });
    });

    it('refuses a category as its own parent, and a parent from a different partner', async () => {
      expect(parse(await updateCategory(makeAuth(), CAT, { parentId: CAT }))).toEqual({ error: 'Category cannot be its own parent' });
      m.queue.push([{ id: PARENT, partnerId: OTHER_PARTNER }]);
      expect(parse(await updateCategory(makeAuth(), CAT, { parentId: PARENT }))).toEqual({ error: 'Parent category not found' });
      expect(m.update).not.toHaveBeenCalled();
    });

    it('system scope validates the parent against the TARGET category\'s partner', async () => {
      const sys = makeAuth({ scope: 'system', partnerId: PARTNER });
      m.queue.push([{ partnerId: OTHER_PARTNER }], [{ id: PARENT, partnerId: PARTNER }]);
      expect(parse(await updateCategory(sys, CAT, { parentId: PARENT }))).toEqual({ error: 'Parent category not found' });
      m.queue.push([{ partnerId: PARTNER }], [{ id: PARENT, partnerId: PARTNER }], [{ id: CAT }]);
      expect(parse(await updateCategory(sys, CAT, { parentId: PARENT }))).toMatchObject({ category: { id: CAT } });
    });

    it('an empty patch and a malformed id are validation errors', async () => {
      expect(parse(await updateCategory(makeAuth(), CAT, {}))).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(parse(await updateCategory(makeAuth(), 'nope', { name: 'x' }))).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('delete', () => {
    it('soft-deactivates (isActive=false) within the caller partner', async () => {
      m.queue.push([{ id: CAT, isActive: false }]);
      expect(parse(await deleteCategory(makeAuth(), CAT))).toMatchObject({ deactivated: true });
      expect((m.chain.set as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).toMatchObject({ isActive: false });
    });

    it('reports not found when nothing matched', async () => {
      m.queue.push([]);
      expect(parse(await deleteCategory(makeAuth(), CAT))).toEqual({ error: 'Category not found' });
    });
  });

  describe('reorder', () => {
    it('rejects duplicate ids and unknown/foreign ids wholesale (no partial reorder)', async () => {
      expect(parse(await reorderCategories(makeAuth(), [CAT, CAT]))).toMatchObject({ code: 'VALIDATION_ERROR' });
      m.queue.push([{ id: CAT, partnerId: PARTNER }]); // CAT2 missing
      expect(parse(await reorderCategories(makeAuth(), [CAT, CAT2]))).toEqual({ error: 'One or more categories not found' });
      m.queue.push([{ id: CAT, partnerId: PARTNER }, { id: CAT2, partnerId: OTHER_PARTNER }]);
      expect(parse(await reorderCategories(makeAuth(), [CAT, CAT2]))).toEqual({ error: 'One or more categories not found' });
      expect(m.update).not.toHaveBeenCalled();
    });

    it('writes the array position as sortOrder', async () => {
      m.queue.push([{ id: CAT, partnerId: PARTNER }, { id: CAT2, partnerId: PARTNER }]);
      expect(parse(await reorderCategories(makeAuth(), [CAT2, CAT]))).toEqual({ reordered: 2 });
      const sets = (m.chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as { sortOrder: number }).sortOrder);
      expect(sets).toEqual([0, 1]);
    });
  });

  describe('list', () => {
    it('partner scope: full access required, rows filtered to the caller partner', async () => {
      const denied = await listCategoryRows(makeAuth({ partnerOrgAccess: 'selected' }));
      expect(denied).toHaveProperty('error');
      m.queue.push([{ id: CAT }]);
      expect(await listCategoryRows(makeAuth())).toEqual({ rows: [{ id: CAT }] });
    });

    it('organization token: the selectable catalog (active only) of the org\'s partner, read in system context', async () => {
      const orgTok = makeAuth({ scope: 'organization', orgId: ORG, partnerOrgAccess: undefined });
      m.queue.push([{ partnerId: PARTNER }], [{ id: CAT, name: 'Hardware', isActive: true }]);
      expect(await listCategoryRows(orgTok)).toEqual({ rows: [{ id: CAT, name: 'Hardware', isActive: true }] });
      expect(m.systemCtx).toHaveBeenCalledTimes(1);
      expect(JSON.stringify((m.chain.where as ReturnType<typeof vi.fn>).mock.calls.at(-1))).toContain(PARTNER);
    });

    it('an org without a resolvable partner lists nothing; a token without an org is refused', async () => {
      m.queue.push([]);
      expect(await listCategoryRows(makeAuth({ scope: 'organization', orgId: ORG }))).toEqual({ rows: [] });
      expect(await listCategoryRows(makeAuth({ scope: 'organization', orgId: null }))).toHaveProperty('error');
    });
  });
});
