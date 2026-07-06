import { describe, it, expect, vi, beforeEach } from 'vitest';

// Controllable Drizzle chain mock (same pattern as quoteService.test.ts /
// invoiceService.test.ts): every builder method returns the same chain; a
// query resolves when awaited (the chain is a thenable that yields the next
// queued result). Tests queue the rows each db call should resolve to, in
// call order.
//
// acceptQuote has no dedicated org/RLS layer to stub around (it runs inside
// the caller's already-scoped transaction), so this harness drives the
// function's own literal db call sequence directly rather than mocking a
// sibling service. See the per-test comment blocks for the exact call order.
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

import { acceptQuote } from './quoteAcceptService';
import { db } from '../db';

type Chain = { set: { mock: { calls: unknown[][] } } };

const baseParams = {
  quoteId: 'q1',
  signerName: 'Jane Doe',
  signerEmail: 'jane@example.com',
  ipAddress: '1.2.3.4',
  userAgent: 'test-agent',
  acceptanceTokenJti: null,
  actorUserId: null,
};

/**
 * Queues the full db call sequence acceptQuote makes for a quote with exactly
 * one one-time, customer-visible line (so the invoice auto-issues) and NO
 * recurring lines (so buildContractSpecsFromQuote yields zero contract specs
 * and the contract-creation loop never touches the db — keeping this harness
 * to acceptQuote's own calls):
 *   1. select quotes ... for('update')      -> [quote]
 *   2. select quoteBlocks                    -> []
 *   3. select quoteLines                     -> [line]
 *   4. insert quoteAcceptances .returning()  -> [{id}]
 *   5. insert invoices .returning()          -> [{id}]
 *   6. insert invoiceLines (1x, unused)      -> []
 *   7. select partners (prefix/termsDays)    -> [{...}]
 *   8. execute (counter upsert)              -> [{counter}]
 *   9. update invoices .set(issueFields)     -> [] (unused)
 *  10. update quotes .set(converted)         -> [] (unused)
 *  11. select quotes (final re-select)       -> [updated quote]
 */
function queueAcceptHappyPath(quoteOverrides: Record<string, unknown> = {}) {
  const quote = {
    id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent',
    expiryDate: null, quoteNumber: 'Q-2026-0001', taxRate: null,
    currencyCode: 'USD', siteId: null,
    billToName: null, billToAddress: null, billToTaxId: null,
    sellerSnapshot: null, termsAndConditions: null, terms: null,
    depositType: 'none', depositPercent: null, depositAmount: null,
    ...quoteOverrides,
  };
  const line = {
    id: 'l1', quoteId: 'q1', recurrence: 'one_time', customerVisible: true,
    taxable: true, quantity: '1', unitPrice: '1000.00', catalogItemId: null,
    description: 'Widget', name: 'Widget', termMonths: null, sortOrder: 0,
  };

  queueResult([quote]);                              // 1
  queueResult([]);                                    // 2 blocks
  queueResult([line]);                                // 3 lines
  queueResult([{ id: 'acc1' }]);                       // 4 quote_acceptances insert
  queueResult([{ id: 'inv1' }]);                       // 5 invoices insert
  queueResult([]);                                    // 6 invoiceLines insert
  queueResult([{ prefix: 'INV', termsDays: 30 }]);     // 7 partners select
  queueResult([{ counter: 1 }]);                       // 8 counter upsert
  queueResult([]);                                    // 9 invoices update
  queueResult([]);                                    // 10 quotes update
  queueResult([{ ...quote, status: 'converted' }]);    // 11 final re-select

  return { quote, line };
}

describe('acceptQuote deposit snapshot', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('snapshots quote.depositAmount onto the issued invoice as depositDue when a deposit is configured', async () => {
    queueAcceptHappyPath({ depositType: 'percent', depositPercent: '30.00', depositAmount: '300.00' });

    await acceptQuote(baseParams);

    const setMock = (db as unknown as Chain).set;
    // calls[0] is the invoices update (issueFields); calls[1] is the quotes
    // status->converted update. See queueAcceptHappyPath's call-order doc above.
    expect(setMock.mock.calls[0]![0]).toMatchObject({ depositDue: '300.00' });
  });

  it('leaves depositDue unset on the invoice when the quote has no deposit configured', async () => {
    queueAcceptHappyPath(); // depositType: 'none', depositAmount: null (defaults)

    await acceptQuote(baseParams);

    const setMock = (db as unknown as Chain).set;
    expect(setMock.mock.calls[0]![0]).not.toHaveProperty('depositDue');
  });
});
