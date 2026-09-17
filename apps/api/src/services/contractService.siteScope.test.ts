import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Site-axis (sub-org) authorization guard for contractService — the third of the
 * three billing actors (InvoiceActor / QuoteActor already carry `allowedSiteIds`;
 * ContractActor did not, which let a site-restricted AI/HTTP caller read and
 * mutate every contract in the org — audit 2026-09-17 §2.3).
 *
 * THE ADOPTED RULE (documented in contractService.ts, mirroring
 * `requireSiteAccess` in invoiceService.ts:84-90 / `assertSite` in
 * quoteService.ts:179-184):
 *  - `contracts` has NO site column, so the site-attributable unit is the LINE
 *    (`contract_lines.site_id`). A line is reachable iff its `siteId` is non-null
 *    and in the allowlist — a null site is org-level and therefore DENIED to a
 *    restricted actor, byte-for-byte the invoice/quote null-site rule.
 *  - READ (getContract / listContracts): the line set is filtered to reachable
 *    lines and a contract with no reachable line is denied/omitted.
 *  - WRITE + whole-document reads (estimate, lifecycle, line ops, currency):
 *    EVERY line must be reachable, because those act on / aggregate the whole
 *    document. A contract with no lines is unattributable → denied, and
 *    createContract is denied outright for a restricted actor (mirrors
 *    createManualInvoice rejecting a null-site invoice).
 *
 * Same controllable Drizzle-chain mock as contractService.test.ts.
 */
type QueuedQuery = { rows: unknown[] };
const results: QueuedQuery[] = [];
function queueResult(rows: unknown[]) { results.push({ rows }); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute', 'onConflictDoNothing'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const result = results.shift() ?? { rows: [] };
      return Promise.resolve(result.rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  return {
    db,
    assertInTransaction: vi.fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

vi.mock('./contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./invoiceService', () => ({
  createManualInvoice: vi.fn(), addContractLine: vi.fn(), deleteDraftInvoice: vi.fn(),
}));
vi.mock('./contractQuantities', () => ({
  countContractDevices: vi.fn().mockResolvedValue(0), countContractSeats: vi.fn().mockResolvedValue(0),
  snapshotContractDevices: vi.fn().mockResolvedValue([]), groupMembersForBilling: vi.fn().mockResolvedValue([]),
}));
vi.mock('./catalogService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./catalogService')>();
  return { ...actual, resolvePrice: vi.fn() };
});

import { PgDialect } from 'drizzle-orm/pg-core';
import * as svc from './contractService';
import { db } from '../db';

/** Compiled text of the nth `.where(...)` predicate the service handed Drizzle.
 *  Proves a filter lives in SQL rather than in a post-fetch `.filter()`. */
const dialect = new PgDialect();
function compiledWhere(n: number): string {
  const calls = (db as unknown as { where: { mock: { calls: unknown[][] } } }).where.mock.calls;
  const predicate = calls[n]?.[0];
  if (predicate === undefined) return '';
  return dialect.sqlToQuery(predicate as never).sql;
}

/** Site-restricted org actor: org1, siteA only. */
const restricted = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'], allowedSiteIds: ['siteA'] };
/** Unrestricted actor (allowedSiteIds undefined) — partner/system or all-sites org user. */
const unrestricted = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

const contractRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1', orgId: 'org1', partnerId: 'p1', name: 'C1', status: 'draft',
  billingTiming: 'advance', intervalMonths: 1, startDate: '2026-01-01', endDate: null,
  nextBillingAt: null, autoIssue: false, autoRenew: false, renewalTermMonths: null,
  renewalNoticeDays: null, currencyCode: 'USD', notes: null, terms: null,
  createdBy: 'u1', createdAt: new Date(), updatedAt: new Date(), ...over,
});
const lineRow = (id: string, siteId: string | null, over: Record<string, unknown> = {}) => ({
  id, contractId: 'c1', orgId: 'org1', lineType: 'flat', description: id,
  catalogItemId: null, unitPrice: '10.00', manualQuantity: null, siteId, siteName: siteId,
  deviceRoles: null, includedQuantity: null, overageMode: null, overageUnitPrice: null,
  deviceGroupId: null, deviceGroupName: null, taxable: false, sortOrder: 0,
  createdAt: new Date(), ...over,
});

const selectCalls = () => (db as unknown as { select: { mock: { calls: unknown[][] } } }).select.mock.calls.length;

describe('contractService site-axis guard', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  // ---- READ: getContract -------------------------------------------------
  it('getContract denies a restricted actor a contract with no in-site line (SITE_DENIED 403)', async () => {
    queueResult([contractRow()]);                                   // contract
    queueResult([lineRow('l1', 'siteB'), lineRow('l2', null)]);      // lines
    await expect(svc.getContract('c1', restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('getContract returns ONLY in-site lines to a restricted actor', async () => {
    queueResult([contractRow()]);                                   // contract
    queueResult([lineRow('l1', 'siteA'), lineRow('l2', 'siteB'), lineRow('l3', null)]); // lines
    queueResult([]);                                                // periods
    queueResult([{ id: 'siteA', orgId: 'org1', name: 'Site A' }]);   // withLineRefs sites
    const { lines } = await svc.getContract('c1', restricted);
    expect(lines.map((l) => l.id)).toEqual(['l1']);
  });

  it('getContract is unaffected for an unrestricted actor (null-site + out-of-site lines visible)', async () => {
    queueResult([contractRow()]);
    queueResult([lineRow('l1', 'siteA'), lineRow('l2', 'siteB'), lineRow('l3', null)]);
    queueResult([]);                                                // periods
    queueResult([]);                                                // withLineRefs sites
    const { lines } = await svc.getContract('c1', unrestricted);
    expect(lines.map((l) => l.id)).toEqual(['l1', 'l2', 'l3']);
  });

  // ---- READ: listContracts ----------------------------------------------
  it('listContracts drops contracts with no in-site line for a restricted actor', async () => {
    queueResult([contractRow({ id: 'c1' }), contractRow({ id: 'c2' })]);   // rows
    queueResult([
      { ...lineRow('l1', 'siteA'), contractId: 'c1' },
      { ...lineRow('l2', 'siteB'), contractId: 'c2' },
    ]);                                                                    // all lines
    const out = await svc.listContracts({ limit: 50 }, restricted);
    expect(out.map((r) => r.id)).toEqual(['c1']);
  });

  it('listContracts returns both contracts for an unrestricted actor', async () => {
    queueResult([contractRow({ id: 'c1' }), contractRow({ id: 'c2' })]);
    queueResult([
      { ...lineRow('l1', 'siteA'), contractId: 'c1' },
      { ...lineRow('l2', 'siteB'), contractId: 'c2' },
    ]);
    const out = await svc.listContracts({ limit: 50 }, unrestricted);
    expect(out.map((r) => r.id)).toEqual(['c1', 'c2']);
  });

  // ---- WHOLE-DOCUMENT READ: estimate -------------------------------------
  it('computeContractEstimate denies a restricted actor when ANY line is out of site', async () => {
    queueResult([contractRow()]);
    queueResult([lineRow('l1', 'siteA'), lineRow('l2', 'siteB')]);
    await expect(svc.computeContractEstimate('c1', restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  // ---- WRITE: create -----------------------------------------------------
  it('createContract is denied outright for a site-restricted actor (unattributable document)', async () => {
    await expect(svc.createContract({
      orgId: 'org1', name: 'X', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-01-01',
    }, restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  // ---- WRITE: lifecycle / header ----------------------------------------
  it('updateContract denies a restricted actor when the contract carries an out-of-site line', async () => {
    queueResult([contractRow()]);                                  // contract
    queueResult([lineRow('l1', 'siteA'), lineRow('l2', 'siteB')]);  // site scan
    await expect(svc.updateContract('c1', { name: 'X' }, restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('deleteDraftContract denies a restricted actor an out-of-site contract', async () => {
    queueResult([contractRow()]);
    queueResult([lineRow('l1', 'siteB')]);
    await expect(svc.deleteDraftContract('c1', restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('activateContract denies a restricted actor an out-of-site contract', async () => {
    queueResult([contractRow()]);
    queueResult([lineRow('l1', 'siteB')]);
    await expect(svc.activateContract('c1', restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('pauseContract denies a restricted actor an out-of-site contract', async () => {
    queueResult([contractRow({ status: 'active' })]);
    queueResult([lineRow('l1', 'siteB')]);
    await expect(svc.pauseContract('c1', restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('resumeContract denies a restricted actor an out-of-site contract', async () => {
    queueResult([contractRow({ status: 'paused' })]);
    queueResult([lineRow('l1', 'siteB')]);
    await expect(svc.resumeContract('c1', restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('cancelContract denies a restricted actor an out-of-site contract', async () => {
    queueResult([contractRow({ status: 'active' })]);
    queueResult([lineRow('l1', 'siteB')]);
    await expect(svc.cancelContract('c1', restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('a contract with ZERO lines is unattributable and denied to a restricted actor', async () => {
    queueResult([contractRow({ status: 'active' })]);
    queueResult([]);                                               // no lines
    await expect(svc.cancelContract('c1', restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  // ---- WRITE: line operations -------------------------------------------
  it('addContractLineToContract denies a line whose siteId is outside the allowlist', async () => {
    queueResult([contractRow()]);                                  // lockContract
    queueResult([lineRow('l1', 'siteA')]);                          // site scan (whole contract in scope)
    await expect(svc.addContractLineToContract('c1', {
      lineType: 'per_device', description: 'd', unitPrice: '1.00', siteId: 'siteB',
    } as never, restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('addContractLineToContract denies an org-level (null-site) line for a restricted actor', async () => {
    queueResult([contractRow()]);
    queueResult([lineRow('l1', 'siteA')]);
    await expect(svc.addContractLineToContract('c1', {
      lineType: 'flat', description: 'd', unitPrice: '1.00',
    } as never, restricted)).rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('updateContractLine denies a restricted actor on an out-of-site contract', async () => {
    queueResult([contractRow()]);
    queueResult([lineRow('l1', 'siteB')]);
    await expect(svc.updateContractLine('c1', 'l1', { description: 'x' } as never, restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('removeContractLine denies a restricted actor on an out-of-site contract', async () => {
    queueResult([contractRow()]);
    queueResult([lineRow('l1', 'siteB')]);
    await expect(svc.removeContractLine('c1', 'l1', restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  // ---- no extra work for unrestricted callers ----------------------------
  it('an unrestricted actor triggers NO extra site scan (same query count as before the guard)', async () => {
    queueResult([contractRow({ status: 'active' })]);               // contract row only
    queueResult([{ id: 'c1', status: 'cancelled' }]);               // update ... returning
    await svc.cancelContract('c1', unrestricted);
    // getOwnedContractOr404 is the ONLY select; the guard returns before querying.
    expect(selectCalls()).toBe(1);
  });

  // ---- READ: listContracts narrows in SQL, not after the limit (#6110 finding 2)
  it('listContracts pushes the site predicate INTO SQL so limit/order apply after narrowing', async () => {
    queueResult([]);                                                // rows
    await svc.listContracts({ limit: 50 }, restricted);
    const where = compiledWhere(0);
    expect(where.toLowerCase()).toContain('exists');
    expect(where).toContain('contract_lines');
    expect(where).toContain('site_id');
  });

  it('listContracts adds NO site predicate for an unrestricted actor', async () => {
    queueResult([]);
    await svc.listContracts({ limit: 50 }, unrestricted);
    expect(compiledWhere(0).toLowerCase()).not.toContain('exists');
  });

  it('listContracts with an EMPTY site allowlist returns no rows and never queries', async () => {
    const out = await svc.listContracts({ limit: 50 }, { ...restricted, allowedSiteIds: [] });
    expect(out).toEqual([]);
    expect(selectCalls()).toBe(0);
  });

  // ---- READ: a partial read must not look complete (#6110 finding 3) -------
  it('getContract flags the partial read and WITHHOLDS period history when lines were hidden', async () => {
    queueResult([contractRow()]);                                   // contract
    queueResult([lineRow('l1', 'siteA'), lineRow('l2', 'siteB')]);   // lines
    queueResult([{ id: 'siteA', orgId: 'org1', name: 'Site A' }]);   // withLineRefs sites
    const out = await svc.getContract('c1', restricted);
    expect(out.linesFilteredBySiteScope).toBe(true);
    expect(out.periods).toBeNull();
  });

  it('getContract keeps period history when a restricted actor could reach EVERY line', async () => {
    queueResult([contractRow()]);
    queueResult([lineRow('l1', 'siteA')]);
    queueResult([{ id: 'per1', contractId: 'c1' }]);                 // periods
    queueResult([{ id: 'siteA', orgId: 'org1', name: 'Site A' }]);
    const out = await svc.getContract('c1', restricted);
    expect(out.linesFilteredBySiteScope).toBe(false);
    expect(out.periods).toHaveLength(1);
  });

  it('getContract leaves an unrestricted read untouched (no flag, periods present)', async () => {
    queueResult([contractRow()]);
    queueResult([lineRow('l1', 'siteA'), lineRow('l2', null)]);
    queueResult([{ id: 'per1', contractId: 'c1' }]);
    queueResult([]);
    const out = await svc.getContract('c1', unrestricted);
    expect(out.linesFilteredBySiteScope).toBeUndefined();
    expect(out.periods).toHaveLength(1);
  });

  it('listContracts withholds the estimate of a contract whose lines were partly hidden', async () => {
    queueResult([contractRow({ id: 'c1' }), contractRow({ id: 'c2' })]);
    queueResult([
      { ...lineRow('l1', 'siteA'), contractId: 'c1' },
      { ...lineRow('l2', 'siteB'), contractId: 'c1' },   // hidden -> c1's total is partial
      { ...lineRow('l3', 'siteA'), contractId: 'c2' },
    ]);
    const out = await svc.listContracts({ limit: 50 }, restricted);
    const c1 = out.find((r) => r.id === 'c1')!;
    expect(c1.linesFilteredBySiteScope).toBe(true);
    expect(c1.estimatedPeriodValue).toBeNull();
    const c2 = out.find((r) => r.id === 'c2')!;
    expect(c2.linesFilteredBySiteScope).toBe(false);
    expect(c2.estimatedPeriodValue).toBe('10.00');
  });

  it('listContracts leaves an unrestricted estimate untouched', async () => {
    queueResult([contractRow({ id: 'c1' })]);
    queueResult([
      { ...lineRow('l1', 'siteA'), contractId: 'c1' },
      { ...lineRow('l2', 'siteB'), contractId: 'c1' },
    ]);
    const out = await svc.listContracts({ limit: 50 }, unrestricted);
    expect(out[0]!.linesFilteredBySiteScope).toBeUndefined();
    expect(out[0]!.estimatedPeriodValue).toBe('20.00');
  });

  // ---- WHOLE-DOCUMENT WRITE: currency restamp (#6110 finding 5) -----------
  it('changeContractCurrency denies a restricted actor when ANY line is out of site', async () => {
    queueResult([contractRow()]);                                   // lockContract
    queueResult([lineRow('l1', 'siteB')]);                           // site scan
    await expect(svc.changeContractCurrency('c1', { currencyCode: 'EUR' }, restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  // ---- WRITE: updateContractLine MOVE check (#6110 finding 5) -------------
  const inScopeLine = () => lineRow('l1', 'siteA', { lineType: 'per_device' });

  it('updateContractLine refuses to MOVE a line to a site outside the allowlist', async () => {
    queueResult([contractRow()]);                                   // lockContract
    queueResult([inScopeLine()]);                                    // whole-doc site scan (all in scope)
    queueResult([inScopeLine()]);                                    // current line
    await expect(svc.updateContractLine('c1', 'l1', { siteId: 'siteB' } as never, restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('updateContractLine refuses to WIDEN a line to org level (siteId: null)', async () => {
    queueResult([contractRow()]);
    queueResult([inScopeLine()]);
    queueResult([inScopeLine()]);
    await expect(svc.updateContractLine('c1', 'l1', { siteId: null } as never, restricted))
      .rejects.toMatchObject({ code: 'SITE_DENIED', status: 403 });
  });

  it('updateContractLine ALLOWS a move that stays inside the allowlist', async () => {
    queueResult([contractRow()]);                                   // lockContract
    queueResult([inScopeLine()]);                                    // whole-doc site scan
    queueResult([inScopeLine()]);                                    // current line
    queueResult([{ id: 'siteA', name: 'Site A' }]);                   // assertSiteInOrg
    queueResult([inScopeLine()]);                                    // update ... returning
    queueResult([{ id: 'siteA', orgId: 'org1', name: 'Site A' }]);    // withLineRefs sites
    const { line } = await svc.updateContractLine('c1', 'l1', { siteId: 'siteA' } as never, restricted);
    expect(line.siteId).toBe('siteA');
  });
});
