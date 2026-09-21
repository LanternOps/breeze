import { describe, it, expect, vi, beforeEach } from 'vitest';

const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

// Same controllable Drizzle chain harness as quoteAcceptService.test.ts.
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute', 'onConflictDoNothing'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(results.shift() ?? []).then(resolve);
    return chain;
  };
  const db = makeChain();
  return {
    db,
    assertInTransaction: () => {},
    getCurrentDbAccessContext: () => ({ scope: 'system' }),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withDbAccessContext: (_c: unknown, fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { claimQuoteSent } from './quoteLifecycle';
import { db } from '../db';

type Chain = {
  set: { mock: { calls: unknown[][] } };
  insert: { mock: { calls: unknown[][] } };
};

const draft = {
  id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft',
  quoteNumber: 'Q-2026-0001', issueDate: '2026-09-21', expiryDate: null,
  billToName: null, billToTaxId: null, sellerSnapshot: null,
  presentationSnapshot: null, documentLocale: null,
  termsAndConditions: null, terms: null, revisionOfQuoteId: null,
} as never;

describe('claimQuoteSent', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('flips draft→sent without writing any public-link or accept-token state', async () => {
    queueResult([{ id: 'p1', name: 'Acme MSP', documentTheme: null, documentPageSize: null, settings: {} }]); // partners
    queueResult([{ name: 'Customer Co', taxId: null, billingContact: null }]);                                 // organizations
    queueResult([{ id: 'q1' }]);                                                                               // claim .returning()

    await claimQuoteSent(draft, { now: new Date('2026-09-21T12:00:00Z') });

    const claim = (db as unknown as Chain).set.mock.calls[0]![0] as Record<string, unknown>;
    expect(claim).toMatchObject({ status: 'sent' });
    // The on-behalf accept reuses this helper precisely BECAUSE it mints
    // nothing the customer could act on: no token, no link, no recipients.
    for (const key of Object.keys(claim)) {
      expect(key, `claimQuoteSent must not write ${key}`).not.toMatch(/^(publicLink|acceptToken|publicToken|publicResponse)/);
    }
    // The other half of "no recipients": the helper must never INSERT at all —
    // a quote_recipients row is a portal signer identity, which is delivery.
    expect((db as unknown as Chain).insert.mock.calls).toHaveLength(0);
  });

  it('409s when the row is no longer a draft (the conditional claim matched 0 rows)', async () => {
    queueResult([{ id: 'p1', settings: {} }]);
    queueResult([{ name: 'Customer Co', taxId: null, billingContact: null }]);
    queueResult([]); // claim matched nothing

    await expect(claimQuoteSent(draft, { now: new Date() })).rejects.toMatchObject({ status: 409 });
  });
});
