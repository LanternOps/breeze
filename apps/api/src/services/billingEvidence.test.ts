/**
 * #3205 W07 — the read service. The two properties worth a unit test are the
 * ones a real DB would hide: `recorded` comes from the INVOICE, never a row
 * count; and same-parent ownership is a SQL predicate, not a post-fetch check.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  queryResults: [] as unknown[][],
  queryLimits: [] as number[],
  queryPredicates: [] as unknown[],
  evidenceRowSelectSpy: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn((selection?: Record<string, unknown>) => {
      if (selection && 'countedAs' in selection) dbMocks.evidenceRowSelectSpy();
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'orderBy', 'leftJoin']) chain[method] = vi.fn(() => chain);
      chain.where = vi.fn((predicate: unknown) => {
        dbMocks.queryPredicates.push(predicate);
        return chain;
      });
      chain.limit = vi.fn((limit: number) => {
        dbMocks.queryLimits.push(limit);
        return chain;
      });
      chain.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve(dbMocks.queryResults.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

const serviceMocks = vi.hoisted(() => ({
  getOwnedInvoiceOr404: vi.fn(),
  requireInvoiceAccess: vi.fn(),
  getOwnedContractOr404: vi.fn(),
}));
vi.mock('./invoiceService', () => ({
  getOwnedInvoiceOr404: serviceMocks.getOwnedInvoiceOr404,
  requireInvoiceAccess: serviceMocks.requireInvoiceAccess,
}));
vi.mock('./contractService', () => ({ getOwnedContractOr404: serviceMocks.getOwnedContractOr404 }));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { InvoiceActor } from './invoiceTypes';
import type { ContractActor } from './contractTypes';
import { getPeriodOutcome, listInvoiceLineDevices } from './billingEvidence';

const { getOwnedInvoiceOr404, requireInvoiceAccess, getOwnedContractOr404 } = serviceMocks;
const { queryResults, queryLimits, queryPredicates, evidenceRowSelectSpy } = dbMocks;

const INV = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_INV = '22222222-2222-4222-8222-222222222222';
const LINE = '33333333-3333-4333-8333-333333333333';
const OTHER_INVOICES_LINE = '44444444-4444-4444-8444-444444444444';
const CONTRACT = '55555555-5555-4555-8555-555555555555';
const PERIOD = '66666666-6666-4666-8666-666666666666';
const OTHER_CONTRACTS_PERIOD = '77777777-7777-4777-8777-777777777777';
const E1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const E2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const E3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const INVOICE_ACTOR: InvoiceActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
const CONTRACT_ACTOR: ContractActor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

function mockInvoice(over: { evidenceVersion: number | null }) {
  getOwnedInvoiceOr404.mockResolvedValue({ id: INV, orgId: 'org1', siteId: null, ...over });
}
function mockInvoiceNotVisible() { getOwnedInvoiceOr404.mockRejectedValue({ status: 404, code: 'INVOICE_NOT_FOUND' }); }
function mockLineBelongsToInvoice(belongs: boolean) { queryResults.push(belongs ? [{ id: LINE }] : []); }
function mockRows(rows: unknown[]) { queryResults.push(rows); }
function mockTotal(n: number) { queryResults.splice(queryResults.length - 1, 0, [{ n }]); }
function row(id: string, hostname: string) {
  return { id, deviceId: null, hostname, deviceRole: 'server', siteId: null, countedAs: 'included' as const };
}
function limitPassedToQuery() { return queryLimits.at(-1); }
function cursorPredicateSql() {
  const predicate = queryPredicates.at(-1) as Parameters<PgDialect['sqlToQuery']>[0];
  return new PgDialect().sqlToQuery(predicate).sql;
}
function mockContract() { getOwnedContractOr404.mockResolvedValue({ id: CONTRACT, orgId: 'org1' }); }
function mockPeriodBelongsToContract(belongs: boolean) { queryResults.push(belongs ? [{ id: PERIOD }] : []); }
function mockOutcome(outcome: null | Partial<{
  snapshotDeviceTotal: number; uncoveredTotal: number; flaggedTotal: number; billedOverageTotal: number;
  uncoveredByRole: Record<string, number>; overages: unknown[];
}>) {
  queryResults.push(outcome ? [{
    contractBillingPeriodId: PERIOD, invoiceId: INV, snapshotDeviceTotal: 0, uncoveredTotal: 0,
    flaggedTotal: 0, billedOverageTotal: 0, uncoveredByRole: {}, overages: [],
    generatedAt: new Date('2026-09-03T12:00:00.000Z'), ...outcome,
  }] : []);
}

beforeEach(() => {
  queryResults.length = 0;
  queryLimits.length = 0;
  queryPredicates.length = 0;
  vi.clearAllMocks();
});

describe('listInvoiceLineDevices (#3205 W07)', () => {
  it('recorded follows invoices.evidence_version, NOT the row count', async () => {
    mockInvoice({ evidenceVersion: 1 }); mockLineBelongsToInvoice(true); mockRows([]); mockTotal(0);
    await expect(listInvoiceLineDevices(INV, LINE, { limit: 100 }, INVOICE_ACTOR))
      .resolves.toEqual({ recorded: true, total: 0, devices: [], nextCursor: null });

    mockInvoice({ evidenceVersion: null }); mockLineBelongsToInvoice(true); mockRows([]); mockTotal(0);
    await expect(listInvoiceLineDevices(INV, LINE, { limit: 100 }, INVOICE_ACTOR))
      .resolves.toMatchObject({ recorded: false });
  });

  it('a line id belonging to a DIFFERENT invoice in the same org is 404, and never reaches the row fetch', async () => {
    mockInvoice({ evidenceVersion: 1 }); mockLineBelongsToInvoice(false);
    await expect(listInvoiceLineDevices(INV, OTHER_INVOICES_LINE, { limit: 100 }, INVOICE_ACTOR))
      .rejects.toMatchObject({ status: 404, code: 'INVOICE_LINE_NOT_FOUND' });
    expect(evidenceRowSelectSpy).not.toHaveBeenCalled();
  });

  it('a cross-tenant invoiceId is 404, never 403', async () => {
    mockInvoiceNotVisible();
    await expect(listInvoiceLineDevices(OTHER_ORG_INV, LINE, { limit: 100 }, INVOICE_ACTOR))
      .rejects.toMatchObject({ status: 404 });
  });

  it('clamps limit to 500', async () => {
    mockInvoice({ evidenceVersion: 1 }); mockLineBelongsToInvoice(true); mockRows([]); mockTotal(0);
    await listInvoiceLineDevices(INV, LINE, { limit: 5000 }, INVOICE_ACTOR);
    expect(limitPassedToQuery()).toBe(501);
  });

  it('keyset pages on (hostname, id) and is stable across a boundary with duplicate hostnames', async () => {
    mockInvoice({ evidenceVersion: 1 }); mockLineBelongsToInvoice(true);
    mockRows([row(E1, 'dup'), row(E2, 'dup'), row(E3, 'dup')]); mockTotal(3);
    const page1 = await listInvoiceLineDevices(INV, LINE, { limit: 2 }, INVOICE_ACTOR);
    expect(page1.devices.map((d) => d.id)).toEqual([E1, E2]);
    expect(page1.nextCursor).not.toBeNull();
    mockInvoice({ evidenceVersion: 1 }); mockLineBelongsToInvoice(true);
    mockRows([row(E3, 'dup')]); mockTotal(3);
    const page2 = await listInvoiceLineDevices(INV, LINE, { limit: 2, cursor: page1.nextCursor! }, INVOICE_ACTOR);
    expect(page2.devices.map((d) => d.id)).toEqual([E3]);
    expect(page2.nextCursor).toBeNull();
    expect(cursorPredicateSql()).toMatch(/hostname[\s\S]*,[\s\S]*id[\s\S]*\)\s*>/);
  });

  it('rejects a malformed cursor with 400 rather than silently paging from the start', async () => {
    mockInvoice({ evidenceVersion: 1 }); mockLineBelongsToInvoice(true);
    await expect(listInvoiceLineDevices(INV, LINE, { limit: 10, cursor: 'not-base64url!!' }, INVOICE_ACTOR))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_CURSOR' });
  });
});

describe('getPeriodOutcome (#3205 W07)', () => {
  it('a period id belonging to a different contract is 404', async () => {
    mockContract(); mockPeriodBelongsToContract(false);
    await expect(getPeriodOutcome(CONTRACT, OTHER_CONTRACTS_PERIOD, CONTRACT_ACTOR))
      .rejects.toMatchObject({ status: 404, code: 'PERIOD_NOT_FOUND' });
  });

  it('a pre-W07 period returns recorded:false with a null outcome', async () => {
    mockContract(); mockPeriodBelongsToContract(true); mockOutcome(null);
    await expect(getPeriodOutcome(CONTRACT, PERIOD, CONTRACT_ACTOR))
      .resolves.toEqual({ recorded: false, outcome: null });
  });

  it('a recorded period returns the scalars and both jsonb digests', async () => {
    mockContract(); mockPeriodBelongsToContract(true);
    mockOutcome({ snapshotDeviceTotal: 12, uncoveredTotal: 2, flaggedTotal: 5, billedOverageTotal: 0,
      uncoveredByRole: { printer: 2 }, overages: [{ mode: 'flag', overage: 5 }] });
    const out = await getPeriodOutcome(CONTRACT, PERIOD, CONTRACT_ACTOR);
    expect(out.recorded).toBe(true);
    expect(out.outcome).toMatchObject({ uncoveredByRole: { printer: 2 }, flaggedTotal: 5, snapshotDeviceTotal: 12 });
  });
});
