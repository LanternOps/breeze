import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Partner billing master switch (partners.billing_enabled) on the quote draft
 * WRITE services: with billing off every gated function answers 404
 * BILLING_DISABLED and writes nothing. The gate lives in loadDraft /
 * lockDraftQuote (draft writers only), createQuote and cloneQuoteCore.
 * The gate itself is covered by quoteBillingGate.test.ts, so it is mocked here.
 */
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
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
vi.mock('./quoteNumbers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./quoteNumbers')>()),
  allocateQuoteCounter: vi.fn(async () => 1),
}));

import * as svc from './quoteService';
import { db } from '../db';
import { assertQuoteBillingEnabled } from './quoteBillingGate';
import { QuoteServiceError } from './quoteTypes';

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
const draft = (over: Record<string, unknown> = {}) => ({
  id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', siteId: null, currencyCode: 'USD',
  taxRate: null, depositType: 'none', depositPercent: null, ...over,
});
const disabled = () => new QuoteServiceError('Not found', 404, 'BILLING_DISABLED');
const writes = () => ['insert', 'update', 'delete'].reduce(
  (n, m) => n + (db as unknown as Record<string, { mock: { calls: unknown[] } }>)[m]!.mock.calls.length, 0);

const cases: Array<[string, () => Promise<unknown>]> = [
  ['updateQuote', () => svc.updateQuote('q1', { title: 'x' } as never, actor)],
  ['deleteDraftQuote', () => svc.deleteDraftQuote('q1', actor)],
  ['changeQuoteCurrency', () => svc.changeQuoteCurrency('q1', { currencyCode: 'EUR' }, actor)],
  ['addBlock', () => svc.addBlock('q1', { blockType: 'text', content: {} } as never, actor)],
  ['updateBlock', () => svc.updateBlock('q1', 'b1', { blockType: 'text', content: {} } as never, actor)],
  ['deleteBlock', () => svc.deleteBlock('q1', 'b1', actor)],
  ['reorderBlocks', () => svc.reorderBlocks('q1', ['b1'], actor)],
  ['addManualLine', () => svc.addManualLine('q1', { description: 'd', quantity: 1, unitPrice: 1 } as never, actor)],
  ['addCatalogLine', () => svc.addCatalogLine('q1', 'c1', 1, undefined, actor)],
  ['updateLine', () => svc.updateLine('q1', 'l1', { quantity: 2 } as never, actor)],
  ['removeLine', () => svc.removeLine('q1', 'l1', actor)],
  ['reorderLines', () => svc.reorderLines('q1', 'b1', ['l1'], actor)],
  ['moveLineToBlock', () => svc.moveLineToBlock('q1', 'l1', 'b2', actor)],
  ['refreshQuoteDeviceCounts', () => svc.refreshQuoteDeviceCounts('q1', actor)],
];

describe('quoteService billing master switch', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); (assertQuoteBillingEnabled as ReturnType<typeof vi.fn>).mockReset(); });

  it.each(cases)('%s answers 404 BILLING_DISABLED with billing off and writes nothing', async (_name, run) => {
    queueResult([draft()]);
    (assertQuoteBillingEnabled as ReturnType<typeof vi.fn>).mockRejectedValueOnce(disabled());
    await expect(run()).rejects.toMatchObject({ status: 404, code: 'BILLING_DISABLED' });
    expect(assertQuoteBillingEnabled).toHaveBeenCalledWith('org1');
    expect(writes()).toBe(0);
  });

  it('the gate runs before the draft-state check (a sent quote also reads BILLING_DISABLED)', async () => {
    queueResult([draft({ status: 'sent' })]);
    (assertQuoteBillingEnabled as ReturnType<typeof vi.fn>).mockRejectedValueOnce(disabled());
    await expect(svc.deleteDraftQuote('q1', actor)).rejects.toMatchObject({ code: 'BILLING_DISABLED' });
  });

  it('with billing on, a draft writer passes the gate and reaches its write', async () => {
    queueResult([draft()]);
    const out = await svc.deleteDraftQuote('q1', actor);
    expect(out).toEqual({ id: 'q1', orgId: 'org1' });
    expect(assertQuoteBillingEnabled).toHaveBeenCalledWith('org1');
    expect(writes()).toBe(1);
  });

  it('createQuote answers BILLING_DISABLED before allocating a quote number or inserting', async () => {
    (assertQuoteBillingEnabled as ReturnType<typeof vi.fn>).mockRejectedValueOnce(disabled());
    await expect(svc.createQuote({ orgId: 'org1', title: 't' } as never, actor)).rejects.toMatchObject({ code: 'BILLING_DISABLED', status: 404 });
    expect(assertQuoteBillingEnabled).toHaveBeenCalledWith('org1');
    expect(writes()).toBe(0);
  });

  it.each([
    ['cloneQuote', () => svc.cloneQuote('q1', actor)],
    ['reviseQuote', () => svc.reviseQuote('q1', actor)],
  ])('%s answers BILLING_DISABLED after the org-scoped read and writes nothing', async (_n, run) => {
    queueResult([draft({ status: 'sent' })]); // quote row
    queueResult([]); queueResult([]); queueResult([]); // blocks, lines, pax8 order
    (assertQuoteBillingEnabled as ReturnType<typeof vi.fn>).mockRejectedValueOnce(disabled());
    await expect(run()).rejects.toMatchObject({ code: 'BILLING_DISABLED', status: 404 });
    expect(writes()).toBe(0);
  });
});
