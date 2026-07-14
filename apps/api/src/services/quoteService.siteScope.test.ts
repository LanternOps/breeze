import { describe, it, expect, vi, beforeEach } from 'vitest';

// Site-axis (sub-org) authorization guard for quoteService (SR5-15). Same
// controllable Drizzle-chain mock as quoteService.test.ts. These tests lock the
// site-scope branch of assertQuoteAccess/assertSite; the SQL-level list filtering
// is additionally proven against real Postgres in the integration suite.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute', 'transaction'];
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

// A site-restricted org actor (allowedSiteIds present) that can reach org1 and only siteA.
const restricted = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'], allowedSiteIds: ['siteA'] };
// An unrestricted actor (allowedSiteIds undefined) — partner/system scope or all-sites org user.
const unrestricted = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

describe('quoteService site-axis guard', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('getQuote denies a site-restricted actor an out-of-site quote (SITE_DENIED 403)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', siteId: 'siteB' }]);
    await expect(svc.getQuote('q1', restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('getQuote denies a site-restricted actor a null-site (org-level) quote (SITE_DENIED 403)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', siteId: null }]);
    await expect(svc.getQuote('q1', restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('getQuote is unaffected for an unrestricted actor (null-site quote visible)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', siteId: null, taxRate: null, depositType: 'none', depositPercent: null }]); // quote row
    queueResult([]); // blocks
    queueResult([]); // lines
    queueResult([]); // staged Pax8 order
    const { quote } = await svc.getQuote('q1', unrestricted);
    expect(quote.id).toBe('q1');
  });

  it('updateQuote denies editing an out-of-site draft (SITE_DENIED 403)', async () => {
    // loadDraft's assertQuoteAccess rejects the out-of-site quote before any write.
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', siteId: 'siteB' }]);
    await expect(svc.updateQuote('q1', { title: 'x' }, restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('updateQuote denies MOVING an in-site draft to an out-of-site siteId (SITE_DENIED 403)', async () => {
    queueResult([{ id: 'q1', orgId: 'org1', partnerId: 'p1', status: 'draft', siteId: 'siteA' }]);
    await expect(svc.updateQuote('q1', { siteId: 'siteB' }, restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('createQuote rejects an out-of-site siteId (SITE_DENIED 403)', async () => {
    await expect(
      svc.createQuote({ orgId: 'org1', siteId: 'siteB', currencyCode: 'USD' } as never, restricted)
    ).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('createQuote rejects a null-site quote for a restricted actor (SITE_DENIED 403)', async () => {
    await expect(
      svc.createQuote({ orgId: 'org1', currencyCode: 'USD' } as never, restricted)
    ).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('listQuotes adds a site filter for a restricted actor (where receives a defined condition)', async () => {
    queueResult([]); // rows
    await svc.listQuotes({ limit: 25 } as never, restricted);
    const whereMock = (db as unknown as { where: { mock: { calls: unknown[][] } } }).where;
    expect(whereMock.mock.calls.at(-1)![0]).toBeDefined();
  });

  it('listQuotes adds NO site filter for an unrestricted actor (where receives undefined)', async () => {
    queueResult([]); // rows
    await svc.listQuotes({ limit: 25 } as never, unrestricted);
    const whereMock = (db as unknown as { where: { mock: { calls: unknown[][] } } }).where;
    expect(whereMock.mock.calls.at(-1)![0]).toBeUndefined();
  });
});
