import { describe, it, expect, vi, beforeEach } from 'vitest';

// #9828 W1: the partner-dashboard MRR rollup moved out of contractService.ts
// onto per-contract rows (resolveContractMrrRows). The CHARACTERIZATION suite
// below was recorded against the pre-move code and must stay byte-identical: the
// dashboard figure is not allowed to change in an extraction.

// Controllable Drizzle chain mock (same pattern as contractService.test.ts):
// every awaited query consumes the next queued result, in call order.
type QueuedQuery = { rows: unknown[] } | { error: unknown };
const results: QueuedQuery[] = [];
function queueResult(rows: unknown[]) { results.push({ rows }); }

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
    db,
    assertInTransaction: vi.fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('./autopay/autopayGate', () => ({ isAutopayEnabledForPartner: vi.fn().mockResolvedValue(false) }));
vi.mock('./contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./invoiceService', () => ({
  createManualInvoice: vi.fn(), addContractLine: vi.fn(), deleteDraftInvoice: vi.fn(),
}));
vi.mock('./contractQuantities', () => ({
  countContractDevices: vi.fn(), countContractSeats: vi.fn(), snapshotContractDevices: vi.fn(), groupMembersForBilling: vi.fn(),
}));

import { summarizeActiveContractMrrByOrg, resolveContractMrrRows } from './contractMrr';
import { db } from '../db';
import { countContractSeats, snapshotContractDevices, groupMembersForBilling } from './contractQuantities';
import { GroupEvaluationError } from './groupMembership';

const selectCalls = () => (db as unknown as { select: { mock: { calls: unknown[][] } } }).select.mock.calls.length;

export const contract = (over: Record<string, unknown> = {}) => ({
  id: 'c1', orgId: 'org1', partnerId: 'p1', name: 'Managed services', status: 'active', currencyCode: 'USD',
  intervalMonths: 1, billingTiming: 'advance', startDate: '2025-01-01', endDate: null, nextBillingAt: '2026-07-01',
  autoRenew: false, renewalTermMonths: null, ...over,
});
export const line = (over: Record<string, unknown> = {}) => ({
  id: 'l1', contractId: 'c1', orgId: 'org1', lineType: 'flat', description: 'Line', unitPrice: '100.00',
  manualQuantity: null, siteId: null, siteName: null, deviceRoles: null, deviceGroupId: null, deviceGroupName: null,
  catalogItemId: null, includedQuantity: null, overageMode: null, overageUnitPrice: null,
  hourBlockRetiredAt: null, ...over,
});
const annual = (over: Record<string, unknown> = {}) => contract({
  status: 'expired', billingTiming: 'advance', intervalMonths: 12,
  startDate: '2026-01-01', endDate: '2027-01-01', nextBillingAt: null, ...over,
});
const group = { id: 'group-1', orgId: 'org1', name: 'Servers', type: 'static', siteId: null, filterConditions: null };
const MID_TERM = new Date('2026-06-15T12:00:00.000Z');
const DEVICES = Array.from({ length: 27 }, (_, i) => ({ id: `d${i}`, hostname: `d${i}`, role: 'workstation', siteId: null }));

interface Fixture {
  name: string;
  orgIds: string[];
  asOf: Date;
  queue: unknown[][];
  setup?: () => void;
  expected: [string, { currencyCode: string; amount: string }[]][];
}

export const FIXTURES: Fixture[] = [
  {
    name: 'healthy flat monthly',
    orgIds: ['org1'], asOf: MID_TERM,
    queue: [[contract()], [line({ unitPrice: '50.00' })]],
    expected: [['org1', [{ currencyCode: 'USD', amount: '50.00' }]]],
  },
  {
    name: 'per_device with a billed allowance overage, quarterly',
    orgIds: ['org1'], asOf: MID_TERM,
    setup: () => vi.mocked(snapshotContractDevices).mockResolvedValue(DEVICES as never),
    queue: [[contract({ intervalMonths: 3 })], [line({
      lineType: 'per_device', unitPrice: '10.00', includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.34',
    })]],
    expected: [['org1', [{ currencyCode: 'USD', amount: '91.56' }]]],
  },
  {
    name: 'hour_block fee once per period (live), retired block zero',
    orgIds: ['org1', 'org2'], asOf: MID_TERM,
    queue: [
      [contract(), contract({ id: 'c2', orgId: 'org2' })],
      [
        line({ lineType: 'hour_block', unitPrice: '1000.00', includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00' }),
        line({ id: 'l2', contractId: 'c2', orgId: 'org2', lineType: 'hour_block', unitPrice: '700.00', includedQuantity: '5.00', overageMode: 'bill', overageUnitPrice: '150.00', hourBlockRetiredAt: new Date('2026-06-01T00:00:00Z') }),
      ],
    ],
    expected: [['org1', [{ currencyCode: 'USD', amount: '1000.00' }]], ['org2', [{ currencyCode: 'USD', amount: '0.00' }]]],
  },
  {
    name: 'annual advance contract in its billed final term, beside a live active one',
    orgIds: ['org1'], asOf: MID_TERM,
    queue: [
      [contract({ id: 'c2' }), annual()],
      [{ contractId: 'c1', invoiceId: 'inv1' }],
      [{ id: 'inv1', status: 'paid', replacedByInvoiceId: null }],
      [{ invoiceId: 'inv1', sourceContractId: 'c1', sourceId: 'l1', quantity: '1', unitPrice: '1200.00', lineTotal: '1200.00' }],
      [],
      [line({ id: 'l2', contractId: 'c2', unitPrice: '50.00' })],
    ],
    expected: [['org1', [{ currencyCode: 'USD', amount: '150.00' }]]],
  },
  {
    name: 'voided final-term invoice with no replacement contributes nothing',
    orgIds: ['org1'], asOf: MID_TERM,
    queue: [[annual()], [{ contractId: 'c1', invoiceId: 'inv1' }], [{ id: 'inv1', status: 'void', replacedByInvoiceId: null }]],
    expected: [],
  },
  {
    name: 'broken group filter: the contract is skipped, the healthy one still counts',
    orgIds: ['org1'], asOf: MID_TERM,
    setup: () => vi.mocked(groupMembersForBilling).mockRejectedValue(new GroupEvaluationError('group-1', 'invalid_filter')),
    queue: [
      [contract(), contract({ id: 'c2' })],
      [
        line({ lineType: 'per_device_group', deviceGroupId: 'group-1', deviceGroupName: 'Servers', unitPrice: '10.00' }),
        line({ id: 'l2', contractId: 'c2', unitPrice: '40.00' }),
      ],
      [group],
    ],
    expected: [['org1', [{ currencyCode: 'USD', amount: '40.00' }]]],
  },
  {
    name: 'deleted site: the contract is skipped',
    orgIds: ['org1'], asOf: MID_TERM,
    queue: [[contract()], [line({ lineType: 'per_device', siteId: null, siteName: 'Dallas', unitPrice: '10.00' })]],
    expected: [],
  },
  {
    name: 'deleted group counts 0 beside a priced line',
    orgIds: ['org1'], asOf: MID_TERM,
    queue: [[contract()], [
      line({ lineType: 'per_device_group', deviceGroupId: null, deviceGroupName: 'Retired group', unitPrice: '10.00' }),
      line({ id: 'l2', unitPrice: '25.00' }),
    ]],
    expected: [['org1', [{ currencyCode: 'USD', amount: '25.00' }]]],
  },
  {
    name: 'JPY contract rounds to whole yen before grouping',
    orgIds: ['org1'], asOf: MID_TERM,
    queue: [[contract({ currencyCode: 'JPY', intervalMonths: 3 }), contract({ id: 'c2', currencyCode: 'JPY', intervalMonths: 3 })], [
      line({ unitPrice: '10001' }),
      line({ id: 'l2', contractId: 'c2', unitPrice: '10001' }),
    ]],
    expected: [['org1', [{ currencyCode: 'JPY', amount: '6668.00' }]]],
  },
  {
    name: 'USD and EUR in one org stay two entries; per_seat line live',
    orgIds: ['org1'], asOf: MID_TERM,
    setup: () => vi.mocked(countContractSeats).mockResolvedValue(4),
    queue: [[contract(), contract({ id: 'c2', currencyCode: 'EUR' })], [
      line({ lineType: 'per_seat', unitPrice: '12.50' }),
      line({ id: 'l2', contractId: 'c2', unitPrice: '410.00' }),
    ]],
    expected: [['org1', [{ currencyCode: 'EUR', amount: '410.00' }, { currencyCode: 'USD', amount: '50.00' }]]],
  },
  {
    name: 'catalog line priced through the price book',
    orgIds: ['org1'], asOf: MID_TERM,
    queue: [
      [contract()],
      [line({ catalogItemId: 'item-1', unitPrice: '10.00' })],
      [],
      [{ itemId: 'item-1', currencyCode: 'USD', unitPrice: '42.00' }],
    ],
    expected: [['org1', [{ currencyCode: 'USD', amount: '42.00' }]]],
  },
  {
    name: 'active contracts not in term are left out (future start, ended arrears, past billing end)',
    orgIds: ['org1'], asOf: MID_TERM,
    queue: [
      [
        contract({ id: 'cf', startDate: '2026-07-01' }),
        contract({ id: 'ce', billingTiming: 'arrears', startDate: '2025-06-01', endDate: '2026-06-01', nextBillingAt: '2026-07-01' }),
        contract({ id: 'cu', intervalMonths: 12, startDate: '2025-09-01', endDate: '2026-09-01', nextBillingAt: '2026-09-01' }),
      ],
      [],
    ],
    expected: [],
  },
];

describe('summarizeActiveContractMrrByOrg characterization (#9828 W1)', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
    vi.mocked(countContractSeats).mockResolvedValue(0);
    vi.mocked(snapshotContractDevices).mockResolvedValue([]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))('%s', async (_name, f) => {
    f.setup?.();
    for (const rows of f.queue) queueResult(rows);
    const out = await summarizeActiveContractMrrByOrg(f.orgIds, f.asOf);
    expect([...out.entries()]).toEqual(f.expected);
    expect(results.length).toBe(0); // every queued query was consumed — same query sequence
  });

  it('returns an empty map without querying when no org ids are given', async () => {
    const out = await summarizeActiveContractMrrByOrg([]);
    expect(out.size).toBe(0);
    expect(selectCalls()).toBe(0);
  });
});

/** Every bound parameter value inside a Drizzle SQL/condition tree. */
function collectParams(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (node === null || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { for (const c of node) collectParams(c, out, seen); return out; }
  for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'value') {
      if (Array.isArray(child)) out.push(...child.filter((v) => typeof v !== 'object'));
      else if (child !== null && typeof child !== 'object') out.push(child);
    }
    if (child && typeof child === 'object') collectParams(child, out, seen);
  }
  return out;
}
const firstWhereParams = () =>
  collectParams((db as unknown as { where: { mock: { calls: unknown[][] } } }).where.mock.calls[0]![0]);

describe('resolveContractMrrRows (#9828 W1)', () => {
  beforeEach(() => {
    results.length = 0;
    vi.clearAllMocks();
    vi.mocked(countContractSeats).mockResolvedValue(0);
    vi.mocked(snapshotContractDevices).mockResolvedValue([]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('summarize parity over resolveContractMrrRows', async () => {
    for (const f of FIXTURES) {
      results.length = 0;
      vi.mocked(snapshotContractDevices).mockResolvedValue([]);
      vi.mocked(countContractSeats).mockResolvedValue(0);
      f.setup?.();
      for (const rows of f.queue) queueResult(rows);
      const r = await resolveContractMrrRows(f.orgIds, f.asOf);
      // Fold the rows the way the dashboard does and compare with the recorded map.
      const folded = new Map<string, Map<string, number>>();
      for (const row of r.rows) {
        const per = folded.get(row.orgId) ?? new Map<string, number>();
        per.set(row.currencyCode, (per.get(row.currencyCode) ?? 0) + Number(row.mrr));
        folded.set(row.orgId, per);
      }
      const expected = new Map(f.expected.map(([org, list]) => [org, new Map(list.map((e) => [e.currencyCode, Number(e.amount)]))]));
      expect(folded, f.name).toEqual(expected);
    }
  });

  it('partnerId binds contracts.partner_id even when orgIds is poisoned', async () => {
    queueResult([]);
    await resolveContractMrrRows(['org1', 'foreign-org'], MID_TERM, { partnerId: 'p1' });
    const params = firstWhereParams();
    expect(params).toContain('p1');
    expect(params).toContain('foreign-org');

    vi.clearAllMocks();
    queueResult([]);
    await resolveContractMrrRows(['org1'], MID_TERM);
    expect(firstWhereParams()).not.toContain('p1');
  });

  it('a healthy active contract resolves to one row with the full shape', async () => {
    queueResult([contract({ autoRenew: true, renewalTermMonths: 12, endDate: '2026-12-31' })]);
    queueResult([line({ unitPrice: '50.00' })]);
    const r = await resolveContractMrrRows(['org1'], MID_TERM);
    expect(r.rows).toEqual([{
      contractId: 'c1', orgId: 'org1', name: 'Managed services', status: 'active', basis: 'active',
      currencyCode: 'USD', intervalMonths: 1, baseMonthly: '50.00', overageMonthly: '0.00', mrr: '50.00',
      startDate: '2025-01-01', endDate: '2026-12-31', autoRenew: true, renewalTermMonths: 12, unresolvedGroup: false,
    }]);
    expect(r.skipped).toEqual([]);
    expect(r.activeNotInTerm).toEqual([]);
  });

  it('broken group filter lands in skipped, not dropped (T3)', async () => {
    vi.mocked(groupMembersForBilling).mockRejectedValue(new GroupEvaluationError('group-1', 'invalid_filter'));
    queueResult([contract({ id: 'broken', name: 'Broken' }), contract({ id: 'c2' })]);
    queueResult([
      line({ contractId: 'broken', lineType: 'per_device_group', deviceGroupId: 'group-1', deviceGroupName: 'Servers' }),
      line({ id: 'l2', contractId: 'c2', unitPrice: '40.00' }),
    ]);
    queueResult([group]);
    const r = await resolveContractMrrRows(['org1'], MID_TERM);
    expect(r.skipped).toEqual([{ contractId: 'broken', orgId: 'org1', name: 'Broken', status: 'active', reason: 'group_evaluation_failed' }]);
    expect(r.rows.map((x) => x.contractId)).toEqual(['c2']);
    expect(console.warn).toHaveBeenCalledWith('[contracts] MRR rollup skipped contract %s: %s', 'broken', expect.any(String));
  });

  it('a deleted site lands in skipped with site_deleted', async () => {
    queueResult([contract()]);
    queueResult([line({ lineType: 'per_device', siteId: null, siteName: 'Dallas' })]);
    const r = await resolveContractMrrRows(['org1'], MID_TERM);
    expect(r.skipped).toEqual([expect.objectContaining({ contractId: 'c1', reason: 'site_deleted' })]);
    expect(r.rows).toEqual([]);
  });

  it('voided final-term invoice is skipped with its reason', async () => {
    queueResult([annual()]);
    queueResult([{ contractId: 'c1', invoiceId: 'inv1' }]);
    queueResult([{ id: 'inv1', status: 'void', replacedByInvoiceId: null }]);
    const r = await resolveContractMrrRows(['org1'], MID_TERM);
    expect(r.skipped).toEqual([{ contractId: 'c1', orgId: 'org1', name: 'Managed services', status: 'expired', reason: 'final_term_invoice_voided' }]);
    expect(r.rows).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('final term'), 'c1', 'org1', 'invoice_voided');
  });

  it.each([
    ['invoice_missing', [[{ contractId: 'c1', invoiceId: null }]]],
    ['no_contract_lines', [[{ contractId: 'c1', invoiceId: 'inv1' }], [{ id: 'inv1', status: 'sent', replacedByInvoiceId: null }], [], []]],
    ['reissue_chain_too_long', [
      [{ contractId: 'c1', invoiceId: 'invA' }],
      ...Array.from({ length: 10 }, (_, i) => (i % 2 === 0
        ? [{ id: 'invA', status: 'void', replacedByInvoiceId: 'invB' }]
        : [{ id: 'invB', status: 'void', replacedByInvoiceId: 'invA' }])),
    ]],
  ] as const)('final-term %s is skipped as final_term_<reason>', async (reason, queue) => {
    queueResult([annual()]);
    for (const rows of queue) queueResult([...rows]);
    const r = await resolveContractMrrRows(['org1'], MID_TERM);
    expect(r.skipped.map((s) => s.reason)).toEqual([`final_term_${reason}`]);
  });

  it('deleted group counts 0 and flags unresolvedGroup', async () => {
    queueResult([contract()]);
    queueResult([
      line({ lineType: 'per_device_group', deviceGroupId: null, deviceGroupName: 'Retired group' }),
      line({ id: 'l2', unitPrice: '25.00' }),
    ]);
    const r = await resolveContractMrrRows(['org1'], MID_TERM);
    expect(r.rows).toEqual([expect.objectContaining({ contractId: 'c1', mrr: '25.00', unresolvedGroup: true })]);
  });

  it('base + overage === mrr exactly; billed_final_term overage is null', async () => {
    vi.mocked(snapshotContractDevices).mockResolvedValue(DEVICES as never);
    queueResult([contract({ id: 'c2', intervalMonths: 3 }), annual()]);
    queueResult([{ contractId: 'c1', invoiceId: 'inv1' }]);
    queueResult([{ id: 'inv1', status: 'paid', replacedByInvoiceId: null }]);
    queueResult([{ invoiceId: 'inv1', sourceContractId: 'c1', sourceId: 'l1', quantity: '1', unitPrice: '1000.00', lineTotal: '1000.00' }]);
    queueResult([]);
    queueResult([line({
      id: 'l2', contractId: 'c2', lineType: 'per_device', unitPrice: '10.00',
      includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.34',
    })]);
    const r = await resolveContractMrrRows(['org1'], MID_TERM);
    const live = r.rows.find((x) => x.contractId === 'c2')!;
    expect(live).toMatchObject({ basis: 'active', baseMonthly: '83.33', overageMonthly: '8.23', mrr: '91.56' });
    expect(Math.round(Number(live.baseMonthly) * 100) + Math.round(Number(live.overageMonthly) * 100)).toBe(Math.round(Number(live.mrr) * 100));
    const billed = r.rows.find((x) => x.contractId === 'c1')!;
    expect(billed).toMatchObject({ basis: 'billed_final_term', status: 'expired', baseMonthly: '83.33', overageMonthly: null, mrr: '83.33' });
  });

  it('JPY contract contributes whole yen', async () => {
    queueResult([contract({ currencyCode: 'JPY', intervalMonths: 3 })]);
    queueResult([line({ unitPrice: '10001' })]);
    const r = await resolveContractMrrRows(['org1'], MID_TERM);
    expect(r.rows[0]).toMatchObject({ currencyCode: 'JPY', mrr: '3334.00', baseMonthly: '3334.00', overageMonthly: '0.00' });
  });

  it('paused/draft only when included, never in summarize', async () => {
    queueResult([]);
    await resolveContractMrrRows(['org1'], MID_TERM);
    expect(firstWhereParams()).not.toContain('paused');
    expect(firstWhereParams()).not.toContain('draft');

    vi.clearAllMocks();
    queueResult([contract({ id: 'cp', status: 'paused' }), contract({ id: 'cd', status: 'draft', startDate: '2026-08-01', nextBillingAt: null })]);
    queueResult([line({ contractId: 'cp', unitPrice: '30.00' }), line({ id: 'l2', contractId: 'cd', unitPrice: '20.00' })]);
    const r = await resolveContractMrrRows(['org1'], MID_TERM, { include: ['paused', 'draft'] });
    expect(firstWhereParams()).toEqual(expect.arrayContaining(['paused', 'draft']));
    expect(r.rows.map((x) => [x.contractId, x.basis, x.mrr])).toEqual([['cp', 'paused', '30.00'], ['cd', 'draft', '20.00']]);
    expect(r.activeNotInTerm).toEqual([]);

    // summarize never asks for them: its contract query carries neither status.
    vi.clearAllMocks();
    queueResult([]);
    await summarizeActiveContractMrrByOrg(['org1'], MID_TERM);
    expect(firstWhereParams()).not.toContain('paused');
  });

  it('activeNotInTerm is the complement of the in-term predicate', async () => {
    queueResult([
      contract({ id: 'FUTURE', startDate: '2026-07-01' }),
      contract({ id: 'ENDED', billingTiming: 'arrears', startDate: '2025-06-01', endDate: '2026-06-01', nextBillingAt: '2026-07-01' }),
      contract({ id: 'UNBILLED', intervalMonths: 12, startDate: '2025-09-01', endDate: '2026-09-01', nextBillingAt: '2026-09-01' }),
      contract({ id: 'HEALTHY' }),
      annual({ id: 'FINAL' }),
    ]);
    queueResult([{ contractId: 'FINAL', invoiceId: 'inv1' }]); // only FINAL has a covering billed period
    queueResult([{ id: 'inv1', status: 'paid', replacedByInvoiceId: null }]);
    queueResult([{ invoiceId: 'inv1', sourceContractId: 'FINAL', sourceId: 'l1', quantity: '1', unitPrice: '1200.00', lineTotal: '1200.00' }]);
    queueResult([]);
    queueResult([line({ contractId: 'HEALTHY' })]);
    const r = await resolveContractMrrRows(['org1'], MID_TERM);
    expect(r.activeNotInTerm.map((x) => [x.contractId, x.reason])).toEqual([
      ['FUTURE', 'starts_later'], ['ENDED', 'ended_awaiting_expiry'], ['UNBILLED', 'final_period_not_billed'],
    ]);
    expect(new Set([...r.rows, ...r.activeNotInTerm, ...r.skipped].map((x) => x.contractId)))
      .toEqual(new Set(['FUTURE', 'ENDED', 'UNBILLED', 'HEALTHY', 'FINAL']));
    expect(r.activeNotInTerm[0]).toEqual({ contractId: 'FUTURE', orgId: 'org1', name: 'Managed services', startDate: '2026-07-01', endDate: null, reason: 'starts_later' });
  });
});
