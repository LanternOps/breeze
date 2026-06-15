import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock drizzle's condition builders to return inspectable tokens so we can
// assert exactly which columns/values the handler filtered on (partner-scoping,
// the isActive guard) without a real database. `asc` is used by the handler's
// orderBy and must be present.
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ _op: 'and', args }),
  eq: (a: unknown, b: unknown) => ({ _op: 'eq', a, b }),
  ilike: (a: unknown, b: unknown) => ({ _op: 'ilike', a, b }),
  asc: (a: unknown) => ({ _op: 'asc', a }),
}));

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  catalogItems: {
    id: 'ci.id',
    name: 'ci.name',
    itemType: 'ci.item_type',
    sku: 'ci.sku',
    unitPrice: 'ci.unit_price',
    isBundle: 'ci.is_bundle',
    isActive: 'ci.is_active',
    partnerId: 'ci.partner_id',
  },
  catalogItemOrgPricing: { id: 'cop.id' },
  catalogBundleComponents: {
    id: 'cbc.id',
    componentItemId: 'cbc.component_item_id',
    quantity: 'cbc.quantity',
    showOnInvoice: 'cbc.show_on_invoice',
    revenueAllocation: 'cbc.revenue_allocation',
    bundleItemId: 'cbc.bundle_item_id',
    partnerId: 'cbc.partner_id',
  },
}));

import { registerCatalogTools } from './aiToolsCatalog';
import { db } from '../db';

const PARTNER_ID = '22222222-2222-2222-2222-222222222222';
const ITEM_ID = '33333333-3333-3333-3333-333333333333';

type WhereCapture = { where?: unknown };

// A select chain that records the `where` token and resolves to `result`.
// Supports the search_catalog shape (from→where→orderBy→limit) and the
// get_catalog_item shapes (from→where→limit, and from→where).
function makeChain(result: unknown[], capture: WhereCapture) {
  const chain: any = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn((w: unknown) => {
      capture.where = w;
      return chain;
    }),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
  };
  return chain;
}

function tools() {
  const m = new Map<string, any>();
  registerCatalogTools(m);
  return m;
}

function partnerAuth() {
  return { user: { id: 'u1' }, partnerId: PARTNER_ID, scope: 'partner', orgId: null, accessibleOrgIds: null } as any;
}
function noPartnerAuth() {
  return { user: { id: 'u1' }, partnerId: null, scope: 'system', orgId: null, accessibleOrgIds: null } as any;
}

// Walk an `and` token tree and collect the leaf condition tokens.
function flattenConditions(token: any): any[] {
  if (!token || typeof token !== 'object') return [];
  if (token._op === 'and') return token.args.flatMap(flattenConditions);
  return [token];
}

beforeEach(() => vi.clearAllMocks());

describe('aiToolsCatalog: search_catalog', () => {
  it('returns a partner-scoped JSON error when there is no partner in context', async () => {
    const out = await tools().get('search_catalog')!.handler({}, noPartnerAuth());
    expect(JSON.parse(out)).toEqual({ error: 'Catalog is partner-scoped; no partner in context' });
    // The DB must never be queried without a partner.
    expect(db.select).not.toHaveBeenCalled();
  });

  it('filters by partnerId AND isActive=true (partner-scoping + active filter)', async () => {
    const capture: WhereCapture = {};
    vi.mocked(db.select).mockReturnValue(makeChain([{ id: ITEM_ID, name: 'Widget' }], capture) as any);

    const out = await tools().get('search_catalog')!.handler({}, partnerAuth());
    expect(JSON.parse(out)).toEqual({ items: [{ id: ITEM_ID, name: 'Widget' }], showing: 1 });

    const conds = flattenConditions(capture.where);
    // partner-scoping: eq(partnerId, PARTNER_ID)
    expect(conds).toContainEqual({ _op: 'eq', a: 'ci.partner_id', b: PARTNER_ID });
    // active filter: eq(isActive, true)
    expect(conds).toContainEqual({ _op: 'eq', a: 'ci.is_active', b: true });
    // with no search/itemType supplied, those are the only two conditions
    expect(conds).toHaveLength(2);
  });

  it('adds an itemType and an (escaped) search filter when supplied', async () => {
    const capture: WhereCapture = {};
    vi.mocked(db.select).mockReturnValue(makeChain([], capture) as any);

    await tools().get('search_catalog')!.handler({ itemType: 'hardware', search: '50%_off' }, partnerAuth());

    const conds = flattenConditions(capture.where);
    expect(conds).toContainEqual({ _op: 'eq', a: 'ci.item_type', b: 'hardware' });
    // search term is escaped (% and _ become \% and \_) and wrapped in %...%
    expect(conds).toContainEqual({ _op: 'ilike', a: 'ci.name', b: '%50\\%\\_off%' });
  });
});

describe('aiToolsCatalog: get_catalog_item', () => {
  it('returns a partner-scoped JSON error with no partner in context', async () => {
    const out = await tools().get('get_catalog_item')!.handler({ catalogItemId: ITEM_ID }, noPartnerAuth());
    expect(JSON.parse(out)).toEqual({ error: 'Catalog is partner-scoped; no partner in context' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('scopes the item lookup to the partner and returns not-found when empty', async () => {
    const capture: WhereCapture = {};
    vi.mocked(db.select).mockReturnValue(makeChain([], capture) as any);

    const out = await tools().get('get_catalog_item')!.handler({ catalogItemId: ITEM_ID }, partnerAuth());
    expect(JSON.parse(out)).toEqual({ error: 'Catalog item not found' });

    const conds = flattenConditions(capture.where);
    expect(conds).toContainEqual({ _op: 'eq', a: 'ci.id', b: ITEM_ID });
    expect(conds).toContainEqual({ _op: 'eq', a: 'ci.partner_id', b: PARTNER_ID });
  });

  it('returns NO components for a non-bundle item (single select call only)', async () => {
    const itemCapture: WhereCapture = {};
    vi.mocked(db.select).mockReturnValueOnce(makeChain([{ id: ITEM_ID, isBundle: false, name: 'Plain' }], itemCapture) as any);

    const out = await tools().get('get_catalog_item')!.handler({ catalogItemId: ITEM_ID }, partnerAuth());
    const parsed = JSON.parse(out);
    expect(parsed.item).toMatchObject({ id: ITEM_ID, isBundle: false });
    expect(parsed.components).toBeUndefined();
    // Only the item lookup ran — the components query is gated on isBundle.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('returns components for a bundle item (second select scoped to the bundle + partner)', async () => {
    const itemCapture: WhereCapture = {};
    const compCapture: WhereCapture = {};
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ id: ITEM_ID, isBundle: true, name: 'Bundle' }], itemCapture) as any)
      .mockReturnValueOnce(makeChain([{ id: 'comp-row', componentItemId: 'c1', quantity: '2' }], compCapture) as any);

    const out = await tools().get('get_catalog_item')!.handler({ catalogItemId: ITEM_ID }, partnerAuth());
    const parsed = JSON.parse(out);
    expect(parsed.item).toMatchObject({ id: ITEM_ID, isBundle: true });
    expect(parsed.components).toEqual([{ id: 'comp-row', componentItemId: 'c1', quantity: '2' }]);
    expect(db.select).toHaveBeenCalledTimes(2);

    // The components query is scoped to the bundle id AND the partner.
    const conds = flattenConditions(compCapture.where);
    expect(conds).toContainEqual({ _op: 'eq', a: 'cbc.bundle_item_id', b: ITEM_ID });
    expect(conds).toContainEqual({ _op: 'eq', a: 'cbc.partner_id', b: PARTNER_ID });
  });
});
