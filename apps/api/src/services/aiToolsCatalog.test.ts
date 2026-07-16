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
  or: (...args: unknown[]) => ({ _op: 'or', args }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ _op: 'sql', strings: [...strings], vals }),
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
    attributes: 'ci.attributes',
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

// Mock the live TD SYNNEX EC Express service so lookup_distributor_product tests
// never make an outbound call. TdSynnexEcExpressError must be a real class so the
// handler's `instanceof` check matches.
vi.mock('./tdSynnexEcExpress', () => {
  class TdSynnexEcExpressError extends Error {
    code: string;
    constructor(message: string, code = 'EC_PROVIDER_ERROR') { super(message); this.code = code; }
  }
  return { lookupEcExpressProducts: vi.fn(), TdSynnexEcExpressError };
});

import { registerCatalogTools } from './aiToolsCatalog';
import { db } from '../db';
import { lookupEcExpressProducts, TdSynnexEcExpressError } from './tdSynnexEcExpress';

const EC_PRODUCT = {
  source: 'td_synnex_ec_express', synnexSku: '14753620', mfgPartNo: 'PC14250', status: 'OK',
  name: 'Dell Pro 14', description: 'Ultra 5', currency: 'USD', cost: 1120.5, msrp: 1499,
  discount: null, totalQty: 42, warehouses: [{ code: 'CA', available: 42, onOrder: 0, bo: 0, eta: null }],
  weight: 3.1, parcelShippable: 'Y', raw: { soap: 'internal-dump' },
} as const;

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
    // The search condition is an OR across name / sku / distributor part numbers;
    // the term is escaped (% and _ become \% and \_) and wrapped in %...%
    const orToken = conds.find((c) => c._op === 'or');
    expect(orToken).toBeDefined();
    expect(orToken.args).toContainEqual({ _op: 'ilike', a: 'ci.name', b: '%50\\%\\_off%' });
  });

  it('search matches sku and distributor part-number attributes (mfgPartNo / synnexSku)', async () => {
    const capture: WhereCapture = {};
    vi.mocked(db.select).mockReturnValue(makeChain([], capture) as any);

    await tools().get('search_catalog')!.handler({ search: '14703953' }, partnerAuth());

    const orToken = flattenConditions(capture.where).find((c) => c._op === 'or');
    expect(orToken).toBeDefined();
    // name + item SKU columns
    expect(orToken.args).toContainEqual({ _op: 'ilike', a: 'ci.name', b: '%14703953%' });
    expect(orToken.args).toContainEqual({ _op: 'ilike', a: 'ci.sku', b: '%14703953%' });
    // jsonb fragments on attributes.distributor.mfgPartNo / .synnexSku
    const sqlFragments = orToken.args.filter((a: any) => a._op === 'sql');
    expect(sqlFragments).toHaveLength(2);
    const fragmentText = sqlFragments.map((f: any) => f.strings.join('?')).join(' | ');
    expect(fragmentText).toContain("'distributor' ->> 'mfgPartNo'");
    expect(fragmentText).toContain("'distributor' ->> 'synnexSku'");
    for (const f of sqlFragments) {
      expect(f.vals).toContainEqual('%14703953%');
    }
  });

  it('applies the isBundle filter for both true and false (but not when omitted)', async () => {
    for (const isBundle of [true, false]) {
      const capture: WhereCapture = {};
      vi.mocked(db.select).mockReturnValue(makeChain([], capture) as any);
      await tools().get('search_catalog')!.handler({ isBundle }, partnerAuth());
      expect(flattenConditions(capture.where)).toContainEqual({ _op: 'eq', a: 'ci.is_bundle', b: isBundle });
    }
    // omitted → no isBundle condition
    const capture: WhereCapture = {};
    vi.mocked(db.select).mockReturnValue(makeChain([], capture) as any);
    await tools().get('search_catalog')!.handler({}, partnerAuth());
    expect(flattenConditions(capture.where).some((c) => c.a === 'ci.is_bundle')).toBe(false);
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

  it('strips internal IDs and attributes.distributor.raw, keeping normalized distributor fields', async () => {
    const row = {
      id: ITEM_ID,
      partnerId: PARTNER_ID,
      createdBy: 'user-uuid',
      name: 'SPL Dock',
      isBundle: false,
      costBasis: '100.00',
      markupPercent: '20.00',
      unitPrice: '120.00',
      attributes: {
        category: 'docks',
        distributor: {
          source: 'td_synnex_ec_express',
          synnexSku: '14703953',
          mfgPartNo: 'SPL-DOCK-1',
          status: 'Active',
          cost: 100,
          msrp: 150,
          warehouses: [{ code: 'A1', available: 3 }],
          importedAt: '2026-07-01T00:00:00.000Z',
          raw: { hugeVerbatimProviderPayload: true, price: 100, msrp: 150 },
        },
      },
    };
    vi.mocked(db.select).mockReturnValueOnce(makeChain([row], {}) as any);

    const out = await tools().get('get_catalog_item')!.handler({ catalogItemId: ITEM_ID }, partnerAuth());
    const parsed = JSON.parse(out);

    // Internal IDs are redacted server-side (MCP instructions say never reveal them).
    expect(parsed.item).not.toHaveProperty('partnerId');
    expect(parsed.item).not.toHaveProperty('createdBy');
    // The verbatim import blob is stripped…
    expect(parsed.item.attributes.distributor).not.toHaveProperty('raw');
    // …but the normalized distributor fields survive.
    expect(parsed.item.attributes.distributor).toMatchObject({
      synnexSku: '14703953',
      mfgPartNo: 'SPL-DOCK-1',
      status: 'Active',
      cost: 100,
      msrp: 150,
      importedAt: '2026-07-01T00:00:00.000Z',
    });
    expect(parsed.item.attributes.distributor.warehouses).toEqual([{ code: 'A1', available: 3 }]);
    // Non-distributor attributes are untouched.
    expect(parsed.item.attributes.category).toBe('docks');
    // Partner scope keeps cost/margin fields.
    expect(parsed.item.costBasis).toBe('100.00');
    expect(parsed.item.markupPercent).toBe('20.00');
  });

  it('drops unknown/future top-level columns and unknown distributor sub-fields by construction (allowlist)', async () => {
    const row = {
      id: ITEM_ID,
      partnerId: PARTNER_ID,
      createdBy: 'user-uuid',
      name: 'SPL Dock',
      isBundle: false,
      unitPrice: '120.00',
      // A column a future migration might add — must NOT reach MCP output because
      // the output is an allowlist, not a blocklist of known-sensitive names.
      supplierAccountId: 'acct-should-not-leak',
      internalNotes: 'confidential margin strategy',
      attributes: {
        category: 'docks',
        distributor: {
          synnexSku: '14703953',
          cost: 100,
          msrp: 150,
          raw: { verbatim: true },
          // A future distributor sub-field an importer might store — must be dropped.
          dealerCost: 42,
          supplierToken: 'secret-token',
        },
      },
    };
    vi.mocked(db.select).mockReturnValueOnce(makeChain([row], {}) as any);

    const out = await tools().get('get_catalog_item')!.handler({ catalogItemId: ITEM_ID }, partnerAuth());
    const parsed = JSON.parse(out);

    // Unknown top-level columns are dropped even for partner (full-access) scope.
    expect(parsed.item).not.toHaveProperty('supplierAccountId');
    expect(parsed.item).not.toHaveProperty('internalNotes');
    // Known allowlisted fields still present.
    expect(parsed.item.name).toBe('SPL Dock');
    expect(parsed.item.unitPrice).toBe('120.00');
    // Unknown distributor sub-fields (and the raw blob) are dropped; normalized survive.
    expect(parsed.item.attributes.distributor).not.toHaveProperty('raw');
    expect(parsed.item.attributes.distributor).not.toHaveProperty('dealerCost');
    expect(parsed.item.attributes.distributor).not.toHaveProperty('supplierToken');
    expect(parsed.item.attributes.distributor).toMatchObject({ synnexSku: '14703953', cost: 100, msrp: 150 });
    // Non-distributor attribute keys still pass through.
    expect(parsed.item.attributes.category).toBe('docks');
  });

  it('redacts costBasis/markupPercent/distributor.cost for org-scoped callers (defense-in-depth)', async () => {
    const row = {
      id: ITEM_ID,
      partnerId: PARTNER_ID,
      createdBy: 'user-uuid',
      name: 'SPL Dock',
      isBundle: false,
      costBasis: '100.00',
      markupPercent: '20.00',
      unitPrice: '120.00',
      attributes: { distributor: { synnexSku: '14703953', cost: 100, msrp: 150, raw: {} } },
    };
    vi.mocked(db.select).mockReturnValueOnce(makeChain([row], {}) as any);

    const orgAuth = {
      user: { id: 'u1' },
      partnerId: PARTNER_ID, // org tokens DO carry the owning org's partnerId
      scope: 'organization',
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
    } as any;
    const out = await tools().get('get_catalog_item')!.handler({ catalogItemId: ITEM_ID }, orgAuth);
    const parsed = JSON.parse(out);

    expect(parsed.item).not.toHaveProperty('costBasis');
    expect(parsed.item).not.toHaveProperty('markupPercent');
    expect(parsed.item.attributes.distributor).not.toHaveProperty('cost');
    expect(parsed.item.attributes.distributor).not.toHaveProperty('raw');
    // Sell-side fields remain visible.
    expect(parsed.item.unitPrice).toBe('120.00');
    expect(parsed.item.attributes.distributor.msrp).toBe(150);
  });

  it('redacts revenueAllocation from bundle components for org-scoped callers', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(makeChain([{ id: ITEM_ID, isBundle: true, attributes: {} }], {}) as any)
      .mockReturnValueOnce(
        makeChain(
          [{ id: 'comp-row', componentItemId: 'c1', quantity: '2', showOnInvoice: false, revenueAllocation: '60.00' }],
          {}
        ) as any
      );

    const orgAuth = {
      user: { id: 'u1' },
      partnerId: PARTNER_ID,
      scope: 'organization',
      orgId: 'org-1',
      accessibleOrgIds: ['org-1'],
    } as any;
    const out = await tools().get('get_catalog_item')!.handler({ catalogItemId: ITEM_ID }, orgAuth);
    const parsed = JSON.parse(out);
    expect(parsed.components).toEqual([
      { id: 'comp-row', componentItemId: 'c1', quantity: '2', showOnInvoice: false },
    ]);
  });

  it('handles items with no distributor attributes (empty attributes object)', async () => {
    const row = { id: ITEM_ID, partnerId: PARTNER_ID, createdBy: null, isBundle: false, attributes: {} };
    vi.mocked(db.select).mockReturnValueOnce(makeChain([row], {}) as any);

    const out = await tools().get('get_catalog_item')!.handler({ catalogItemId: ITEM_ID }, partnerAuth());
    const parsed = JSON.parse(out);
    expect(parsed.item.attributes).toEqual({});
    expect(parsed.item).not.toHaveProperty('partnerId');
    expect(parsed.item).not.toHaveProperty('createdBy');
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

describe('aiToolsCatalog: lookup_distributor_product', () => {
  function orgAuth() {
    return { user: { id: 'u1' }, partnerId: PARTNER_ID, scope: 'organization', orgId: 'o1', accessibleOrgIds: ['o1'] } as any;
  }

  it('rejects an empty query without calling the distributor', async () => {
    const out = await tools().get('lookup_distributor_product')!.handler({ query: '   ' }, partnerAuth());
    expect(JSON.parse(out).error).toMatch(/SKU or manufacturer part number/);
    expect(lookupEcExpressProducts).not.toHaveBeenCalled();
  });

  it('returns a partner-scoped error (and no outbound call) when there is no partner', async () => {
    const out = await tools().get('lookup_distributor_product')!.handler({ query: '14753620' }, noPartnerAuth());
    expect(JSON.parse(out)).toEqual({ error: 'Distributor lookup is partner-scoped; no partner in context' });
    expect(lookupEcExpressProducts).not.toHaveBeenCalled();
  });

  it('returns products with cost for a partner-scoped caller, dropping the raw SOAP payload', async () => {
    vi.mocked(lookupEcExpressProducts).mockResolvedValue([EC_PRODUCT as any]);
    const out = await tools().get('lookup_distributor_product')!.handler({ query: '14753620' }, partnerAuth());
    expect(lookupEcExpressProducts).toHaveBeenCalledWith('14753620', expect.objectContaining({ partnerId: PARTNER_ID }));
    const parsed = JSON.parse(out);
    expect(parsed.showing).toBe(1);
    expect(parsed.products[0].cost).toBe(1120.5); // partner keeps cost
    expect(parsed.products[0].synnexSku).toBe('14753620');
    expect(parsed.products[0].raw).toBeUndefined(); // internal SOAP dump never exposed
  });

  it('redacts reseller cost for an organization-scoped caller', async () => {
    vi.mocked(lookupEcExpressProducts).mockResolvedValue([EC_PRODUCT as any]);
    const out = await tools().get('lookup_distributor_product')!.handler({ query: '14753620' }, orgAuth());
    const parsed = JSON.parse(out);
    expect(parsed.products[0].cost).toBeUndefined(); // cost is partner-sensitive
    expect(parsed.products[0].msrp).toBe(1499);      // customer-facing fields stay
    expect(parsed.products[0].raw).toBeUndefined();
  });

  it('surfaces a typed provider error as JSON instead of throwing', async () => {
    vi.mocked(lookupEcExpressProducts).mockRejectedValue(new TdSynnexEcExpressError('No results for that SKU/part #', 'EC_NO_RESULTS'));
    const out = await tools().get('lookup_distributor_product')!.handler({ query: 'NOPE' }, partnerAuth());
    expect(JSON.parse(out)).toEqual({ error: 'No results for that SKU/part #', code: 'EC_NO_RESULTS' });
  });
});
