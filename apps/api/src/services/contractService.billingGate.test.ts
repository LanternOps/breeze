vi.mock('./autopay/autopayGate', () => ({ isAutopayEnabledForPartner: vi.fn().mockResolvedValue(false) }));
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Partner billing master switch (partners.billing_enabled) on the contract
 * WRITE services: with billing off every gated function answers 404
 * BILLING_DISABLED and writes nothing; with billing on it proceeds past the gate.
 * The gate itself is covered by contractBillingGate.test.ts, so it is mocked here.
 */
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
  return {
    db: makeChain(),
    assertInTransaction: vi.fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('./contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./invoiceService', () => ({ createManualInvoice: vi.fn(), addContractLine: vi.fn(), deleteDraftInvoice: vi.fn() }));
vi.mock('./contractQuantities', () => ({
  countContractDevices: vi.fn().mockResolvedValue(0), countContractSeats: vi.fn().mockResolvedValue(0),
  snapshotContractDevices: vi.fn().mockResolvedValue([]), groupMembersForBilling: vi.fn().mockResolvedValue([]),
}));
vi.mock('./contractBillingGate', () => ({ assertContractBillingEnabled: vi.fn() }));

import * as svc from './contractService';
import { db } from '../db';
import { assertContractBillingEnabled } from './contractBillingGate';
import { ContractServiceError } from './contractTypes';

const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
const contractRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1', orgId: 'org1', partnerId: 'p1', name: 'C1', status: 'draft',
  billingTiming: 'advance', intervalMonths: 1, startDate: '2026-01-01', endDate: null,
  nextBillingAt: null, autoIssue: false, autoRenew: false, renewalTermMonths: null,
  renewalNoticeDays: null, currencyCode: 'USD', notes: null, terms: null,
  createdBy: 'u1', createdAt: new Date(), updatedAt: new Date(), ...over,
});
const disabled = () => new ContractServiceError('Not found', 404, 'BILLING_DISABLED');
const writes = () => ['insert', 'update', 'delete'].reduce(
  (n, m) => n + (db as unknown as Record<string, { mock: { calls: unknown[] } }>)[m]!.mock.calls.length, 0);

const cases: Array<[string, () => Promise<unknown>, unknown[][]]> = [
  ['createContract', () => svc.createContract({ orgId: 'org1', name: 'n', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-01-01' }, actor), []],
  ['updateContract', () => svc.updateContract('c1', { name: 'x' }, actor), [[contractRow()]]],
  ['deleteDraftContract', () => svc.deleteDraftContract('c1', actor), [[contractRow()]]],
  ['changeContractCurrency', () => svc.changeContractCurrency('c1', { currencyCode: 'EUR' }, actor), [[contractRow()]]],
  ['addContractLineToContract', () => svc.addContractLineToContract('c1', { lineType: 'manual', description: 'd', manualQuantity: 1, unitPrice: 1 } as never, actor), [[contractRow()]]],
  ['updateContractLine', () => svc.updateContractLine('c1', 'l1', { description: 'x' } as never, actor), [[contractRow()]]],
  ['removeContractLine', () => svc.removeContractLine('c1', 'l1', actor), [[contractRow()]]],
  ['activateContract', () => svc.activateContract('c1', actor), [[contractRow()]]],
  ['generateDueInvoice', () => svc.generateDueInvoice('c1', new Date('2026-06-01')), [[contractRow({ status: 'active', nextBillingAt: '2026-01-01' })]]],
  ['createContractWithLinesDetailed', () => svc.createContractWithLinesDetailed({
    partnerId: 'p1', orgId: 'org1', name: 'n', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-01-01', currencyCode: 'USD', lines: [],
  } as never), []],
];

describe('contractService billing master switch', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });

  it.each(cases)('%s answers 404 BILLING_DISABLED with billing off and writes nothing', async (_name, run, queued) => {
    for (const q of queued) queueResult(q);
    (assertContractBillingEnabled as ReturnType<typeof vi.fn>).mockRejectedValueOnce(disabled());
    await expect(run()).rejects.toMatchObject({ status: 404, code: 'BILLING_DISABLED' });
    expect(assertContractBillingEnabled).toHaveBeenCalledWith('org1');
    expect(writes()).toBe(0);
  });

  it('generateDueInvoice leaves a not-due contract a quiet no-op (gate is after the not_due returns)', async () => {
    queueResult([contractRow({ status: 'active', nextBillingAt: '2027-01-01' })]);
    const out = await svc.generateDueInvoice('c1', new Date('2026-06-01'));
    expect(out).toMatchObject({ generated: false, skipped: 'not_due' });
    expect(assertContractBillingEnabled).not.toHaveBeenCalled();
  });

  it('with billing on, createContract passes the gate and proceeds to the write', async () => {
    queueResult([{ currencyCode: 'USD' }]); // lock org stamping defaults (shape not important: any throw after the gate is fine)
    await svc.createContract({ orgId: 'org1', name: 'n', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-01-01' }, actor).catch(() => undefined);
    expect(assertContractBillingEnabled).toHaveBeenCalledWith('org1');
    expect((db as unknown as { transaction: { mock: { calls: unknown[] } } }).transaction.mock.calls.length).toBeGreaterThan(0);
  });

  // Spec §7.2: these keep working with billing off, so the service must never
  // consult the gate (outcome is irrelevant here, only that no gate call happens).
  it.each([
    ['pauseContract', () => svc.pauseContract('c1', actor)],
    ['resumeContract', () => svc.resumeContract('c1', actor)],
    ['cancelContract', () => svc.cancelContract('c1', actor)],
    ['getContract', () => svc.getContract('c1', actor)],
    ['listContracts', () => svc.listContracts({ limit: 10 } as never, actor)],
  ])('%s stays open with billing off (gate never consulted)', async (_n, run) => {
    queueResult([contractRow({ status: 'active' })]);
    (assertContractBillingEnabled as ReturnType<typeof vi.fn>).mockRejectedValue(disabled());
    await run().catch(() => undefined);
    expect(assertContractBillingEnabled).not.toHaveBeenCalled();
  });
});
