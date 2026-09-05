import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock (same pattern as invoiceService.test.ts): every
// builder method returns the same chain; a query resolves when awaited (the
// chain is a thenable that yields the next queued result). Tests queue the rows
// each db call should resolve to, in call order.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    // Execute the callback with the same chain as `tx` — each awaited tx call
    // still consumes one queued result, exactly like a bare db call.
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  return {
    db,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

// Multi-currency wave 3 (#3775): addCatalogLine prices the line through the
// catalog price-book resolver, never from catalog_items.unit_price. Mock the
// resolver only; CatalogServiceError stays real so the code-mapping path is
// exercised.
vi.mock('./catalogService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./catalogService')>();
  return { ...actual, resolvePrice: vi.fn() };
});

import * as svc from './quoteService';
import { db } from '../db';
import { resolvePrice, CatalogServiceError } from './catalogService';

const resolvePriceMock = vi.mocked(resolvePrice);
const resolvedUsd = (over: Partial<Awaited<ReturnType<typeof resolvePrice>>> = {}) => ({
  unitPrice: '42.00', currencyCode: 'USD', costBasis: '30.00', costCurrency: 'USD',
  marginAvailable: true, taxable: true, taxCategory: null, source: 'price_book' as const, ...over,
});

type Chain = { set: { mock: { calls: unknown[][] } }; values: { mock: { calls: unknown[][] } } };

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

describe('customer quote-line projection (#3205 W05)', () => {
  it('carries descriptor prose and billing fields but omits internal descriptor ids', () => {
    const [line] = svc.toCustomerLines([{
      id: 'l1', name: 'Managed servers', contractLineType: 'per_device_role',
      deviceRoles: ['server'], deviceGroupId: 'group-internal', deviceGroupName: 'VIP Servers',
      siteId: 'site-internal', siteName: 'Denver', includedQuantity: '25.00',
      overageMode: 'bill', overageUnitPrice: '4.50', unitCost: '2.00',
    }]);

    expect(line).toMatchObject({
      contractLineType: 'per_device_role', deviceRoles: ['server'],
      deviceGroupName: 'VIP Servers', siteName: 'Denver', includedQuantity: '25.00',
      overageMode: 'bill', overageUnitPrice: '4.50',
    });
    expect(line).not.toHaveProperty('deviceGroupId');
    expect(line).not.toHaveProperty('siteId');
    expect(line).not.toHaveProperty('unitCost');
  });
});

describe('quoteService deposits', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('updateQuote persists deposit config and recompute stores deposit_amount', async () => {
    // Every awaited db call consumes one queued result, whether or not the
    // caller destructures it — the header/recompute `update` calls below are
    // "unused" results but still need a slot (see the chain mock's `.then`).
    // loadDraft
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', taxRate: '0.10000', depositType: 'none', depositPercent: null }]);
    // deposit-validation lines fetch: a single $1000 one-time taxable line
    queueResult([{ quantity: '1', unitPrice: '1000.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false }]);
    queueResult([]); // updateQuote's own header update (unused result)
    // recomputeAndPersist: header select (now reflecting the just-persisted deposit config)
    queueResult([{ taxRate: '0.10000', depositType: 'percent', depositPercent: '30.00' }]);
    // recomputeAndPersist: widened lines select
    queueResult([{ quantity: '1', unitPrice: '1000.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false, itemType: 'hardware' }]);
    queueResult([]); // recomputeAndPersist's own update (unused result)
    // final re-select
    queueResult([{ id: 'q1', orgId: 'org1', depositType: 'percent', depositPercent: '30.00', depositAmount: '330.00' }]);

    const updated = await svc.updateQuote('q1', { depositType: 'percent', depositPercent: 30 }, actor);

    expect(updated.depositType).toBe('percent');
    expect(updated.depositAmount).toBe('330.00');

    const setMock = (db as unknown as Chain).set;
    // Call 0: updateQuote's own header update — persists the deposit config.
    expect(setMock.mock.calls[0]![0]).toMatchObject({ depositType: 'percent', depositPercent: '30.00' });
    // Call 1: recomputeAndPersist's update — persists the recomputed deposit_amount.
    expect(setMock.mock.calls[1]![0]).toMatchObject({ depositAmount: '330.00' });
  });

  it('updateQuote validates + totals a deposit against a tax rate changed in the SAME patch', async () => {
    // Regression guard for the effectiveTaxRate branch: a taxRate and a deposit
    // arriving in one patch must be coherent — the persisted deposit_amount uses
    // the NEW rate (25%), not the stale persisted one (0%). A $100 one-time taxable
    // line at 25% tax → dueOnAcceptance $125; a 50% percent deposit → $62.50.
    // loadDraft
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', taxRate: '0.00000', depositType: 'none', depositPercent: null }]);
    // deposit-validation lines fetch
    queueResult([{ quantity: '1', unitPrice: '100.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false }]);
    queueResult([]); // updateQuote's own header update
    // recomputeAndPersist: header select now reflects the just-persisted 25% rate + deposit config
    queueResult([{ taxRate: '0.25000', depositType: 'percent', depositPercent: '50.00' }]);
    queueResult([{ quantity: '1', unitPrice: '100.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false, itemType: 'hardware' }]);
    queueResult([]); // recomputeAndPersist's own update
    queueResult([{ id: 'q1', orgId: 'org1', taxRate: '0.25000', depositType: 'percent', depositPercent: '50.00', depositAmount: '62.50' }]);

    const updated = await svc.updateQuote('q1', { taxRate: 0.25, depositType: 'percent', depositPercent: 50 }, actor);
    expect(updated.depositAmount).toBe('62.50');

    const setMock = (db as unknown as Chain).set;
    // Header update persists both the new rate and the deposit config in one write.
    expect(setMock.mock.calls[0]![0]).toMatchObject({ taxRate: '0.25000', depositType: 'percent', depositPercent: '50.00' });
    // Recompute persists the deposit_amount computed on the NEW 25% rate.
    expect(setMock.mock.calls[1]![0]).toMatchObject({ depositAmount: '62.50' });
  });

  it('updateQuote reassigns a draft to another company: children re-tenanted, site/bill-to reset, tax re-resolved', async () => {
    const orgActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1', 'org2'] };
    // loadDraft
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD', siteId: 's1', billToName: 'Old Co', taxRate: '0.10000', depositType: 'none', depositPercent: null }]);
    queueResult([{ id: 'org2', currencyCode: 'USD' }]); // target org same-partner membership check (currency matches the draft stamp)
    // resolveQuoteTaxRate for the NEW org: 5% org rate, no partner default
    queueResult([{ taxExempt: false, taxRate: '0.05000' }]);
    queueResult([{ defaultTaxRate: null }]);
    queueResult([]); // contract-blocks re-validation fetch (no contract blocks)
    queueResult([]); // SET CONSTRAINTS quote_lines_quote_org_fk DEFERRED
    queueResult([{ currencyCode: 'USD' }]); // org SHARE barrier inside the move tx (#3778)
    queueResult([]); // tx: quotes header update
    queueResult([]); // tx: blocks org move
    queueResult([]); // tx: scoped lines clear + org move
    queueResult([]); // tx: remaining lines org move
    queueResult([]); // tx: images org move
    queueResult([]); // tx: unscoped descriptor lines
    // recomputeAndPersist: header select (new rate), lines, own update
    queueResult([{ taxRate: '0.05000', depositType: 'none', depositPercent: null }]);
    queueResult([{ quantity: '1', unitPrice: '100.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false, itemType: 'hardware' }]);
    queueResult([]);
    // final re-select
    queueResult([{ id: 'q1', orgId: 'org2', siteId: null, billToName: null, taxRate: '0.05000' }]);

    const updated = await svc.updateQuote('q1', { orgId: 'org2' }, orgActor);

    expect(updated.orgId).toBe('org2');
    const setMock = (db as unknown as Chain).set;
    // Call 0: the header update moves the org, clears the old customer's site +
    // bill-to override, and applies the new org's resolved tax rate.
    expect(setMock.mock.calls[0]![0]).toMatchObject({ orgId: 'org2', siteId: null, billToName: null, taxRate: '0.05000' });
    // Calls 1-4: denormalized org_id moves on blocks, scoped lines, remaining
    // lines, and images.
    expect(setMock.mock.calls[1]![0]).toEqual({ orgId: 'org2' });
    expect(setMock.mock.calls[2]![0]).toEqual({ orgId: 'org2', deviceGroupId: null, siteId: null });
    expect(setMock.mock.calls[3]![0]).toEqual({ orgId: 'org2' });
    expect(setMock.mock.calls[4]![0]).toEqual({ orgId: 'org2' });
  });

  it('updateQuote org change with an explicit taxRate in the same patch skips re-resolution and keeps the explicit rate', async () => {
    const orgActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1', 'org2'] };
    // loadDraft
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD', siteId: null, billToName: null, taxRate: '0.10000', depositType: 'none', depositPercent: null }]);
    queueResult([{ id: 'org2', currencyCode: 'USD' }]); // membership check (currency matches the draft stamp) — NO resolveQuoteTaxRate selects follow
    queueResult([]); // contract-blocks re-validation fetch (no contract blocks)
    queueResult([]); // SET CONSTRAINTS
    queueResult([{ currencyCode: 'USD' }]); // org SHARE barrier inside the move tx (#3778)
    queueResult([]); // tx: quotes header update
    queueResult([]); // tx: blocks org move
    queueResult([]); // tx: scoped lines clear + org move
    queueResult([]); // tx: remaining lines org move
    queueResult([]); // tx: images org move
    queueResult([]); // tx: unscoped descriptor lines
    queueResult([{ taxRate: '0.20000', depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update
    queueResult([{ id: 'q1', orgId: 'org2', taxRate: '0.20000' }]); // final re-select

    const updated = await svc.updateQuote('q1', { orgId: 'org2', taxRate: 0.2 }, orgActor);

    expect(updated.taxRate).toBe('0.20000');
    const setMock = (db as unknown as Chain).set;
    // The explicit rate wins — the org-change branch must not clobber it with a
    // re-resolved default (nor consume the resolveQuoteTaxRate selects at all).
    expect(setMock.mock.calls[0]![0]).toMatchObject({ orgId: 'org2', taxRate: '0.20000' });
  });

  it('updateQuote org change preserves a billToName supplied in the same patch', async () => {
    const orgActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1', 'org2'] };
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD', siteId: null, billToName: 'Old Co', taxRate: null, depositType: 'none', depositPercent: null }]); // loadDraft
    queueResult([{ id: 'org2', currencyCode: 'USD' }]); // membership check (currency matches the draft stamp)
    queueResult([{ taxExempt: false, taxRate: null }]); // resolveQuoteTaxRate org
    queueResult([{ defaultTaxRate: null }]); // resolveQuoteTaxRate partner
    queueResult([]); // contract-blocks re-validation fetch (no contract blocks)
    queueResult([]); // SET CONSTRAINTS
    queueResult([{ currencyCode: 'USD' }]); // org SHARE barrier inside the move tx (#3778)
    queueResult([]); // tx: quotes header update
    queueResult([]); // tx: blocks org move
    queueResult([]); // tx: scoped lines clear + org move
    queueResult([]); // tx: remaining lines org move
    queueResult([]); // tx: images org move
    queueResult([]); // tx: unscoped descriptor lines
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update
    queueResult([{ id: 'q1', orgId: 'org2', billToName: 'Fresh Contact' }]); // final re-select

    await svc.updateQuote('q1', { orgId: 'org2', billToName: 'Fresh Contact' }, orgActor);

    const setMock = (db as unknown as Chain).set;
    // The fresh override survives the org change; only an unsupplied billToName
    // is nulled as a stale reference to the old customer.
    expect(setMock.mock.calls[0]![0]).toMatchObject({ orgId: 'org2', billToName: 'Fresh Contact' });
  });

  it('updateQuote rejects reassignment to an org outside the actor scope', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', taxRate: null, depositType: 'none', depositPercent: null }]);

    await expect(svc.updateQuote('q1', { orgId: 'org2' }, actor)).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });

  it('updateQuote rejects reassignment to an org billed in another currency (CURRENCY_MISMATCH, nothing written)', async () => {
    const orgActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1', 'org2'] };
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'EUR', siteId: null, billToName: null, taxRate: null, depositType: 'none', depositPercent: null }]); // loadDraft — an EUR draft
    queueResult([{ id: 'org2', currencyCode: 'USD' }]); // membership check — target org bills USD

    await expect(svc.updateQuote('q1', { orgId: 'org2' }, orgActor))
      .rejects.toMatchObject({ code: 'CURRENCY_MISMATCH', status: 400 });
    // The header update never fired — the guard rejects before any write.
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls).toEqual([]);
  });

  it('updateQuote rejects reassignment to an org of another partner', async () => {
    const orgActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1', 'org2'] };
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', taxRate: null, depositType: 'none', depositPercent: null }]);
    queueResult([]); // membership check finds no org2 row under p1

    await expect(svc.updateQuote('q1', { orgId: 'org2' }, orgActor)).rejects.toMatchObject({ code: 'ORG_NOT_FOUND', status: 404 });
  });

  it('updateQuote rejects reassignment that would carry an org-owned contract block to the new org (422)', async () => {
    const orgActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1', 'org2'] };
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD', siteId: null, billToName: null, taxRate: null, depositType: 'none', depositPercent: null }]); // loadDraft
    queueResult([{ id: 'org2', currencyCode: 'USD' }]); // membership check (currency matches the draft stamp)
    queueResult([{ taxExempt: false, taxRate: null }]); // resolveQuoteTaxRate org
    queueResult([{ defaultTaxRate: null }]); // resolveQuoteTaxRate partner
    queueResult([{ blockType: 'contract', content: { templateId: 'tpl-1', templateVersionId: 'ver-1' } }]); // contract-blocks re-validation fetch
    queueResult([]); // SET CONSTRAINTS
    queueResult([{ currencyCode: 'USD' }]); // org SHARE barrier inside the move tx (#3778)
    // assertContractBlockValid inside the tx: version published, template OWNED BY org1 (invalid for org2)
    queueResult([{ templateId: 'tpl-1', status: 'published' }]);
    queueResult([{ status: 'active', orgId: 'org1', partnerId: 'p1' }]);

    await expect(svc.updateQuote('q1', { orgId: 'org2' }, orgActor))
      .rejects.toMatchObject({ code: 'INVALID_CONTRACT_TEMPLATE', status: 422 });
    // The header update must never have fired — the reassignment rolls back.
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls.every((call) => !(call[0] as { orgId?: string }).orgId || (call[0] as { orgId?: string }).orgId !== 'org2')).toBe(true);
  });

  it('updateQuote allows reassignment carrying a PARTNER-WIDE contract block (org_id NULL passes)', async () => {
    const orgActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1', 'org2'] };
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD', siteId: null, billToName: null, taxRate: null, depositType: 'none', depositPercent: null }]); // loadDraft
    queueResult([{ id: 'org2', currencyCode: 'USD' }]); // membership check (currency matches the draft stamp)
    queueResult([{ taxExempt: false, taxRate: null }]); // resolveQuoteTaxRate org
    queueResult([{ defaultTaxRate: null }]); // resolveQuoteTaxRate partner
    queueResult([{ blockType: 'contract', content: { templateId: 'tpl-1', templateVersionId: 'ver-1' } }]); // contract-blocks fetch
    queueResult([]); // SET CONSTRAINTS
    queueResult([{ currencyCode: 'USD' }]); // org SHARE barrier inside the move tx (#3778)
    queueResult([{ templateId: 'tpl-1', status: 'published' }]); // version published
    queueResult([{ status: 'active', orgId: null, partnerId: 'p1' }]); // PARTNER-WIDE — visible to every org of the partner
    queueResult([]); // tx: quotes header update
    queueResult([]); // tx: blocks org move
    queueResult([]); // tx: scoped lines clear + org move
    queueResult([]); // tx: remaining lines org move
    queueResult([]); // tx: images org move
    queueResult([]); // tx: unscoped descriptor lines
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update
    queueResult([{ id: 'q1', orgId: 'org2' }]); // final re-select

    const updated = await svc.updateQuote('q1', { orgId: 'org2' }, orgActor);
    expect(updated.orgId).toBe('org2');
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).toMatchObject({ orgId: 'org2' });
  });

  it('updateQuote throws DEPOSIT_REQUIRES_ONE_TIME_LINES when the quote has no one-time visible lines', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', taxRate: null, depositType: 'none', depositPercent: null }]);
    queueResult([]); // no lines at all — dueOnAcceptanceTotal is $0
    await expect(
      svc.updateQuote('q1', { depositType: 'percent', depositPercent: 10 }, actor)
    ).rejects.toMatchObject({ code: 'DEPOSIT_REQUIRES_ONE_TIME_LINES', status: 400 });
  });

  it('addCatalogLine on a hardware catalog item sets depositEligible true and itemType hardware', async () => {
    resolvePriceMock.mockResolvedValueOnce(resolvedUsd());
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD' }]); // loadDraft
    queueResult([{ // catalog item lookup
      name: 'Server', description: null, unitPrice: '500.00', taxable: true,
      billingType: 'one_time', billingFrequency: null, commitmentTermMonths: null,
      costBasis: '300.00', sku: 'SKU1', itemType: 'hardware',
    }]);
    queueResult([{ id: 'blk1' }]); // resolveLineBlockId: existing line_items block
    queueResult([{ max: -1 }]); // nextLineSortOrder
    queueResult([{ id: 'l1', depositEligible: true, itemType: 'hardware' }]); // insert returning
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute's own update (unused result)

    await svc.addCatalogLine('q1', 'cat1', 1, undefined, actor);

    const valuesMock = (db as unknown as Chain).values;
    // Price/cost come from the resolver ('42.00'/'30.00'), NOT the item row's
    // unit_price ('500.00') / cost_basis ('300.00').
    expect(valuesMock.mock.calls.at(-1)![0]).toMatchObject({
      depositEligible: true, itemType: 'hardware', unitPrice: '42.00', lineTotal: '42.00', unitCost: '30.00', taxable: true,
    });
    expect(resolvePriceMock).toHaveBeenCalledWith(
      'cat1', 'USD', 'org1', expect.objectContaining({ partnerId: 'p1', userId: 'u1', accessibleOrgIds: ['org1'] }), expect.anything()
    );
  });

  it('addCatalogLine on a service catalog item sets depositEligible false and itemType service', async () => {
    // Cost in another currency than the quote: margin unavailable → unitCost null.
    resolvePriceMock.mockResolvedValueOnce(resolvedUsd({
      unitPrice: '42.00', currencyCode: 'EUR', costBasis: '30.00', costCurrency: 'USD', marginAvailable: false, taxable: false,
    }));
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'EUR' }]); // loadDraft
    queueResult([{ // catalog item lookup
      name: 'Onboarding', description: null, unitPrice: '250.00', taxable: false,
      billingType: 'one_time', billingFrequency: null, commitmentTermMonths: null,
      costBasis: null, sku: null, itemType: 'service',
    }]);
    queueResult([{ id: 'blk1' }]); // resolveLineBlockId: existing line_items block
    queueResult([{ max: -1 }]); // nextLineSortOrder
    queueResult([{ id: 'l2', depositEligible: false, itemType: 'service' }]); // insert returning
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute's own update (unused result)

    await svc.addCatalogLine('q1', 'cat2', 2, undefined, actor);

    const valuesMock = (db as unknown as Chain).values;
    expect(valuesMock.mock.calls.at(-1)![0]).toMatchObject({
      depositEligible: false, itemType: 'service', unitPrice: '42.00', lineTotal: '84.00', unitCost: null, taxable: false,
    });
    expect(resolvePriceMock).toHaveBeenCalledWith(
      'cat2', 'EUR', 'org1', expect.objectContaining({ partnerId: 'p1' }), expect.anything()
    );
  });

  it('addCatalogLine maps a price-book gap to QuoteServiceError NO_PRICE_FOR_CURRENCY (409) and inserts nothing', async () => {
    resolvePriceMock.mockRejectedValueOnce(new CatalogServiceError('No price for "Onboarding" in EUR', 409, 'NO_PRICE_FOR_CURRENCY'));
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'EUR' }]); // loadDraft
    queueResult([{ // catalog item lookup
      name: 'Onboarding', description: null, unitPrice: '250.00', taxable: false,
      billingType: 'one_time', billingFrequency: null, commitmentTermMonths: null,
      costBasis: null, sku: null, itemType: 'service',
    }]);

    await expect(svc.addCatalogLine('q1', 'cat2', 1, undefined, actor))
      .rejects.toMatchObject({ name: 'QuoteServiceError', code: 'NO_PRICE_FOR_CURRENCY', status: 409 });
    expect((db as unknown as Chain).values).not.toHaveBeenCalled();
  });

  it('addCatalogLine rethrows non-gap CatalogServiceErrors unchanged', async () => {
    resolvePriceMock.mockRejectedValueOnce(new CatalogServiceError('denied', 403, 'ORG_DENIED'));
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD' }]); // loadDraft
    queueResult([{ name: 'X', unitPrice: '1.00', taxable: true, billingType: 'one_time', itemType: 'service' }]);

    await expect(svc.addCatalogLine('q1', 'cat2', 1, undefined, actor))
      .rejects.toMatchObject({ name: 'CatalogServiceError', code: 'ORG_DENIED', status: 403 });
  });

  it('addManualLine without a blockId attaches to the existing pricing section (no orphan)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ id: 'blk1' }]); // resolveLineBlockId: existing line_items block
    queueResult([{ max: -1 }]); // nextLineSortOrder
    queueResult([{ id: 'l1', blockId: 'blk1' }]); // insert line returning
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update

    await svc.addManualLine('q1', { sourceType: 'manual', name: 'Widget', quantity: 2, unitPrice: 100, taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false } as never, actor);

    const valuesMock = (db as unknown as Chain).values;
    // No new block created; the line lands in the existing section, not as an orphan.
    expect(valuesMock.mock.calls.every((c) => (c[0] as { blockType?: string }).blockType !== 'line_items')).toBe(true);
    expect((valuesMock.mock.calls.at(-1)![0] as { blockId?: string }).blockId).toBe('blk1');
  });

  it('addManualLine without a blockId creates a default pricing section when none exists', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([]); // resolveLineBlockId: no existing line_items block
    queueResult([{ max: -1 }]); // nextBlockSortOrder
    queueResult([{ id: 'newblk' }]); // block insert returning
    queueResult([{ max: -1 }]); // nextLineSortOrder
    queueResult([{ id: 'l1', blockId: 'newblk' }]); // insert line returning
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update

    await svc.addManualLine('q1', { sourceType: 'manual', name: 'Widget', quantity: 1, unitPrice: 50, taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false } as never, actor);

    const valuesMock = (db as unknown as Chain).values;
    // A default line_items block was created…
    expect(valuesMock.mock.calls.some((c) => (c[0] as { blockType?: string }).blockType === 'line_items')).toBe(true);
    // …and the line attached to it (never orphaned with a null blockId).
    expect((valuesMock.mock.calls.at(-1)![0] as { blockId?: string }).blockId).toBe('newblk');
  });

  // -------------------------------------------------------------------------
  // cloneQuote orphan re-parenting: a source line with block_id NULL (or one
  // whose block failed to map) must NEVER be copied into the clone as another
  // orphan — it lands in the clone's default pricing section instead.
  // -------------------------------------------------------------------------

  /** Queue every read cloneQuote issues before its transaction. */
  function queueCloneReads(blocks: unknown[], lines: unknown[]) {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', taxRate: null, depositType: 'none', depositPercent: null, billToName: null, billToAddress: null, billToTaxId: null }]); // getQuote: quote
    queueResult(blocks); // getQuote: blocks
    queueResult(lines.map((line) => ({ line, deviceGroup: null, site: null }))); // getQuote: joined lines
    queueResult([]); // getQuote: no staged Pax8 order
    queueResult([]); // getQuote: no successor revision
    queueResult([]); // getQuote: listQuoteOrders — order headers
    queueResult([]); // getQuote: listQuoteOrders — order lines
    queueResult([{ name: 'Org Inc' }]); // getQuote: draft bill-to org lookup
    queueResult([]); // cloneQuote: quote images
    queueResult([{ counter: 2 }]); // allocateQuoteCounter
    queueResult([{ id: 'q2', orgId: 'org1' }]); // tx: quotes insert returning
  }

  const cloneLine = (over: Record<string, unknown>) => ({
    id: 'lx', blockId: null, parentLineId: null, sourceType: 'manual', catalogItemId: null,
    name: 'Widget', description: null, quantity: '1', unitPrice: '100.00', taxable: false,
    customerVisible: true, lineTotal: '100.00', recurrence: 'one_time', termMonths: null,
    billingFrequency: null, unitCost: null, depositEligible: false, itemType: null,
    sku: null, partNumber: null, imageId: null, sortOrder: 0, ...over,
  });

  /** The array passed to `.values()` for a given insert (quote insert passes an object). */
  function insertedArrays() {
    const valuesMock = (db as unknown as Chain).values;
    return valuesMock.mock.calls.map((c) => c[0]).filter(Array.isArray) as Record<string, unknown>[][];
  }

  it('cloneQuote re-parents a source orphan line onto the cloned default pricing section', async () => {
    queueCloneReads(
      [{ id: 'b1', blockType: 'line_items', content: {}, sortOrder: 0 }],
      [cloneLine({ id: 'l1', blockId: null }), cloneLine({ id: 'l2', blockId: 'b1', sortOrder: 1 })],
    );
    queueResult([]); // tx: blocks insert
    queueResult([]); // tx: lines insert

    await svc.cloneQuote('q1', actor);

    const [clonedBlocks, clonedLines] = insertedArrays();
    // Exactly the one source block was cloned — no extra section spawned.
    expect(clonedBlocks).toHaveLength(1);
    const defaultBlockId = clonedBlocks![0]!.id;
    // The orphan lands in the cloned pricing section; the mapped line is untouched.
    expect(clonedLines!.every((l) => l.blockId === defaultBlockId)).toBe(true);
    expect(clonedLines!.every((l) => l.blockId != null)).toBe(true);
  });

  it('cloneQuote creates ONE fallback pricing section for multiple orphans when the source has none', async () => {
    queueCloneReads(
      [{ id: 'b1', blockType: 'heading', content: { text: 'Intro', level: 2 }, sortOrder: 0 }],
      [
        cloneLine({ id: 'l1', blockId: null }),
        cloneLine({ id: 'l2', blockId: null, sortOrder: 1 }),
        // A line pointing at a block that never mapped is an orphan too — it used
        // to be silently nulled by the `?? null` fallback.
        cloneLine({ id: 'l3', blockId: 'missing-block', sortOrder: 2 }),
      ],
    );
    queueResult([]); // tx: blocks insert
    queueResult([]); // tx: lines insert

    await svc.cloneQuote('q1', actor);

    const [clonedBlocks, clonedLines] = insertedArrays();
    const lineItemBlocks = clonedBlocks!.filter((b) => b.blockType === 'line_items');
    // ONE fallback section shared by all three orphans — not one per line.
    expect(lineItemBlocks).toHaveLength(1);
    const fallbackId = lineItemBlocks[0]!.id;
    expect(clonedLines!.map((l) => l.blockId)).toEqual([fallbackId, fallbackId, fallbackId]);
  });

  it('cloneQuote does not create a fallback section when no line is orphaned', async () => {
    queueCloneReads(
      [{ id: 'b1', blockType: 'line_items', content: {}, sortOrder: 0 }],
      [cloneLine({ id: 'l1', blockId: 'b1' })],
    );
    queueResult([]); // tx: blocks insert
    queueResult([]); // tx: lines insert

    await svc.cloneQuote('q1', actor);

    const [clonedBlocks] = insertedArrays();
    expect(clonedBlocks).toHaveLength(1); // only the source block's clone
  });

  it('getQuote returns orders with their allocations grouped by order (Task 11)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', taxRate: null, depositType: 'none', depositPercent: null }]); // quote
    queueResult([]); // blocks
    queueResult([]); // lines
    queueResult([]); // no staged Pax8 order
    queueResult([]); // no successor revision
    queueResult([
      { id: 'ord-1', quoteId: 'q1', orgId: 'org1', clientRequestId: 'c1' },
      { id: 'ord-2', quoteId: 'q1', orgId: 'org1', clientRequestId: 'c2' },
    ]); // listQuoteOrders: order headers
    queueResult([
      { id: 'ol-1', orderId: 'ord-1', quoteId: 'q1', quoteLineId: 'ql-1', orderedQty: '2.00', receivedQty: '0.00' },
      { id: 'ol-2', orderId: 'ord-2', quoteId: 'q1', quoteLineId: 'ql-2', orderedQty: '1.00', receivedQty: '1.00' },
    ]); // listQuoteOrders: order lines (both orders, one line each)

    const detail = await svc.getQuote('q1', actor);

    expect(detail.orders).toHaveLength(2);
    const ord1 = detail.orders.find((o: { id: string }) => o.id === 'ord-1')!;
    const ord2 = detail.orders.find((o: { id: string }) => o.id === 'ord-2')!;
    expect((ord1 as { lines: unknown[] }).lines).toEqual([
      { id: 'ol-1', orderId: 'ord-1', quoteId: 'q1', quoteLineId: 'ql-1', orderedQty: '2.00', receivedQty: '0.00' },
    ]);
    expect((ord2 as { lines: unknown[] }).lines).toEqual([
      { id: 'ol-2', orderId: 'ord-2', quoteId: 'q1', quoteLineId: 'ql-2', orderedQty: '1.00', receivedQty: '1.00' },
    ]);
  });

  it('getQuote returns depositDueTotal and categoryBreakdown', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', taxRate: '0.10000', depositType: 'percent', depositPercent: '30.00' }]); // quote
    queueResult([]); // blocks
    queueResult([{
      line: { quantity: '1', unitPrice: '1000.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false, itemType: 'hardware' },
      deviceGroup: null,
      site: null,
    }]); // lines
    queueResult([]); // no staged Pax8 order
    queueResult([]); // no successor revision
    queueResult([]); // listQuoteOrders — order headers
    queueResult([]); // listQuoteOrders — order lines

    const { quote } = await svc.getQuote('q1', actor);

    expect(quote.depositDueTotal).toBe('330.00');
    expect(quote.categoryBreakdown).toEqual([
      { category: 'hardware', oneTimeTotal: '1000.00', monthlyTotal: '0.00', annualTotal: '0.00' },
    ]);
  });

  it('getQuote returns the persisted staged Pax8 order summary for reloads', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', taxRate: null, depositType: 'none', depositPercent: null }]);
    queueResult([]); // blocks
    queueResult([]); // quote lines
    queueResult([{ pax8OrderId: 'order-1', status: 'awaiting_details' }]);
    queueResult([
      { sourceQuoteLineId: 'ql-1', submitState: 'pending', quantity: '1.00' },
      { sourceQuoteLineId: 'ql-2', submitState: 'pending', quantity: '2.00' },
    ]);
    queueResult([]); // no successor revision
    queueResult([]); // listQuoteOrders — order headers
    queueResult([]); // listQuoteOrders — order lines

    const detail = await svc.getQuote('q1', actor);

    expect(detail.pax8OrderId).toBe('order-1');
    expect(detail.pax8OrderLineCount).toBe(2);
    expect(detail.pax8Order).toEqual({
      id: 'order-1',
      status: 'awaiting_details',
      lines: [
        { sourceQuoteLineId: 'ql-1', submitState: 'pending', quantity: '1.00' },
        { sourceQuoteLineId: 'ql-2', submitState: 'pending', quantity: '2.00' },
      ],
    });
  });

  it('getQuote returns a null staged-order summary when acceptance staged no Pax8 order', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', taxRate: null, depositType: 'none', depositPercent: null }]);
    queueResult([]); // blocks
    queueResult([]); // quote lines
    queueResult([]); // no Pax8 order for this quote/tenant
    queueResult([]); // no successor revision
    queueResult([]); // listQuoteOrders — order headers
    queueResult([]); // listQuoteOrders — order lines

    const detail = await svc.getQuote('q1', actor);

    expect(detail.pax8OrderId).toBeNull();
    expect(detail.pax8OrderLineCount).toBe(0);
    expect(detail.pax8Order).toBeNull();
  });

  it('getQuote returns a SENT quote bill-to from the frozen snapshot, never the live org', async () => {
    // Frozen at send when the org had no address → an all-null block. That blank is
    // the immutable record; getQuote must NOT re-derive from the (now-populated) org.
    const frozen = { line1: null, line2: null, city: null, region: null, postalCode: null, country: null };
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent', billToName: 'Frozen Co', billToAddress: frozen, billToTaxId: null, taxRate: null, depositType: 'none', depositPercent: null }]); // quote
    queueResult([]); // blocks
    queueResult([]); // lines
    queueResult([]); // no staged Pax8 order
    queueResult([]); // no successor revision
    queueResult([]); // listQuoteOrders — order headers
    queueResult([]); // listQuoteOrders — order lines
    // Deliberately queue NO org row: a sent quote must not query the live org at all.

    const { billTo } = await svc.getQuote('q1', actor);
    expect(billTo.name).toBe('Frozen Co');
    expect(billTo.address).toEqual(frozen); // the all-null frozen block, not re-derived
    expect(billTo.taxId).toBeNull();
  });

  it('getQuote resolves a DRAFT quote bill-to from the org billing settings', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', billToName: null, billToAddress: null, billToTaxId: null, taxRate: null, depositType: 'none', depositPercent: null }]); // quote
    queueResult([]); // blocks
    queueResult([]); // lines
    queueResult([]); // no staged Pax8 order
    queueResult([]); // no successor revision
    queueResult([]); // listQuoteOrders — order headers
    queueResult([]); // listQuoteOrders — order lines
    queueResult([{ name: 'Org Inc', taxId: 'ORG-TAX', billingAddressLine1: 'Org St', billingAddressLine2: null, billingAddressCity: 'Berthoud', billingAddressRegion: 'CO', billingAddressPostalCode: '80513', billingAddressCountry: 'US' }]); // org billing

    const { billTo } = await svc.getQuote('q1', actor);
    expect(billTo.name).toBe('Org Inc');
    expect(billTo.address?.line1).toBe('Org St');
    expect(billTo.taxId).toBe('ORG-TAX');
  });

  it('addBlock sanitizes a rich_text block\'s content.html before insert (script tag stripped)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ max: -1 }]); // nextBlockSortOrder
    queueResult([{ id: 'blk1', blockType: 'rich_text', content: { html: '<p>Hello</p>' } }]); // insert returning

    await svc.addBlock('q1', { blockType: 'rich_text', content: { html: '<p>Hello</p><script>alert(1)</script>' } }, actor);

    const valuesMock = (db as unknown as Chain).values;
    const inserted = valuesMock.mock.calls.at(-1)![0] as { content: { html: string } };
    expect(inserted.content.html).toBe('<p>Hello</p>');
    expect(inserted.content.html).not.toContain('script');
  });

  it('addBlock hands back the tags it stripped instead of a silent 200 (#3520)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ max: -1 }]); // nextBlockSortOrder
    queueResult([{ id: 'blk1', blockType: 'rich_text', content: { html: '<p>Hello</p>' } }]); // insert returning

    const row = await svc.addBlock('q1', { blockType: 'rich_text', content: { html: '<p>Hello</p><blockquote>gone</blockquote>' } }, actor);

    expect(row.id).toBe('blk1'); // the block still saves — warning, not rejection
    expect(row.warnings).toEqual([
      { code: 'UNSUPPORTED_HTML_TAGS_REMOVED', field: 'content.html', removedTags: ['blockquote'] },
    ]);
  });

  it('addBlock returns an empty warnings array when nothing was stripped (#3520)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ max: -1 }]); // nextBlockSortOrder
    queueResult([{ id: 'blk1', blockType: 'rich_text', content: { html: '<p>Hello</p>' } }]); // insert returning

    const row = await svc.addBlock('q1', { blockType: 'rich_text', content: { html: '<p>Hello</p>' } }, actor);

    expect(row.warnings).toEqual([]);
  });

  it('updateBlock hands back the tags it stripped (#3520)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ blockType: 'rich_text' }]); // existing block type check
    queueResult([{ id: 'blk1', blockType: 'rich_text', content: { html: '<p>Updated</p>' } }]); // update returning

    const row = await svc.updateBlock('q1', 'blk1', { blockType: 'rich_text', content: { html: '<p>Updated</p><pre>x</pre>' } }, actor);

    expect(row.warnings).toEqual([
      { code: 'UNSUPPORTED_HTML_TAGS_REMOVED', field: 'content.html', removedTags: ['pre'] },
    ]);
  });

  it('addBlock leaves non-rich_text block content untouched', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ max: -1 }]); // nextBlockSortOrder
    queueResult([{ id: 'blk1', blockType: 'heading', content: { text: 'Intro', level: 2 } }]); // insert returning

    await svc.addBlock('q1', { blockType: 'heading', content: { text: 'Intro', level: 2 } }, actor);

    const valuesMock = (db as unknown as Chain).values;
    const inserted = valuesMock.mock.calls.at(-1)![0] as { content: { text: string; level: number } };
    expect(inserted.content).toEqual({ text: 'Intro', level: 2 });
  });

  it('updateBlock sanitizes a rich_text block\'s content.html before update (script tag stripped)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ blockType: 'rich_text' }]); // existing block type check
    queueResult([{ id: 'blk1', blockType: 'rich_text', content: { html: '<p>Updated</p>' } }]); // update returning

    await svc.updateBlock('q1', 'blk1', { blockType: 'rich_text', content: { html: '<p>Updated</p><script>alert(2)</script>' } }, actor);

    const setMock = (db as unknown as Chain).set;
    const updated = setMock.mock.calls.at(-1)![0] as { content: { html: string } };
    expect(updated.content.html).toBe('<p>Updated</p>');
    expect(updated.content.html).not.toContain('script');
  });

  it('getQuote sanitizes a legacy dirty rich_text block on read (defense in depth for pre-sanitizer rows)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', taxRate: null, depositType: 'none', depositPercent: null }]); // quote
    queueResult([
      { id: 'blk1', quoteId: 'q1', orgId: 'org1', blockType: 'rich_text', content: { html: '<p>Legacy</p><script>alert(3)</script>' }, sortOrder: 0 },
      { id: 'blk2', quoteId: 'q1', orgId: 'org1', blockType: 'heading', content: { text: 'Title', level: 2 }, sortOrder: 1 },
    ]); // blocks (one legacy dirty row, one unrelated block type)
    queueResult([]); // quote lines
    queueResult([]); // no staged Pax8 order
    queueResult([]); // no successor revision
    queueResult([]); // listQuoteOrders — order headers
    queueResult([]); // listQuoteOrders — order lines

    const { blocks } = await svc.getQuote('q1', actor);

    const richBlock = blocks.find((b) => b.id === 'blk1') as { content: { html: string } };
    expect(richBlock.content.html).toBe('<p>Legacy</p>');
    expect(richBlock.content.html).not.toContain('script');
    const headingBlock = blocks.find((b) => b.id === 'blk2') as { content: { text: string } };
    expect(headingBlock.content).toEqual({ text: 'Title', level: 2 }); // untouched
  });

  it('listQuotes left-joins the converted invoice and flattens invoiceDepositDue/invoiceAmountPaid onto each row', async () => {
    // The chain mock yields queued rows regardless of shape; queue the joined
    // projection shape the real select({ quote, invoiceDepositDue, invoiceAmountPaid }) returns.
    queueResult([
      { quote: { id: 'q1', orgId: 'org1', status: 'converted', depositType: 'percent' }, invoiceDepositDue: '300.00', invoiceAmountPaid: '300.00' },
      { quote: { id: 'q2', orgId: 'org1', status: 'draft', depositType: 'none' }, invoiceDepositDue: null, invoiceAmountPaid: null },
    ]);

    const rows = await svc.listQuotes({ limit: 50 }, actor);

    expect(rows).toEqual([
      { id: 'q1', orgId: 'org1', status: 'converted', depositType: 'percent', invoiceDepositDue: '300.00', invoiceAmountPaid: '300.00' },
      { id: 'q2', orgId: 'org1', status: 'draft', depositType: 'none', invoiceDepositDue: null, invoiceAmountPaid: null },
    ]);
  });

  // -------------------------------------------------------------------------
  // Contract blocks (Task 11): addBlock/updateBlock validate the referenced
  // template version BEFORE insert — exists, belongs to the named template,
  // status='published', template not archived, template visible to the
  // quote's org/partner. Any violation is a single 422 INVALID_CONTRACT_TEMPLATE.
  // -------------------------------------------------------------------------
  const contractContent = { templateId: 'tpl1', templateVersionId: 'ver1', variableValues: {} };

  it('addBlock rejects a contract block whose template version is a draft (not published)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ templateId: 'tpl1', status: 'draft' }]); // version lookup

    await expect(
      svc.addBlock('q1', { blockType: 'contract', content: contractContent } as never, actor)
    ).rejects.toMatchObject({ code: 'INVALID_CONTRACT_TEMPLATE', status: 422 });
  });

  it('addBlock rejects a contract block whose template is archived', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ templateId: 'tpl1', status: 'published' }]); // version lookup
    queueResult([{ status: 'archived', orgId: 'org1', partnerId: null }]); // template lookup

    await expect(
      svc.addBlock('q1', { blockType: 'contract', content: contractContent } as never, actor)
    ).rejects.toMatchObject({ code: 'INVALID_CONTRACT_TEMPLATE', status: 422 });
  });

  it('addBlock rejects a partner-wide contract template belonging to a different partner', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ templateId: 'tpl1', status: 'published' }]); // version lookup
    queueResult([{ status: 'active', orgId: null, partnerId: 'p2' }]); // template owned by another partner

    await expect(
      svc.addBlock('q1', { blockType: 'contract', content: contractContent } as never, actor)
    ).rejects.toMatchObject({ code: 'INVALID_CONTRACT_TEMPLATE', status: 422 });
  });

  it('addBlock rejects an org-owned contract template belonging to a different org', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ templateId: 'tpl1', status: 'published' }]); // version lookup
    queueResult([{ status: 'active', orgId: 'org2', partnerId: null }]); // template owned by another org

    await expect(
      svc.addBlock('q1', { blockType: 'contract', content: contractContent } as never, actor)
    ).rejects.toMatchObject({ code: 'INVALID_CONTRACT_TEMPLATE', status: 422 });
  });

  it('addBlock accepts a contract block whose template version is published and visible to the quote org', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ templateId: 'tpl1', status: 'published' }]); // version lookup
    queueResult([{ status: 'active', orgId: 'org1', partnerId: null }]); // template lookup — same org
    queueResult([{ max: -1 }]); // nextBlockSortOrder
    queueResult([{ id: 'blk1', blockType: 'contract', content: contractContent }]); // insert returning

    const row = await svc.addBlock('q1', { blockType: 'contract', content: contractContent } as never, actor);
    expect(row).toMatchObject({ id: 'blk1', blockType: 'contract' });

    const valuesMock = (db as unknown as Chain).values;
    expect(valuesMock.mock.calls.at(-1)![0]).toMatchObject({ blockType: 'contract', content: contractContent });
  });

  it('updateBlock rejects a contract block update whose template version is a draft', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
    queueResult([{ blockType: 'contract' }]); // existing block type check
    queueResult([{ templateId: 'tpl1', status: 'draft' }]); // version lookup

    await expect(
      svc.updateBlock('q1', 'blk1', { blockType: 'contract', content: contractContent } as never, actor)
    ).rejects.toMatchObject({ code: 'INVALID_CONTRACT_TEMPLATE', status: 422 });
  });

  // -------------------------------------------------------------------------
  // Cover page (Task 11): updateQuote persists `coverPage`; a set `coverImageId`
  // must reference a quote_images row on the SAME quote (mirrors the line
  // imageId ownership check).
  // -------------------------------------------------------------------------
  it('updateQuote persists a coverPage patch verbatim', async () => {
    const coverPage = { enabled: true, title: 'Cover', coverImageId: null, preparedForName: 'Jane', showPreparedBy: true };
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', taxRate: null, depositType: 'none', depositPercent: null }]); // loadDraft
    queueResult([]); // updateQuote's own header update
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update
    queueResult([{ id: 'q1', orgId: 'org1', coverPage }]); // final re-select

    const updated = await svc.updateQuote('q1', { coverPage } as never, actor);
    expect(updated.coverPage).toEqual(coverPage);

    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).toMatchObject({ coverPage });
  });

  it('updateQuote rejects a coverPage.coverImageId that is not a quote_images row on this quote', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', taxRate: null, depositType: 'none', depositPercent: null }]); // loadDraft
    queueResult([]); // image ownership check — no row found

    await expect(
      svc.updateQuote('q1', { coverPage: { enabled: true, coverImageId: 'img-other', showPreparedBy: true } } as never, actor)
    ).rejects.toMatchObject({ code: 'IMAGE_NOT_FOUND', status: 404 });
  });

  it('updateQuote accepts a coverPage.coverImageId that IS a quote_images row on this quote', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', taxRate: null, depositType: 'none', depositPercent: null }]); // loadDraft
    queueResult([{ id: 'img1' }]); // image ownership check — found
    queueResult([]); // updateQuote's own header update
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update
    queueResult([{ id: 'q1', orgId: 'org1', coverPage: { enabled: true, coverImageId: 'img1', showPreparedBy: true } }]); // final re-select

    const updated = await svc.updateQuote(
      'q1', { coverPage: { enabled: true, coverImageId: 'img1', showPreparedBy: true } } as never, actor
    );
    expect(updated.coverPage).toMatchObject({ coverImageId: 'img1' });
  });
});

describe('attachCustomerLineImages', () => {
  const base = { id: 'l1', description: 'Widget', quantity: '1', unitPrice: '10', lineTotal: '10' };
  const buildPath = (lineId: string) => `/quotes/public/tok/line-image/${lineId}`;

  it('builds a quote-scoped imageUrl for a line with an uploaded image and drops the raw ids', () => {
    const line = svc.attachCustomerLineImages(
      [{ ...base, imageId: 'img1', catalogItemId: null }],
      buildPath,
    )[0]!;
    expect(line.imageUrl).toBe('/quotes/public/tok/line-image/l1');
    expect(line).not.toHaveProperty('imageId');
    expect(line).not.toHaveProperty('catalogItemId');
    expect(line.description).toBe('Widget'); // other fields preserved
  });

  it('builds an imageUrl for a catalog-sourced line (no uploaded image)', () => {
    const line = svc.attachCustomerLineImages(
      [{ ...base, imageId: null, catalogItemId: 'cat1' }],
      buildPath,
    )[0]!;
    expect(line.imageUrl).toBe('/quotes/public/tok/line-image/l1');
  });

  it('emits null imageUrl for a line with neither an uploaded nor a catalog image', () => {
    const line = svc.attachCustomerLineImages(
      [{ ...base, imageId: null, catalogItemId: null }],
      buildPath,
    )[0]!;
    expect(line.imageUrl).toBeNull();
  });
});

describe('structured block sanitization', () => {
  it('sanitizes every table cell and label on write', () => {
    const { content } = svc.sanitizeBlockContentForWrite({ blockType: 'table', content: { columns: [{ label: '<p>Item</p>' }], rows: [{ cells: ['<script>x</script><strong>ok</strong>'] }] } } as never);
    const out = content as never as { columns: { label: string }[]; rows: { cells: string[] }[] };
    expect(out.columns[0]!.label).toBe('Item');
    expect(out.rows[0]!.cells[0]).toBe('<strong>ok</strong>');
  });
  it('sanitizes callout html with the block profile and drops out-of-contract shapes on read', () => {
    const rows = svc.sanitizeQuoteBlocksForRead([
      { blockType: 'table', content: { rows: 'garbage' } } as { blockType: string; content: unknown },
    ]);
    expect(rows[0]!.content).toEqual({ columns: [], rows: [] }); // canonical empty, never raw garbage
  });
});

// Issue #3520: a lossy write used to answer a clean 200. sanitizeBlockContentForWrite
// now reports what it removed so the route can hand the author a `warnings` array.
describe('sanitizeBlockContentForWrite loss reporting (#3520)', () => {
  it('reports the disallowed tags a rich_text write dropped', () => {
    const { content, warnings } = svc.sanitizeBlockContentForWrite({
      blockType: 'rich_text',
      content: { html: '<p>Keep</p><blockquote>Quote</blockquote><pre>Cell</pre>' },
    } as never);
    expect((content as { html: string }).html).not.toContain('<pre');
    expect(warnings).toEqual([
      { code: 'UNSUPPORTED_HTML_TAGS_REMOVED', field: 'content.html', removedTags: ['blockquote', 'pre'] },
    ]);
  });

  // Issue #3484: the write path must actually STORE the table, not just stop
  // warning about it — this is the only coverage that a quote block write
  // preserves table structure end to end.
  it('stores a rich_text table intact and warns about nothing', () => {
    const { content, warnings } = svc.sanitizeBlockContentForWrite({
      blockType: 'rich_text',
      content: { html: '<table><thead><tr><th>Item</th></tr></thead><tbody><tr><td>Setup</td></tr></tbody></table>' },
    } as never);
    expect((content as { html: string }).html)
      .toBe('<table><thead><tr><th>Item</th></tr></thead><tbody><tr><td>Setup</td></tr></tbody></table>');
    expect(warnings).toEqual([]);
  });

  it('warns when a table CELL had block content flattened, and still stores the table', () => {
    const { content, warnings } = svc.sanitizeBlockContentForWrite({
      blockType: 'rich_text',
      content: { html: '<table><tr><td><p>a</p><p>b</p></td></tr></table>' },
    } as never);
    expect((content as { html: string }).html).toBe('<table><tr><td>a<br />b</td></tr></table>');
    expect(warnings).toEqual([
      { code: 'UNSUPPORTED_HTML_TAGS_REMOVED', field: 'content.html', removedTags: ['p'] },
    ]);
  });

  it('reports nothing when the submitted html is already inside the subset', () => {
    const { warnings } = svc.sanitizeBlockContentForWrite({
      blockType: 'rich_text',
      content: { html: '<p>Plain <strong>bold</strong> and a <a href="https://a.b">link</a></p>' },
    } as never);
    expect(warnings).toEqual([]);
  });

  it('does NOT warn about stripped attributes or a rejected href scheme — only removed tags', () => {
    const { warnings } = svc.sanitizeBlockContentForWrite({
      blockType: 'rich_text',
      content: { html: '<p style="color:red" class="x">hi</p><a href="javascript:alert(1)">x</a>' },
    } as never);
    expect(warnings).toEqual([]);
  });

  it('collapses a table block\'s per-cell losses into one warning per field family', () => {
    const { warnings } = svc.sanitizeBlockContentForWrite({
      blockType: 'table',
      content: {
        columns: [{ label: '<h3>A</h3>' }, { label: '<h3>B</h3>' }],
        rows: [{ cells: ['<p>one</p>', '<ul><li>two</li></ul>'] }, { cells: ['<p>three</p>', 'four'] }],
        caption: '<strong>Cap</strong>',
      },
    } as never);
    expect(warnings).toEqual([
      { code: 'UNSUPPORTED_HTML_TAGS_REMOVED', field: 'content.columns[].label', removedTags: ['h3'] },
      { code: 'UNSUPPORTED_HTML_TAGS_REMOVED', field: 'content.rows[].cells[]', removedTags: ['li', 'p', 'ul'] },
      { code: 'UNSUPPORTED_HTML_TAGS_REMOVED', field: 'content.caption', removedTags: ['strong'] },
    ]);
  });

  it('reports callout html and title losses on their own fields', () => {
    const { warnings } = svc.sanitizeBlockContentForWrite({
      blockType: 'callout',
      content: { variant: 'info', html: '<h1>Big</h1>', title: '<em>T</em>' },
    } as never);
    expect(warnings).toEqual([
      { code: 'UNSUPPORTED_HTML_TAGS_REMOVED', field: 'content.html', removedTags: ['h1'] },
      { code: 'UNSUPPORTED_HTML_TAGS_REMOVED', field: 'content.title', removedTags: ['em'] },
    ]);
  });

  it('reports nothing for a block type that carries no rich text', () => {
    const { warnings } = svc.sanitizeBlockContentForWrite({
      blockType: 'heading',
      content: { text: 'Intro', level: 2 },
    } as never);
    expect(warnings).toEqual([]);
  });
});

describe('changeQuoteCurrency (draft currency immutability, #3774)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('rejects a non-draft quote with NOT_A_DRAFT (409)', async () => {
    queueResult([{ id: 'q1', status: 'sent', orgId: 'org1', partnerId: 'p1', siteId: null, currencyCode: 'USD' }]);
    await expect(
      svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', clearLines: false }, actor)
    ).rejects.toMatchObject({ code: 'NOT_A_DRAFT', status: 409 });
  });

  it('throws QUOTE_NOT_FOUND (404) when the quote is absent', async () => {
    queueResult([]);
    await expect(
      svc.changeQuoteCurrency('missing', { currencyCode: 'EUR', clearLines: false }, actor)
    ).rejects.toMatchObject({ code: 'QUOTE_NOT_FOUND', status: 404 });
  });

  it('refuses to restamp over monetary lines without clearLines (CURRENCY_LOCKED 409)', async () => {
    queueResult([{ id: 'q1', status: 'draft', orgId: 'org1', partnerId: 'p1', siteId: null, currencyCode: 'USD' }]);
    queueResult([{ id: 'l1' }]); // one monetary line
    await expect(
      svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', clearLines: false }, actor)
    ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409 });
    expect((db as unknown as { delete: { mock: { calls: unknown[][] } } }).delete.mock.calls.length).toBe(0);
  });

  it('restamps a line-less draft and returns the new currency', async () => {
    queueResult([{ id: 'q1', status: 'draft', orgId: 'org1', partnerId: 'p1', siteId: null, currencyCode: 'USD' }]);
    queueResult([]); // no lines
    queueResult([]); // no stamped overage price
    queueResult([]); // header currency update
    // recomputeAndPersist: header select, lines select, totals update
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null, currencyCode: 'EUR' }]);
    queueResult([]);
    queueResult([]);
    queueResult([{ id: 'q1', status: 'draft', orgId: 'org1', currencyCode: 'EUR' }]); // final re-select
    const updated = await svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', clearLines: false }, actor);
    expect(updated.currencyCode).toBe('EUR');
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).toMatchObject({ currencyCode: 'EUR' });
  });

  it('clearLines: true deletes the lines, restamps, and re-totals atomically', async () => {
    queueResult([{ id: 'q1', status: 'draft', orgId: 'org1', partnerId: 'p1', siteId: null, currencyCode: 'EUR' }]);
    queueResult([{ id: 'l1' }, { id: 'l2' }]); // two monetary lines
    // clearLines skips the stamped-overage lookup: the lines are deleted anyway.
    queueResult([]); // delete
    queueResult([]); // header currency update
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null, currencyCode: 'JPY' }]);
    queueResult([]); // recompute lines select (now empty)
    queueResult([]); // recompute totals update
    queueResult([{ id: 'q1', status: 'draft', orgId: 'org1', currencyCode: 'JPY', total: '0.00' }]);
    const updated = await svc.changeQuoteCurrency('q1', { currencyCode: 'JPY', clearLines: true }, actor);
    expect(updated.currencyCode).toBe('JPY');
    expect((db as unknown as { delete: { mock: { calls: unknown[][] } } }).delete.mock.calls.length).toBe(1);
  });

  // #3205 W05 (Task 7 review): the hand-entered overage lock must not block
  // clearLines — the stamped line is one of the lines being deleted.
  it('clearLines: true is not blocked by a stamped overage price (no CURRENCY_LOCKED)', async () => {
    queueResult([{ id: 'q1', status: 'draft', orgId: 'org1', partnerId: 'p1', siteId: null, currencyCode: 'EUR' }]);
    queueResult([{ id: 'l1' }]); // the line carrying overageUnitPrice
    queueResult([]); // delete
    queueResult([]); // header currency update
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null, currencyCode: 'USD' }]);
    queueResult([]); // recompute lines select (now empty)
    queueResult([]); // recompute totals update
    queueResult([{ id: 'q1', status: 'draft', orgId: 'org1', currencyCode: 'USD', total: '0.00' }]);
    const updated = await svc.changeQuoteCurrency('q1', { currencyCode: 'USD', clearLines: true }, actor);
    expect(updated.currencyCode).toBe('USD');
    expect((db as unknown as { delete: { mock: { calls: unknown[][] } } }).delete.mock.calls.length).toBe(1);
  });

  it('same-currency change is a no-op (returns the row untouched)', async () => {
    queueResult([{ id: 'q1', status: 'draft', orgId: 'org1', partnerId: 'p1', siteId: null, currencyCode: 'EUR' }]);
    const updated = await svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', clearLines: true }, actor);
    expect(updated.currencyCode).toBe('EUR');
    expect((db as unknown as { delete: { mock: { calls: unknown[][] } } }).delete.mock.calls.length).toBe(0);
  });

  it('denies an actor without access to the quote org (ORG_DENIED 403)', async () => {
    queueResult([{ id: 'q1', status: 'draft', orgId: 'org1', partnerId: 'p1', siteId: null, currencyCode: 'USD' }]);
    const denied = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['other-org'] };
    await expect(
      svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', clearLines: false }, denied)
    ).rejects.toMatchObject({ code: 'ORG_DENIED', status: 403 });
  });
});

describe('changeQuoteCurrency reprice (price-book reprice of catalog lines, #3775)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const draft = { id: 'q1', status: 'draft', orgId: 'org1', partnerId: 'p1', siteId: null, currencyCode: 'USD' };

  it('locks currency when any line has a stamped overage rate and proceeds after it is cleared', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', sourceType: 'catalog', catalogItemId: 'cat1', parentLineId: null, quantity: '2.00' }]);
    queueResult([{ id: 'l1' }]); // stamped overage price
    await expect(svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', reprice: true }, actor))
      .rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409 });
    expect(resolvePriceMock).not.toHaveBeenCalled();

    queueResult([draft]);
    queueResult([{ id: 'l1', sourceType: 'catalog', catalogItemId: 'cat1', parentLineId: null, quantity: '2.00' }]);
    queueResult([]); // overage price cleared
    resolvePriceMock.mockResolvedValueOnce(resolvedUsd({ unitPrice: '20.00', currencyCode: 'EUR', costBasis: '15.00', costCurrency: 'EUR' }));
    queueResult([]); // line reprice
    queueResult([]); // quote restamp
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null, currencyCode: 'EUR' }]);
    queueResult([{ quantity: '2.00', unitPrice: '20.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false, itemType: null }]);
    queueResult([]); // totals update
    queueResult([{ ...draft, currencyCode: 'EUR' }]);

    await expect(svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', reprice: true }, actor))
      .resolves.toMatchObject({ currencyCode: 'EUR' });
  });

  it('reprices a catalog line from the price book, restamps, and re-totals — no delete, no CURRENCY_LOCKED', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', sourceType: 'catalog', catalogItemId: 'cat1', parentLineId: null, quantity: '2.00' }]);
    queueResult([]); // no stamped overage price
    resolvePriceMock.mockResolvedValueOnce(resolvedUsd({ unitPrice: '20.00', currencyCode: 'EUR', costBasis: '15.00', costCurrency: 'EUR', marginAvailable: true }));
    queueResult([]); // line update
    queueResult([]); // header currency update
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null, currencyCode: 'EUR' }]); // recompute header select
    queueResult([{ quantity: '2.00', unitPrice: '20.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false, itemType: null }]);
    queueResult([]); // recompute totals update
    queueResult([{ id: 'q1', status: 'draft', orgId: 'org1', currencyCode: 'EUR', total: '40.00' }]);

    const updated = await svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', reprice: true }, actor);
    expect(updated.currencyCode).toBe('EUR');
    expect(resolvePriceMock).toHaveBeenCalledTimes(1);
    expect(resolvePriceMock).toHaveBeenCalledWith(
      'cat1', 'EUR', 'org1', { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] }, db
    );
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).toEqual({ unitPrice: '20.00', lineTotal: '40.00', unitCost: '15.00' });
    expect(setMock.mock.calls[1]![0]).toMatchObject({ currencyCode: 'EUR' });
    expect((db as unknown as { delete: { mock: { calls: unknown[][] } } }).delete.mock.calls.length).toBe(0);
  });

  it('nulls unitCost when the resolved cost is in another currency (margin unavailable)', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', sourceType: 'catalog', catalogItemId: 'cat1', parentLineId: null, quantity: '1.00' }]);
    queueResult([]); // no stamped overage price
    resolvePriceMock.mockResolvedValueOnce(resolvedUsd({ unitPrice: '20.00', currencyCode: 'EUR', costBasis: '15.00', costCurrency: 'USD', marginAvailable: false }));
    queueResult([]); queueResult([]);
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null, currencyCode: 'EUR' }]);
    queueResult([]); queueResult([]);
    queueResult([{ id: 'q1', status: 'draft', orgId: 'org1', currencyCode: 'EUR' }]);
    await svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', reprice: true }, actor);
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).toEqual({ unitPrice: '20.00', lineTotal: '20.00', unitCost: null });
  });

  it('refuses reprice when a non-catalog line exists (CURRENCY_LOCKED 409) without touching anything', async () => {
    queueResult([draft]);
    queueResult([
      { id: 'l1', sourceType: 'catalog', catalogItemId: 'cat1', parentLineId: null, quantity: '1.00' },
      { id: 'l2', sourceType: 'manual', catalogItemId: null, parentLineId: null, quantity: '1.00' },
    ]);
    await expect(
      svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', reprice: true }, actor)
    ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409, message: expect.stringContaining('1 non-catalog line(s) have no price in the new currency — remove all lines first, or keep the current currency') });
    expect(resolvePriceMock).not.toHaveBeenCalled();
    expect((db as unknown as Chain).set.mock.calls.length).toBe(0);
    expect((db as unknown as { delete: { mock: { calls: unknown[][] } } }).delete.mock.calls.length).toBe(0);
  });

  it('a price-book gap aborts the reprice as NO_PRICE_FOR_CURRENCY (409) — header never restamped', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', sourceType: 'catalog', catalogItemId: 'cat1', parentLineId: null, quantity: '1.00' }]);
    resolvePriceMock.mockRejectedValueOnce(new CatalogServiceError('No price for "Onboarding" in EUR', 409, 'NO_PRICE_FOR_CURRENCY'));
    await expect(
      svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', reprice: true }, actor)
    ).rejects.toMatchObject({ code: 'NO_PRICE_FOR_CURRENCY', status: 409, message: expect.stringContaining('Onboarding') });
    expect((db as unknown as Chain).set.mock.calls.length).toBe(0);
  });

  it('bundle lines are not repriceable (CURRENCY_LOCKED 409)', async () => {
    queueResult([draft]);
    queueResult([{ id: 'l1', sourceType: 'bundle', catalogItemId: 'bundle1', parentLineId: null, quantity: '1.00' }]);
    await expect(
      svc.changeQuoteCurrency('q1', { currencyCode: 'EUR', reprice: true }, actor)
    ).rejects.toMatchObject({ code: 'CURRENCY_LOCKED', status: 409 });
    expect(resolvePriceMock).not.toHaveBeenCalled();
  });
});

// #3774 phantom-line race: every quote LINE writer must take the quote row
// lock (SELECT ... FOR UPDATE) as the FIRST statement of a transaction, then
// mutate lines + recompute inside that same transaction — the same discipline
// changeQuoteCurrency uses, so a restamp can never interleave between a
// writer's currency read and its line write.
describe('quote line writers lock the quote row first (#3774)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  type LockChain = Chain & {
    for: { mock: { calls: unknown[][] } };
    transaction: { mock: { calls: unknown[][] } };
    delete: { mock: { calls: unknown[][] } };
  };

  it('addManualLine runs in a transaction and takes the quote row FOR UPDATE', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD' }]); // lockDraftQuote
    queueResult([{ id: 'blk1' }]); // resolveLineBlockId
    queueResult([{ max: -1 }]); // nextLineSortOrder
    queueResult([{ id: 'l1', blockId: 'blk1' }]); // insert returning
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update

    await svc.addManualLine('q1', { sourceType: 'manual', name: 'Widget', quantity: 1, unitPrice: 10, taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false } as never, actor);

    const chain = db as unknown as LockChain;
    expect(chain.transaction.mock.calls.length).toBe(1);
    expect(chain.for.mock.calls[0]).toEqual(['update']);
  });

  it('addManualLine computes lineTotal from the LOCKED row currency (JPY rounds to whole units)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'JPY' }]); // lockDraftQuote — restamped JPY
    queueResult([{ id: 'blk1' }]); // resolveLineBlockId
    queueResult([{ max: -1 }]); // nextLineSortOrder
    queueResult([{ id: 'l1' }]); // insert returning
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update

    // The fraction lives in the QUANTITY, not the unit price: a fractional-yen
    // unit price is now refused outright at this seam (W6-G2-1), so the rounding
    // contract has to be demonstrated with a JPY-representable price.
    await svc.addManualLine('q1', { sourceType: 'manual', name: 'Widget', quantity: 3.35, unitPrice: 30, taxable: false, customerVisible: true, recurrence: 'one_time', depositEligible: false } as never, actor);

    const valuesMock = (db as unknown as Chain).values;
    // 3.35 × 30 = 100.50 → half-up to '101.00' under JPY, '100.50' under a 2-decimal stamp.
    expect((valuesMock.mock.calls.at(-1)![0] as { lineTotal: string }).lineTotal).toBe('101.00');
  });

  it('updateLine locks first and recomputes lineTotal with the locked row currency', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'JPY' }]); // lockDraftQuote
    queueResult([{ id: 'l1', quoteId: 'q1', name: 'W', description: null, quantity: '3', unitPrice: '33.35', taxable: false, customerVisible: true, recurrence: 'one_time' }]); // existing line
    queueResult([]); // line update (unused result)
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update
    queueResult([{ id: 'l1', lineTotal: '100.00' }]); // final line re-select

    const updated = await svc.updateLine('q1', 'l1', { quantity: 3 }, actor);
    expect(updated.lineTotal).toBe('100.00');

    const chain = db as unknown as LockChain;
    expect(chain.transaction.mock.calls.length).toBe(1);
    expect(chain.for.mock.calls[0]).toEqual(['update']);
    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).toMatchObject({ lineTotal: '100.00' });
  });

  it('updateLine surfaces NOT_A_DRAFT off the locked row (no line write)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent', currencyCode: 'USD' }]); // lockDraftQuote → 409
    await expect(svc.updateLine('q1', 'l1', { quantity: 2 }, actor))
      .rejects.toMatchObject({ code: 'NOT_A_DRAFT', status: 409 });
    expect((db as unknown as Chain).set.mock.calls.length).toBe(0);
  });

  it('removeLine locks the quote row, deletes, and recomputes inside one transaction', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD' }]); // lockDraftQuote
    queueResult([]); // delete (unused result)
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update

    await svc.removeLine('q1', 'l1', actor);

    const chain = db as unknown as LockChain;
    expect(chain.transaction.mock.calls.length).toBe(1);
    expect(chain.for.mock.calls[0]).toEqual(['update']);
    expect(chain.delete.mock.calls.length).toBe(1);
  });

  it('deleteBlock (removes a section\'s lines) locks the quote row first too', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode: 'USD' }]); // lockDraftQuote
    queueResult([]); // delete lines
    queueResult([]); // delete block
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute update

    await svc.deleteBlock('q1', 'blk1', actor);

    const chain = db as unknown as LockChain;
    expect(chain.transaction.mock.calls.length).toBe(1);
    expect(chain.for.mock.calls[0]).toEqual(['update']);
    expect(chain.delete.mock.calls.length).toBe(2);
  });
});

// Wave-6 release gate (W6-G2-1): hand-entered money on a quote line is validated
// against the QUOTE's stamped currency under the same row lock that produced it.
describe('quoteService currency representability guard (W6-G2-1)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
  const draft = (currencyCode: string) => ({ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', currencyCode });
  const line = (over: Record<string, unknown> = {}) => ({
    sourceType: 'manual', name: 'Widget', quantity: 1, unitPrice: 100, taxable: false,
    customerVisible: true, recurrence: 'one_time', depositEligible: false, ...over,
  }) as never;

  it('addManualLine rejects a fractional minor unit on a JPY quote (PRICE_NOT_REPRESENTABLE 400)', async () => {
    queueResult([draft('JPY')]);
    await expect(svc.addManualLine('q1', line({ unitPrice: 100.5 }), actor))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect((db as unknown as { insert: { mock: { calls: unknown[][] } } }).insert.mock.calls.length).toBe(0);
  });

  it('addManualLine rejects a fractional JPY unitCost even when the price is whole', async () => {
    queueResult([draft('JPY')]);
    await expect(svc.addManualLine('q1', line({ unitPrice: 100, unitCost: 40.5 }), actor))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect((db as unknown as { insert: { mock: { calls: unknown[][] } } }).insert.mock.calls.length).toBe(0);
  });

  it('addManualLine leaves a 2-decimal currency unchanged — 100.50 USD is accepted', async () => {
    queueResult([draft('USD')]);
    queueResult([{ id: 'blk1' }]);                                             // resolveLineBlockId
    queueResult([{ max: -1 }]);                                                // nextLineSortOrder
    queueResult([{ id: 'l1', blockId: 'blk1' }]);                              // insert returning
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]);                                                           // recompute lines
    queueResult([]);                                                           // recompute update
    await expect(svc.addManualLine('q1', line({ unitPrice: 100.5 }), actor)).resolves.toMatchObject({ id: 'l1' });
  });

  it('updateLine rejects a patch that would make an existing JPY line fractional', async () => {
    queueResult([draft('JPY')]);
    queueResult([{ id: 'l1', quoteId: 'q1', name: 'W', description: null, quantity: '1', unitPrice: '100.00', taxable: false, customerVisible: true, recurrence: 'one_time' }]);
    await expect(svc.updateLine('q1', 'l1', { unitPrice: 100.5 }, actor))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect((db as unknown as { set: { mock: { calls: unknown[][] } } }).set.mock.calls.length).toBe(0);
  });
});
