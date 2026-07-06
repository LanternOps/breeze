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
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute', 'transaction'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
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
    queueResult([{ max: -1 }]); // nextLineSortOrder
    queueResult([{ id: 'l2', depositEligible: false, itemType: 'service' }]); // insert returning
    queueResult([{ taxRate: null, depositType: 'none', depositPercent: null }]); // recompute header
    queueResult([]); // recompute lines
    queueResult([]); // recompute's own update (unused result)

    await svc.addCatalogLine('q1', 'cat2', 1, undefined, actor);

    const valuesMock = (db as unknown as Chain).values;
    expect(valuesMock.mock.calls.at(-1)![0]).toMatchObject({ depositEligible: false, itemType: 'service' });
  });

  it('getQuote returns depositDueTotal and categoryBreakdown', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', taxRate: '0.10000', depositType: 'percent', depositPercent: '30.00' }]); // quote
    queueResult([]); // blocks
    queueResult([{ quantity: '1', unitPrice: '1000.00', taxable: true, customerVisible: true, recurrence: 'one_time', depositEligible: false, itemType: 'hardware' }]); // lines

    const { quote } = await svc.getQuote('q1', actor);

    expect(quote.depositDueTotal).toBe('330.00');
    expect(quote.categoryBreakdown).toEqual([
      { category: 'hardware', oneTimeTotal: '1000.00', monthlyTotal: '0.00', annualTotal: '0.00' },
    ]);
  });
});
