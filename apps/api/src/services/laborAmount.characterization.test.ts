import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #9561 characterisation: the labour rule (minutes → hours rounded to 2 dp →
 * × rate → ONE half-up round at the currency's minor unit) pinned at every
 * JS call site that computes a labour figure. These figures are BY DESIGN
 * (invoice-engine spec 2026-06-14, block-hours "round-first" spec): 25 min at
 * 135.00/h bills 0.42 h = 56.70, not 56.25. The table must pass unchanged
 * before and after the shared-helper consolidation — any diff here is an
 * amount change, which #9561 explicitly forbids.
 *
 * The SQL twins (ticket billing summary, org-currency preflight, technician
 * time report) are pinned against real Postgres in
 * `__tests__/integration/laborAmountSql.integration.test.ts`.
 */

const { queryMocks } = vi.hoisted(() => ({ queryMocks: { results: [] as unknown[][] } }));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => {
      const result = queryMocks.results.shift() ?? [];
      const chain: any = {
        from: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        groupBy: () => chain,
        orderBy: () => chain,
        then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    }),
  },
}));
vi.mock('./timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn() }));
vi.mock('./sensitiveReadAudit', () => ({ auditSensitiveRead: vi.fn() }));

import { getTimesheet, listBillables } from './timeEntryService';
import { partitionTimeEntries, timeEntryToLineSpec } from './invoiceAssembly';
import { entryAmountMinor } from './ticketApproval/gate';
import { entryHours, sumEntryHours } from './contractHourBlocks';

/** [minutes, hours (2 dp), amount at 135.00/h, amount at 100.00/h] */
const TABLE: ReadonlyArray<readonly [number, string, string, string]> = [
  [1, '0.02', '2.70', '2.00'],
  [20, '0.33', '44.55', '33.00'],
  [25, '0.42', '56.70', '42.00'],
  [30, '0.50', '67.50', '50.00'],
  [59, '0.98', '132.30', '98.00'],
  [61, '1.02', '137.70', '102.00'],
];
const CASES = TABLE.flatMap(([minutes, hours, at135, at100]) => [
  { minutes, hours, rate: '135.00', amount: at135 },
  { minutes, hours, rate: '100.00', amount: at100 },
]);
const label = (c: { minutes: number; rate: string }) => `${c.minutes} min at ${c.rate}/h`;

beforeEach(() => { queryMocks.results.length = 0; });

describe('labour rule characterisation (#9561) — amounts must never change', () => {
  it.each(CASES)('invoice line: $minutes min at $rate/h → $hours h, $amount', (c) => {
    const spec = timeEntryToLineSpec({
      id: 'e', ticketId: 't', description: 'Work', durationMinutes: c.minutes, billableMinutes: null,
      hourlyRate: c.rate, isApproved: true, currencyCode: 'USD',
    }, 'USD');
    expect({ quantity: spec.quantity, lineTotal: spec.lineTotal }, label(c)).toEqual({ quantity: c.hours, lineTotal: c.amount });
  });

  it.each(CASES)('invoice line bills billable_minutes over duration: $minutes min at $rate/h', (c) => {
    const spec = timeEntryToLineSpec({
      id: 'e', ticketId: 't', description: 'Work', durationMinutes: 5, billableMinutes: c.minutes,
      hourlyRate: c.rate, isApproved: true, currencyCode: 'USD',
    }, 'USD');
    expect({ quantity: spec.quantity, lineTotal: spec.lineTotal }, label(c)).toEqual({ quantity: c.hours, lineTotal: c.amount });
  });

  it.each(TABLE)('missing-rate gap reports the same rounded hours: %i min → %s h', (minutes, hours) => {
    const result = partitionTimeEntries([{
      id: 'e', ticketId: 't', description: 'Work', durationMinutes: minutes, billableMinutes: null,
      hourlyRate: null, isApproved: true, currencyCode: 'USD',
    }], 'USD');
    expect(result.missingRate.map((m) => m.quantity)).toEqual([hours]);
  });

  it.each(CASES)('approval gate: $minutes min at $rate/h → $amount in minor units', (c) => {
    const minor = entryAmountMinor({ minutes: c.minutes, hourlyRate: c.rate, currencyCode: 'USD' }, 'USD');
    expect(minor, label(c)).toBe(Math.round(Number(c.amount) * 100));
  });

  it.each(TABLE)('hour blocks: %i min → %s h', (minutes, hours) => {
    expect(entryHours(minutes)).toBe(Number(hours));
  });

  it('hour blocks sum per-entry rounded hundredths (never round the sum)', () => {
    // 0.02 + 0.33 + 0.42 + 0.50 + 0.98 + 1.02 = 3.27. Rounding the sum happens to agree
    // there, so three 20-min entries show the difference: 3 × 0.33 = 0.99, not 1.00.
    expect(sumEntryHours(TABLE.map(([m]) => m))).toBe(3.27);
    expect(sumEntryHours([20, 20, 20])).toBe(0.99);
  });

  it.each(CASES)('timesheet total: $minutes min at $rate/h → $amount', async (c) => {
    queryMocks.results.push([{
      id: 'e', startedAt: new Date('2026-09-14T09:00:00Z'), endedAt: new Date('2026-09-14T10:00:00Z'),
      durationMinutes: c.minutes, billableMinutes: null, description: 'Work', isBillable: true,
      hourlyRate: c.rate, currencyCode: 'USD', billingStatus: 'not_billed', isApproved: false,
    }]);
    const sheet = await getTimesheet('user-1', new Date('2026-09-14T00:00:00Z'));
    expect(sheet.totals.billableAmounts, label(c)).toEqual([{ currencyCode: 'USD', amount: c.amount }]);
  });

  it.each(CASES)('billables export: $minutes min at $rate/h → $hours h, $amount', async (c) => {
    queryMocks.results.push([{
      date: new Date('2026-09-14T09:00:00Z'), orgName: 'Customer', ticketNumber: 'T-1', description: 'Work',
      technician: 'Tech', minutes: c.minutes, billableMinutes: null, rate: c.rate, currencyCode: 'USD',
      billingStatus: 'not_billed', isApproved: true, coverage: 'billable', workTypeName: null,
    }], []);
    const result = await listBillables(new Date('2026-09-14T00:00:00Z'), new Date('2026-09-21T00:00:00Z'));
    expect(result.rows.map((r) => ({ quantity: r.quantity, amount: r.amount })), label(c))
      .toEqual([{ quantity: c.hours, amount: c.amount }]);
    expect(result.totalsByCurrency).toEqual([{ currencyCode: 'USD', amount: c.amount }]);
  });

  it('zero-decimal currency: 20 min × 1,000 JPY = 0.33 h × 1000 = 330, never 333', () => {
    const spec = timeEntryToLineSpec({
      id: 'e', ticketId: 't', description: 'Work', durationMinutes: 20, billableMinutes: null,
      hourlyRate: '1000.00', isApproved: true, currencyCode: 'JPY',
    }, 'JPY');
    expect(spec.lineTotal).toBe('330.00');
    expect(entryAmountMinor({ minutes: 20, hourlyRate: '1000.00', currencyCode: 'JPY' }, 'JPY')).toBe(330);
  });
});
