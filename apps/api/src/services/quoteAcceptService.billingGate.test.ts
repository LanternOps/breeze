import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Partner billing master switch on acceptQuote: with billing off the accept
 * answers 404 BILLING_DISABLED BEFORE any write (acceptance row, invoice,
 * contracts, status flip). The caller (quotesPublic / portal / accept-on-behalf)
 * revokes the public jti only after acceptQuote returns, so a thrown gate leaves
 * the link valid for when billing is re-enabled.
 *
 * NOTE: partners is RLS-hidden from org-scoped contexts, so the gate reads the
 * flag correctly only under system scope; all three callers wrap acceptQuote in
 * runOutsideDbContext(withSystemDbAccessContext(...)). A mock cannot prove that
 * RLS behaviour; it is covered by the callers' route tests asserting the wrapper
 * and, for the real read, needs a Postgres integration run.
 */
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute', 'transaction'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => Promise.resolve(results.shift() ?? []).then(resolve);
    return chain;
  };
  return {
    db: makeChain(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('./quoteBillingGate', () => ({ assertQuoteBillingEnabled: vi.fn() }));
vi.mock('./contractService', () => ({ createContractWithLinesDetailed: vi.fn() }));
vi.mock('./quoteToPax8Order', () => ({ stagePax8OrderFromQuote: vi.fn() }));

import { acceptQuote } from './quoteAcceptService';
import { db } from '../db';
import { assertQuoteBillingEnabled } from './quoteBillingGate';
import { QuoteServiceError } from './quoteTypes';

const writes = () => ['insert', 'update', 'delete'].reduce(
  (n, m) => n + (db as unknown as Record<string, { mock: { calls: unknown[] } }>)[m]!.mock.calls.length, 0);

describe('acceptQuote billing master switch', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('billing off -> 404 BILLING_DISABLED before any write, even for a replayed jti', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'sent', publicResponseJti: 'j1', publicResponseConsumedAt: new Date() }]);
    (assertQuoteBillingEnabled as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new QuoteServiceError('Not found', 404, 'BILLING_DISABLED'));
    await expect(acceptQuote({ quoteId: 'q1', signerName: 'S', acceptanceTokenJti: 'j1' } as never))
      .rejects.toMatchObject({ status: 404, code: 'BILLING_DISABLED' });
    expect(assertQuoteBillingEnabled).toHaveBeenCalledWith('org1');
    expect(writes()).toBe(0);
  });

  it('billing on -> the gate passes and the normal guards apply (superseded stays 410)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'superseded', publicTokenVersion: 0 }]);
    await expect(acceptQuote({ quoteId: 'q1', signerName: 'S' } as never)).rejects.toMatchObject({ status: 410, code: 'QUOTE_SUPERSEDED' });
    expect(assertQuoteBillingEnabled).toHaveBeenCalledWith('org1');
  });
});
