vi.mock('./autopay/autopayGate', () => ({ isAutopayEnabledForPartner: vi.fn().mockResolvedValue(false) }));
import { describe, it, expect, vi, beforeEach } from 'vitest';

type QueuedQuery = { rows: unknown[] } | { error: unknown };
const results: QueuedQuery[] = [];
function queueResult(rows: unknown[]) { results.push({ rows }); }
function queueError(error: unknown) { results.push({ error }); }

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute', 'onConflictDoNothing'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const result = results.shift() ?? { rows: [] };
      return 'error' in result ? reject(result.error) : resolve(result.rows);
    };
    return chain;
  };
  const db = makeChain();
  return {
    db, assertInTransaction: vi.fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: vi.fn(),
  };
});
vi.mock('./contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./invoiceService', () => ({ createManualInvoice: vi.fn(), addContractLine: vi.fn(), deleteDraftInvoice: vi.fn() }));
vi.mock('./contractQuantities', () => ({
  countContractDevices: vi.fn(), countContractSeats: vi.fn(), snapshotContractDevices: vi.fn(), groupMembersForBilling: vi.fn(),
}));
vi.mock('./contractHourBlockEstimate', () => ({ computeOpenHourBlockPeriod: vi.fn() }));

import * as svc from './contractService';
import { db } from '../db';

type Chain = { values: { mock: { calls: unknown[][] } }; delete: { mock: { calls: unknown[][] } }; set: { mock: { calls: unknown[][] } } };
const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

const BLOCK_INPUT = {
  lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
  includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'carry_forward',
  rolloverCapHours: '4', hourBlockAlertPct: 80,
} as never;

const contractRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1', status: 'active', orgId: 'org1', partnerId: 'p1', name: 'Acme MSA', currencyCode: 'USD',
  startDate: '2026-06-01', intervalMonths: 1, billingTiming: 'advance', nextBillingAt: '2026-07-01', ...over,
});

describe('addContractLineToContract — hour_block (#4547 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  /** `claimed`: contract_billing_periods rows at/after the candidate (only an ACTIVE contract is asked). */
  const addAndRead = async (contract: Record<string, unknown>, claimed: Array<{ periodStart: string }> = []) => {
    queueResult([contractRow(contract)]);                                                  // lockContract
    if (contract.status !== 'draft') queueResult(claimed);                                 // claimed periods >= candidate
    queueResult([{ id: 'l1', contractId: 'c1', orgId: 'org1', lineType: 'hour_block' }]);  // insert returning
    await svc.addContractLineToContract('c1', BLOCK_INPUT, actor);
    return (db as unknown as Chain).values.mock.calls[0]![0];
  };

  it('writes the block columns and nulls everything a block must not carry', async () => {
    expect(await addAndRead({})).toMatchObject({
      lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00',
      rolloverPolicy: 'carry_forward', rolloverCapHours: '4', hourBlockAlertPct: 80, hourBlockRetiredAt: null,
      siteId: null, deviceRoles: null, deviceGroupId: null, manualQuantity: null,
    });
  });

  it('active ADVANCE contract mid-period: starts at the NEXT period (the current one was claimed without the fee)', async () => {
    // June was claimed at its start; nextBillingAt points at July.
    expect(await addAndRead({ status: 'active', billingTiming: 'advance', nextBillingAt: '2026-07-01' }))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-07-01' });
  });

  it('active ARREARS contract mid-period: starts at the period IN PROGRESS (its fee is billed at its end)', async () => {
    // June is accruing; arrears bills it on 2026-07-01 with this line on it.
    expect(await addAndRead({ status: 'active', billingTiming: 'arrears', nextBillingAt: '2026-07-01' }))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-06-01' });
  });

  it('active quarterly arrears: the quarter in progress', async () => {
    expect(await addAndRead({ startDate: '2026-01-01', intervalMonths: 3, billingTiming: 'arrears', nextBillingAt: '2026-10-01' }))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-07-01' });
  });

  it('03-31 contract, arrears, pointer 04-30: the period in progress starts 03-31 (no month-subtraction drift)', async () => {
    expect(await addAndRead({ startDate: '2026-03-31', billingTiming: 'arrears', nextBillingAt: '2026-04-30' }))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-03-31' });
  });

  it('PAUSE -> RESUME on an advance contract: the pointer was reset onto a period claimed before the pause, so the block starts at the first UNCLAIMED one', async () => {
    // resumeContract points nextBillingAt at the period containing today (June), which was claimed before the pause.
    expect(await addAndRead({ nextBillingAt: '2026-06-01' }, [{ periodStart: '2026-06-01' }]))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-07-01' });
    results.length = 0; (db as unknown as Chain).values.mock.calls.length = 0;
    // ...and two consecutive claimed periods walk two steps.
    expect(await addAndRead({ nextBillingAt: '2026-06-01' }, [{ periodStart: '2026-06-01' }, { periodStart: '2026-07-01' }]))
      .toMatchObject({ hourBlockFirstPeriodStart: '2026-08-01' });
  });

  it("draft: the provisional stamp is the contract's FIRST period, whatever today is (activation re-stamps it)", async () => {
    expect(await addAndRead({ status: 'draft', startDate: '2025-01-01', nextBillingAt: null }))
      .toMatchObject({ hourBlockFirstPeriodStart: '2025-01-01' });
  });

  it('an active contract with no billing pointer is a typed 409, never a null stamp', async () => {
    queueResult([contractRow({ status: 'active', nextBillingAt: null })]);
    await expect(svc.addContractLineToContract('c1', BLOCK_INPUT, actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 409 });
    expect((db as unknown as Chain).values.mock.calls).toHaveLength(0);
  });

  it('writes NULL block columns for every other line type', async () => {
    queueResult([contractRow({ status: 'draft' })]);
    queueResult([{ id: 'l1', contractId: 'c1', orgId: 'org1' }]);
    await svc.addContractLineToContract('c1', { lineType: 'flat', description: 'x', unitPrice: '5.00', taxable: false } as never, actor);
    expect((db as unknown as Chain).values.mock.calls[0]![0]).toMatchObject({
      rolloverPolicy: null, rolloverCapHours: null, hourBlockAlertPct: null,
      hourBlockFirstPeriodStart: null, hourBlockRetiredAt: null,
    });
  });

  it('maps a 23505 on the live-block index to 409 HOUR_BLOCK_EXISTS (driver and Drizzle-wrapped shapes)', async () => {
    for (const err of [
      { code: '23505', constraint_name: 'contract_lines_one_live_hour_block_per_org_uq' },
      { cause: { code: '23505', constraint_name: 'contract_lines_one_live_hour_block_per_org_uq' } },
    ]) {
      results.length = 0;
      queueResult([contractRow({ status: 'draft' })]);
      queueError(err);
      await expect(svc.addContractLineToContract('c1', BLOCK_INPUT, actor))
        .rejects.toMatchObject({ code: 'HOUR_BLOCK_EXISTS', status: 409 });
    }
  });

  it('does NOT swallow a 23505 on any other constraint', async () => {
    queueResult([contractRow({ status: 'draft' })]);
    queueError({ code: '23505', constraint_name: 'contract_lines_pkey' });
    await expect(svc.addContractLineToContract('c1', BLOCK_INPUT, actor))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('rejects an overage price the contract currency cannot represent (before any insert)', async () => {
    queueResult([contractRow({ currencyCode: 'JPY' })]);
    await expect(svc.addContractLineToContract('c1', { ...(BLOCK_INPUT as object), unitPrice: '1000', overageUnitPrice: '150.50' } as never, actor))
      .rejects.toMatchObject({ code: 'PRICE_NOT_REPRESENTABLE', status: 400 });
    expect((db as unknown as Chain).values.mock.calls).toHaveLength(0);
  });

  it('is a typed 400 (not a DB error) when an internal caller omits the rollover policy', async () => {
    queueResult([contractRow({ status: 'draft' })]);
    await expect(svc.addContractLineToContract('c1', { ...(BLOCK_INPUT as object), rolloverPolicy: undefined } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 400 });
    expect((db as unknown as Chain).values.mock.calls).toHaveLength(0);
  });
});

describe('activateContract — re-stamps a draft block to the period activation claims (#4547 W03, index C9)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const asOf = new Date('2026-06-15T12:00:00Z');
  const lineStamps = () => (db as unknown as Chain).set.mock.calls.map((c) => c[0] as Record<string, unknown>)
    .filter((v) => 'hourBlockFirstPeriodStart' in v);

  it.each([
    // [timing, startDate, expected first_period_start, why]
    ['advance', '2026-06-01', '2026-06-01', 'activation mid-June claims June immediately, WITH the fee -> June counts'],
    ['arrears', '2026-06-01', '2026-06-01', 'arrears claims June at its end with the fee -> June counts (the period in progress)'],
    ['advance', '2026-09-01', '2026-09-01', 'a draft that has not started yet: its first period'],
    ['arrears', '2026-09-01', '2026-09-01', 'same, arrears'],
    ['advance', '2026-01-01', '2026-06-01', 'long-past start date: June is the period activation claims, not January'],
    ['arrears', '2026-01-01', '2026-06-01', 'same, arrears'],
  ])('%s, start %s -> first period %s (%s)', async (billingTiming, startDate, expected) => {
    queueResult([contractRow({ status: 'draft', billingTiming, startDate, nextBillingAt: null })]); // lockContract
    queueResult([{ id: 'b1', lineType: 'hour_block' }, { id: 'f1', lineType: 'flat' }]);          // line ids
    queueResult([]);                                                                              // re-stamp update
    queueResult([contractRow({ status: 'active' })]);                                             // contracts update returning
    await svc.activateContract('c1', actor, asOf);
    expect(lineStamps()).toEqual([{ hourBlockFirstPeriodStart: expected }]);
  });

  it('touches no lines when the contract has no block line (no extra query)', async () => {
    queueResult([contractRow({ status: 'draft', nextBillingAt: null })]);
    queueResult([{ id: 'f1', lineType: 'flat' }]);
    queueResult([contractRow({ status: 'active' })]);
    await svc.activateContract('c1', actor, asOf);
    expect(lineStamps()).toEqual([]);
  });

  it('NEVER re-stamps on a paused -> active resume: periods already claimed must stay closable', async () => {
    queueResult([contractRow({ status: 'paused', nextBillingAt: null })]);
    queueResult([{ id: 'b1', lineType: 'hour_block' }]);
    queueResult([contractRow({ status: 'active' })]);
    await svc.activateContract('c1', actor, asOf);
    expect(lineStamps()).toEqual([]);
  });
});

describe('createContractWithLinesDetailed — the quote path rejects hour_block (#4547 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it('rejects BEFORE the contract row is inserted, so no orphan draft is left behind', async () => {
    await expect(svc.createContractWithLinesDetailed({
      partnerId: 'p1', orgId: 'org1', name: 'From quote', billingTiming: 'advance', intervalMonths: 1,
      startDate: '2026-06-01', currencyCode: 'USD',
      lines: [{ lineType: 'hour_block', description: 'x', unitPrice: '1.00', taxable: false }],
    } as never)).rejects.toMatchObject({ code: 'INVALID_STATE', status: 400 });
    expect((db as unknown as Chain).values.mock.calls).toHaveLength(0);
  });
});

describe('estimate and MRR count the block fee once and never hours (#4547 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const blockLine = (over: Record<string, unknown> = {}) => ({
    id: 'b1', contractId: 'c1', orgId: 'org1', lineType: 'hour_block', description: 'Support block',
    unitPrice: '1000.00', taxable: false, catalogItemId: null, manualQuantity: null, siteId: null, deviceRoles: null,
    deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00',
    rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: null,
    hourBlockFirstPeriodStart: '2026-06-01', hourBlockRetiredAt: null, ...over,
  });

  it('computeContractEstimate: the block line is quantity 1, no allowance, no overage; period total is the fee only', async () => {
    queueResult([contractRow({ status: 'active' })]);              // getOwnedContractOr404
    queueResult([blockLine()]);                                     // lines
    const out = await svc.computeContractEstimate('c1', actor, undefined, { includeHourBlock: false });
    expect(out.lines[0]).toMatchObject({
      lineType: 'hour_block', quantity: 1, value: '1000.00', counted: 1, included: null, overage: 0,
      overageMode: null, overageValue: '0.00', live: false,
    });
    expect(out.periodTotal).toBe('1000.00');
    expect(out.overages).toEqual([]);
    expect(out.hourBlock).toBeNull();
  });

  it('a RETIRED block contributes nothing to the estimate or the contracts list', async () => {
    queueResult([contractRow({ status: 'active' })]);
    queueResult([blockLine({ hourBlockRetiredAt: new Date('2026-07-01T00:00:00Z') })]);
    const out = await svc.computeContractEstimate('c1', actor, undefined, { includeHourBlock: false });
    expect(out.lines[0]).toMatchObject({ quantity: 0, value: '0.00' });
    expect(out.periodTotal).toBe('0.00');
  });

  it('summarizeActiveContractMrrByOrg counts the fee once per period and never hours; a retired block counts zero', async () => {
    for (const [line, expected] of [[blockLine(), '1000.00'], [blockLine({ hourBlockRetiredAt: new Date('2026-07-01T00:00:00Z') }), '0.00']] as const) {
      results.length = 0;
      queueResult([{ id: 'c1', orgId: 'org1', status: 'active', currencyCode: 'USD', intervalMonths: 1, endDate: null, nextBillingAt: '2026-07-01', billingTiming: 'advance' }]);
      queueResult([line]);
      const out = await svc.summarizeActiveContractMrrByOrg(['org1'], new Date('2026-06-20T00:00:00Z'));
      const total = out.get('org1')?.find((r) => r.currencyCode === 'USD')?.amount ?? '0.00';
      expect(Number(total)).toBe(Number(expected));
    }
  });
});

describe('updateContractLine — hour_block (#4547 W03)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const blockRow = (over: Record<string, unknown> = {}) => ({
    id: 'b1', contractId: 'c1', orgId: 'org1', lineType: 'hour_block', description: 'Support block',
    unitPrice: '1000.00', taxable: false, catalogItemId: null, manualQuantity: null, siteId: null, siteName: null,
    deviceRoles: null, deviceGroupId: null, deviceGroupName: null, sortOrder: 0,
    includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00',
    rolloverPolicy: 'carry_forward', rolloverCapHours: '4.00', hourBlockAlertPct: 80,
    hourBlockFirstPeriodStart: '2026-07-01', hourBlockRetiredAt: null, ...over,
  });
  const lockAndRead = (line: Record<string, unknown>) => { queueResult([contractRow()]); queueResult([line]); };

  it.each([
    ['siteId', { siteId: '22222222-2222-4222-8222-222222222222' }],
    ['siteId (null)', { siteId: null }],
    ['deviceRoles', { deviceRoles: ['server'] }],
    ['deviceGroupId', { deviceGroupId: '22222222-2222-4222-8222-222222222222' }],
    ['manualQuantity', { manualQuantity: '1.00' }],
    ["overageMode 'flag'", { overageMode: 'flag' }],
    ['overageMode null', { overageMode: null }],
  ])('locks %s on a block', async (_name, patch) => {
    lockAndRead(blockRow());
    await expect(svc.updateContractLine('c1', 'b1', patch as never, actor))
      .rejects.toMatchObject({ code: 'HOUR_BLOCK_FIELD_LOCKED', status: 400 });
    expect((db as unknown as Chain).set.mock.calls).toHaveLength(0);
  });

  it("allows overageMode 'bill' re-sent unchanged (a form echoing the current value)", async () => {
    lockAndRead(blockRow());
    queueResult([blockRow({ description: 'Renamed' })]); // update returning (withLineRefs runs no query: no site/group ids)
    await svc.updateContractLine('c1', 'b1', { overageMode: 'bill', description: 'Renamed' } as never, actor);
    expect((db as unknown as Chain).set.mock.calls[0]![0]).toMatchObject({ description: 'Renamed', overageMode: 'bill' });
  });

  it('refuses every patch of a RETIRED block', async () => {
    lockAndRead(blockRow({ hourBlockRetiredAt: new Date('2026-07-10T00:00:00Z') }));
    await expect(svc.updateContractLine('c1', 'b1', { description: 'x' } as never, actor))
      .rejects.toMatchObject({ code: 'HOUR_BLOCK_FIELD_LOCKED', status: 400 });
    expect((db as unknown as Chain).set.mock.calls).toHaveLength(0);
  });

  it('persists the block columns and the audit records names AND before/after for them (Open Decision 15)', async () => {
    lockAndRead(blockRow());
    queueResult([blockRow({ includedQuantity: '12.00', rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: 90 })]);
    const { audit } = await svc.updateContractLine('c1', 'b1',
      { includedQuantity: '12', rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: 90 } as never, actor);
    expect((db as unknown as Chain).set.mock.calls[0]![0]).toMatchObject({
      includedQuantity: '12', rolloverPolicy: 'none', rolloverCapHours: null, hourBlockAlertPct: 90,
    });
    expect(audit.changedFields).toEqual(expect.arrayContaining(['includedQuantity', 'rolloverPolicy', 'rolloverCapHours', 'hourBlockAlertPct']));
    expect(audit.changedFields).not.toContain('description');
    expect(audit.blockChanges).toEqual({
      includedQuantity: { before: '10.00', after: '12.00' },
      rolloverPolicy: { before: 'carry_forward', after: 'none' },
      rolloverCapHours: { before: '4.00', after: null },
      hourBlockAlertPct: { before: 80, after: 90 },
    });
    // the shared audit-detail builder carries it to every door (HTTP, partner API, AI)
    expect(svc.contractLineAuditDetails(audit)).toMatchObject({ blockChanges: audit.blockChanges });
  });

  it('a non-block edit carries no blockChanges (audit payloads for other lines are unchanged)', async () => {
    lockAndRead({ ...blockRow(), lineType: 'flat', includedQuantity: null, overageMode: null, overageUnitPrice: null, rolloverPolicy: null, rolloverCapHours: null, hourBlockAlertPct: null, hourBlockFirstPeriodStart: null });
    queueResult([{ ...blockRow(), lineType: 'flat', description: 'Renamed', includedQuantity: null, overageMode: null, overageUnitPrice: null, rolloverPolicy: null, rolloverCapHours: null, hourBlockAlertPct: null, hourBlockFirstPeriodStart: null }]);
    const { audit } = await svc.updateContractLine('c1', 'b1', { description: 'Renamed' } as never, actor);
    expect(audit).not.toHaveProperty('blockChanges');
  });

  it('a switch to rollover none that leaves the cap set is a 400 INVALID_LINE_PATCH naming the cap', async () => {
    lockAndRead(blockRow());
    await expect(svc.updateContractLine('c1', 'b1', { rolloverPolicy: 'none' } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400, details: { issues: expect.arrayContaining([expect.objectContaining({ path: 'rolloverCapHours' })]) } });
  });

  it('block fields on a non-block line are INVALID_LINE_PATCH, not a silent write', async () => {
    lockAndRead({ ...blockRow(), lineType: 'flat', includedQuantity: null, overageMode: null, overageUnitPrice: null, rolloverPolicy: null, rolloverCapHours: null, hourBlockAlertPct: null, hourBlockFirstPeriodStart: null });
    await expect(svc.updateContractLine('c1', 'b1', { rolloverPolicy: 'none' } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
  });

  it('clearing the included hours is INVALID_LINE_PATCH (the DB twin would reject the row)', async () => {
    lockAndRead(blockRow());
    await expect(svc.updateContractLine('c1', 'b1', { includedQuantity: null, overageUnitPrice: null } as never, actor))
      .rejects.toMatchObject({ code: 'INVALID_LINE_PATCH', status: 400 });
  });
});
