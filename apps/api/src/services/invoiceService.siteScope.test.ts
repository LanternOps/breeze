import { describe, it, expect, vi, beforeEach } from 'vitest';

// Site-axis (sub-org) authorization guard for invoiceService (SR5-14). Mirrors the
// controllable Drizzle-chain mock in invoiceService.test.ts: every builder method
// returns the same chain; a query resolves when awaited, yielding the next queued
// result. These tests lock the site-scope branch of the org/site guards — the
// SQL-level list filtering is additionally proven against real Postgres in the
// integration suite.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) { results.push(rows); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute'];
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
    withSystemDbAccessContext: (fn: () => unknown) => fn()
  };
});

vi.mock('./catalogService', () => ({ resolvePrice: vi.fn(), computeBundleEconomics: vi.fn() }));
vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./stripeConnectService', () => ({ getConnection: vi.fn().mockResolvedValue(null) }));

import * as svc from './invoiceService';
import { db } from '../db';

// A site-restricted org actor (allowedSiteIds present) that can reach org1 and only siteA.
const restricted = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'], allowedSiteIds: ['siteA'] };
// An unrestricted actor (allowedSiteIds undefined) — partner/system scope or all-sites org user.
const unrestricted = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

describe('invoiceService site-axis guard', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('getInvoice denies a site-restricted actor an out-of-site invoice (SITE_DENIED 403)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', siteId: 'siteB' }]);
    await expect(svc.getInvoice('i1', restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('getInvoice denies a site-restricted actor a null-site (org-level) invoice (SITE_DENIED 403)', async () => {
    // Null-site semantics: a restricted caller can never see an org-level invoice,
    // matching auth.ts siteAccessCheck which denies a restricted caller a null site.
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', siteId: null }]);
    await expect(svc.getInvoice('i1', restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('getInvoice allows a site-restricted actor an in-site invoice', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', siteId: 'siteA' }]); // getOwnedInvoiceOr404
    queueResult([]); // lines
    const result = await svc.getInvoice('i1', restricted);
    expect(result.invoice.id).toBe('i1');
  });

  it('getInvoice is unaffected for an unrestricted actor (out-of-site & null-site both visible)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', siteId: 'siteB' }]);
    queueResult([]); // lines
    const result = await svc.getInvoice('i1', unrestricted);
    expect(result.invoice.id).toBe('i1');
  });

  it('updateInvoice denies editing an out-of-site draft (SITE_DENIED 403)', async () => {
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', siteId: 'siteB' }]);
    await expect(svc.updateInvoice('i1', { notes: 'x' }, restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('updateInvoice denies MOVING an in-site draft to an out-of-site siteId (SITE_DENIED 403)', async () => {
    // Existing site (siteA) is accessible, but the requested move target (siteB) is not.
    queueResult([{ id: 'i1', status: 'draft', orgId: 'org1', partnerId: 'p1', siteId: 'siteA' }]);
    await expect(svc.updateInvoice('i1', { siteId: 'siteB' }, restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('createManualInvoice rejects an out-of-site siteId (SITE_DENIED 403)', async () => {
    await expect(
      svc.createManualInvoice({ orgId: 'org1', siteId: 'siteB' }, restricted)
    ).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('createManualInvoice rejects a null-site invoice for a restricted actor (SITE_DENIED 403)', async () => {
    await expect(
      svc.createManualInvoice({ orgId: 'org1' }, restricted)
    ).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('recordPayment denies a payment on an out-of-site invoice (SITE_DENIED 403)', async () => {
    queueResult([{ id: 'i1', status: 'sent', orgId: 'org1', partnerId: 'p1', siteId: 'siteB', balance: '50.00' }]);
    await expect(
      svc.recordPayment('i1', { amount: 10, method: 'check', receivedAt: '2026-06-14' }, restricted)
    ).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('listInvoices adds a site filter for a restricted actor (where receives a defined condition)', async () => {
    queueResult([]); // final rows
    await svc.listInvoices({ limit: 25 }, restricted);
    const whereMock = (db as unknown as { where: { mock: { calls: unknown[][] } } }).where;
    // With no orgId/status/cursor, the ONLY condition is the site restriction, so a
    // defined argument proves the filter was applied.
    expect(whereMock.mock.calls.at(-1)![0]).toBeDefined();
  });

  it('listInvoices adds NO site filter for an unrestricted actor (where receives undefined)', async () => {
    queueResult([]); // final rows
    await svc.listInvoices({ limit: 25 }, unrestricted);
    const whereMock = (db as unknown as { where: { mock: { calls: unknown[][] } } }).where;
    expect(whereMock.mock.calls.at(-1)![0]).toBeUndefined();
  });
});
