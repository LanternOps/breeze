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

import * as svc from './quoteService';
import { db } from '../db';

type Chain = { set: { mock: { calls: unknown[][] } }; values: { mock: { calls: unknown[][] } } };

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

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
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', siteId: 's1', billToName: 'Old Co', taxRate: '0.10000', depositType: 'none', depositPercent: null }]);
    queueResult([{ id: 'org2' }]); // target org same-partner membership check
    // resolveQuoteTaxRate for the NEW org: 5% org rate, no partner default
    queueResult([{ taxExempt: false, taxRate: '0.05000' }]);
    queueResult([{ defaultTaxRate: null }]);
    queueResult([]); // contract-blocks re-validation fetch (no contract blocks)
    queueResult([]); // tx: quotes header update
    queueResult([]); // tx: blocks org move
    queueResult([]); // tx: lines org move
    queueResult([]); // tx: images org move
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
    // Calls 1-3: denormalized org_id moves on blocks, lines, and images.
    expect(setMock.mock.calls[1]![0]).toEqual({ orgId: 'org2' });
    expect(setMock.mock.calls[2]![0]).toEqual({ orgId: 'org2' });
    expect(setMock.mock.calls[3]![0]).toEqual({ orgId: 'org2' });
  });

  it('updateQuote org change with an explicit taxRate in the same patch skips re-resolution and keeps the explicit rate', async () => {
    const orgActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1', 'org2'] };
    // loadDraft
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', siteId: null, billToName: null, taxRate: '0.10000', depositType: 'none', depositPercent: null }]);
    queueResult([{ id: 'org2' }]); // membership check — NO resolveQuoteTaxRate selects follow
    queueResult([]); // contract-blocks re-validation fetch (no contract blocks)
    queueResult([]); // tx: quotes header update
    queueResult([]); // tx: blocks org move
    queueResult([]); // tx: lines org move
    queueResult([]); // tx: images org move
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
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', siteId: null, billToName: 'Old Co', taxRate: null, depositType: 'none', depositPercent: null }]); // loadDraft
    queueResult([{ id: 'org2' }]); // membership check
    queueResult([{ taxExempt: false, taxRate: null }]); // resolveQuoteTaxRate org
    queueResult([{ defaultTaxRate: null }]); // resolveQuoteTaxRate partner
    queueResult([]); // contract-blocks re-validation fetch (no contract blocks)
    queueResult([]); // tx: quotes header update
    queueResult([]); // tx: blocks org move
    queueResult([]); // tx: lines org move
    queueResult([]); // tx: images org move
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

  it('updateQuote rejects reassignment to an org of another partner', async () => {
    const orgActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1', 'org2'] };
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', taxRate: null, depositType: 'none', depositPercent: null }]);
    queueResult([]); // membership check finds no org2 row under p1

    await expect(svc.updateQuote('q1', { orgId: 'org2' }, orgActor)).rejects.toMatchObject({ code: 'ORG_NOT_FOUND', status: 404 });
  });

  it('updateQuote rejects reassignment that would carry an org-owned contract block to the new org (422)', async () => {
    const orgActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1', 'org2'] };
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', siteId: null, billToName: null, taxRate: null, depositType: 'none', depositPercent: null }]); // loadDraft
    queueResult([{ id: 'org2' }]); // membership check
    queueResult([{ taxExempt: false, taxRate: null }]); // resolveQuoteTaxRate org
    queueResult([{ defaultTaxRate: null }]); // resolveQuoteTaxRate partner
    queueResult([{ blockType: 'contract', content: { templateId: 'tpl-1', templateVersionId: 'ver-1' } }]); // contract-blocks re-validation fetch
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
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', siteId: null, billToName: null, taxRate: null, depositType: 'none', depositPercent: null }]); // loadDraft
    queueResult([{ id: 'org2' }]); // membership check
    queueResult([{ taxExempt: false, taxRate: null }]); // resolveQuoteTaxRate org
    queueResult([{ defaultTaxRate: null }]); // resolveQuoteTaxRate partner
    queueResult([{ blockType: 'contract', content: { templateId: 'tpl-1', templateVersionId: 'ver-1' } }]); // contract-blocks fetch
    queueResult([{ templateId: 'tpl-1', status: 'published' }]); // version published
    queueResult([{ status: 'active', orgId: null, partnerId: 'p1' }]); // PARTNER-WIDE — visible to every org of the partner
    queueResult([]); // tx: quotes header update
    queueResult([]); // tx: blocks org move
    queueResult([]); // tx: lines org move
    queueResult([]); // tx: images org move
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
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
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
    expect(valuesMock.mock.calls.at(-1)![0]).toMatchObject({ depositEligible: true, itemType: 'hardware' });
  });

  it('addCatalogLine on a service catalog item sets depositEligible false and itemType service', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft' }]); // loadDraft
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

    await svc.addCatalogLine('q1', 'cat2', 1, undefined, actor);

    const valuesMock = (db as unknown as Chain).values;
    expect(valuesMock.mock.calls.at(-1)![0]).toMatchObject({ depositEligible: false, itemType: 'service' });
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

  it('getQuote returns depositDueTotal and categoryBreakdown', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', taxRate: '0.10000', depositType: 'percent', depositPercent: '30.00' }]); // quote
    queueResult([]); // blocks
    queueResult([{ quantity: '1', unitPrice: '1000.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false, itemType: 'hardware' }]); // lines
    queueResult([]); // no staged Pax8 order

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
    queueResult([{ pax8OrderId: 'order-1' }]);
    queueResult([{ count: 3 }]);

    const detail = await svc.getQuote('q1', actor);

    expect(detail.pax8OrderId).toBe('order-1');
    expect(detail.pax8OrderLineCount).toBe(3);
  });

  it('getQuote returns a null staged-order summary when acceptance staged no Pax8 order', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', taxRate: null, depositType: 'none', depositPercent: null }]);
    queueResult([]); // blocks
    queueResult([]); // quote lines
    queueResult([]); // no Pax8 order for this quote/tenant

    const detail = await svc.getQuote('q1', actor);

    expect(detail.pax8OrderId).toBeNull();
    expect(detail.pax8OrderLineCount).toBe(0);
  });

  it('getQuote returns a SENT quote bill-to from the frozen snapshot, never the live org', async () => {
    // Frozen at send when the org had no address → an all-null block. That blank is
    // the immutable record; getQuote must NOT re-derive from the (now-populated) org.
    const frozen = { line1: null, line2: null, city: null, region: null, postalCode: null, country: null };
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent', billToName: 'Frozen Co', billToAddress: frozen, billToTaxId: null, taxRate: null, depositType: 'none', depositPercent: null }]); // quote
    queueResult([]); // blocks
    queueResult([]); // lines
    queueResult([]); // no staged Pax8 order
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
