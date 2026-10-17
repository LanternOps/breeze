import { describe, it, expect, vi, beforeEach } from 'vitest';

type Queued = { rows: unknown[] };
const results: Queued[] = [];
const queueResult = (rows: unknown[]) => results.push({ rows });
const ctxMock = vi.hoisted(() => ({ getCurrentDbAccessContext: vi.fn() }));

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(results.shift()?.rows ?? []);
  return { db: chain, getCurrentDbAccessContext: ctxMock.getCurrentDbAccessContext };
});

import { computeOpenHourBlockPeriod, openPeriodFor, buildHourBlockEstimate } from './contractHourBlockEstimate';

describe('openPeriodFor (index C9)', () => {
  it.each([
    ['2026-06-01', '2026-06-01', '2026-06-15', '2026-06-01', '2026-07-01'],   // contract-aligned block, mid-period
    ['2026-06-01', '2026-07-01', '2026-06-15', '2026-07-01', '2026-08-01'],   // block added mid-period: not yet counting
    ['2026-06-01', '2026-07-01', '2026-07-01', '2026-07-01', '2026-08-01'],   // first counted day
    ['2026-06-01', '2026-06-01', '2026-09-30', '2026-09-01', '2026-10-01'],   // a later period
  ])('start %s first %s today %s -> [%s, %s)', (startDate, firstPeriodStart, today, ps, pe) => {
    expect(openPeriodFor({ startDate, intervalMonths: 1, firstPeriodStart, today })).toEqual({ periodStart: ps, periodEnd: pe });
  });
});

describe('buildHourBlockEstimate', () => {
  const line = {
    id: 'b1', includedQuantity: '10.00', overageUnitPrice: '150.00', rolloverPolicy: 'none',
    rolloverCapHours: null as string | null, hourBlockAlertPct: 80 as number | null,
  };
  const contract = { currencyCode: 'USD', billingTiming: 'advance' as const };
  const period = { periodStart: '2026-09-01', periodEnd: '2026-10-01' };
  const entry = (minutes: number, over: Record<string, unknown> = {}) => ({ minutes, isApproved: true, currencyCode: 'USD', ...over });
  const build = (entries: ReturnType<typeof entry>[], over: Record<string, unknown> = {}) =>
    buildHourBlockEstimate({ line, contract, period, carriedInHours: 0, entries, lateEntryMinutes: [], ...over } as never);

  it('6.5 of 10 used: 3.5 remaining, no overage', () => {
    expect(build([entry(390)])).toMatchObject({
      lineId: 'b1', periodStart: '2026-09-01', periodEnd: '2026-10-01', includedHours: 10, carriedInHours: 0,
      consumedHours: 6.5, remainingHours: 3.5, overageHours: 0, overageValue: '0.00',
      overageUnitPrice: '150.00', alertPct: 80, billingTiming: 'advance',
    });
  });

  it('12 of 10 used: 2 hours over, priced at the contract rate, nothing remaining', () => {
    expect(build([entry(720)])).toMatchObject({ consumedHours: 12, remainingHours: 0, overageHours: 2, overageValue: '300.00' });
  });

  it('carried-in hours extend the opening balance', () => {
    expect(build([entry(720)], { carriedInHours: 3 })).toMatchObject({ carriedInHours: 3, consumedHours: 12, remainingHours: 1, overageHours: 0 });
  });

  it('rounds each entry to 2dp BEFORE summing: three 20-minute entries are 0.99 h, not 1.00', () => {
    expect(build([entry(20), entry(20), entry(20)]).consumedHours).toBe(0.99);
  });

  it('unapproved is a subset of consumed; mixed-currency hours still draw and are flagged', () => {
    const out = build([entry(60, { isApproved: false }), entry(30), entry(90, { currencyCode: 'EUR' })]);
    expect(out).toMatchObject({ consumedHours: 3, unapprovedHours: 1, foreignCurrencyHours: 1.5 });
  });

  it('an entry with no currency counts as foreign, exactly as the period close counts it', () => {
    expect(build([entry(60, { currencyCode: null }), entry(60)]).foreignCurrencyHours).toBe(1);
  });

  it('late-entry hours are summed from the closed-period minutes', () => {
    expect(build([], { lateEntryMinutes: [90, 30] }).lateEntryHours).toBe(2);
  });

  it('an arrears contract reports its timing (drives the "bills next invoice" note)', () => {
    expect(build([], { contract: { currencyCode: 'USD', billingTiming: 'arrears' } }).billingTiming).toBe('arrears');
  });
});

describe('computeOpenHourBlockPeriod — context guard (partner-axis trap)', () => {
  beforeEach(() => { results.length = 0; vi.clearAllMocks(); });
  const contract = { id: 'c1', orgId: 'org1', partnerId: 'p1', startDate: '2026-06-01', intervalMonths: 1, billingTiming: 'advance', currencyCode: 'USD' } as never;
  const line = {
    id: 'b1', lineType: 'hour_block', includedQuantity: '10.00', overageUnitPrice: '150.00', rolloverPolicy: 'none',
    rolloverCapHours: null, hourBlockAlertPct: null, hourBlockFirstPeriodStart: '2026-06-01', hourBlockRetiredAt: null,
  } as never;

  it.each([
    ['no context', undefined],
    ['organization scope', { scope: 'organization', orgId: 'org1', accessibleOrgIds: ['org1'], accessiblePartnerIds: [] }],
    ['a different partner', { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: ['other'] }],
  ])('fails closed under %s instead of returning zero hours', async (_name, ctx) => {
    ctxMock.getCurrentDbAccessContext.mockReturnValue(ctx);
    await expect(computeOpenHourBlockPeriod(contract, line, new Date('2026-06-15T00:00:00Z')))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 500 });
  });

  it.each([
    ['system scope', { scope: 'system', orgId: null, accessibleOrgIds: null }],
    ['the owning partner', { scope: 'partner', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: ['p1'] }],
  ])('reads under %s', async (_name, ctx) => {
    ctxMock.getCurrentDbAccessContext.mockReturnValue(ctx);
    queueResult([{ carriedOut: '2.00' }]); // last ledger row
    queueResult([{ minutes: 60, isApproved: true, currencyCode: 'USD' }]); // open-period entries
    queueResult([]);                       // late entries
    const out = await computeOpenHourBlockPeriod(contract, line, new Date('2026-06-15T00:00:00Z'));
    expect(out).toMatchObject({ periodStart: '2026-06-01', periodEnd: '2026-07-01', carriedInHours: 2, consumedHours: 1, remainingHours: 11 });
  });

  it('is a typed 500 for an incomplete block row rather than a NaN estimate', async () => {
    ctxMock.getCurrentDbAccessContext.mockReturnValue({ scope: 'system', orgId: null, accessibleOrgIds: null });
    await expect(computeOpenHourBlockPeriod(contract, { ...(line as object), includedQuantity: null } as never))
      .rejects.toMatchObject({ code: 'INVALID_STATE', status: 500 });
  });
});
