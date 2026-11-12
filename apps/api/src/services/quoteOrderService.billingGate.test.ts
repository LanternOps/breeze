import { describe, it, expect, vi, beforeEach } from 'vitest';

// Partner billing master switch on the quote order (fulfilment) writes.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute', 'onConflictDoNothing'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(resolve);
    return chain;
  };
  return { db: makeChain() };
});
vi.mock('./quoteBillingGate', () => ({ assertQuoteBillingEnabled: vi.fn() }));

import { createQuoteOrder, updateQuoteOrder, updateQuoteOrderLine } from './quoteOrderService';
import { db } from '../db';
import { assertQuoteBillingEnabled } from './quoteBillingGate';
import { QuoteServiceError } from './quoteTypes';

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
const quote = { id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'accepted', siteId: null };
const writes = () => ['insert', 'update', 'delete'].reduce(
  (n, m) => n + (db as unknown as Record<string, { mock: { calls: unknown[] } }>)[m]!.mock.calls.length, 0);

describe('quoteOrderService billing master switch', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it.each([
    ['createQuoteOrder', () => createQuoteOrder('q1', { clientRequestId: 'r', lines: [] } as never, actor)],
    ['updateQuoteOrder', () => updateQuoteOrder('q1', 'o1', { notes: 'n' } as never, actor)],
    ['updateQuoteOrderLine', () => updateQuoteOrderLine('q1', 'o1', 'l1', { receivedQty: 1 } as never, actor)],
  ])('%s answers 404 BILLING_DISABLED with billing off and writes nothing', async (_n, run) => {
    queueResult([quote]);
    (assertQuoteBillingEnabled as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new QuoteServiceError('Not found', 404, 'BILLING_DISABLED'));
    await expect(run()).rejects.toMatchObject({ status: 404, code: 'BILLING_DISABLED' });
    expect(assertQuoteBillingEnabled).toHaveBeenCalledWith('org1');
    expect(writes()).toBe(0);
  });
});
