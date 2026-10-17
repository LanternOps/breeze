import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { HourBlockEstimate } from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../db';
import { contractHourPeriods, timeEntries, type contracts, type contractLines } from '../db/schema';
import { computePeriod, periodIndexFor, todayISO } from './contractMath';
import { hourBlockDayStart } from './contractHourBlockHolds';
import { computePeriodMath, sumEntryHours, type HourBlockLineSpec, type RolloverPolicy } from './contractHourBlocks';
import { overageValue } from './contractAllowance';
import { ContractServiceError } from './contractTypes';

/**
 * Fail closed unless `time_entries` rows of `partnerId` are RLS-visible: system
 * scope, or partner scope holding that partner. `time_entries` is partner-axis
 * (Shape 3), so an organization-scope or absent context reads ZERO rows — which
 * this module would otherwise render as "0 of N hours used", i.e. free hours.
 */
function assertDrawdownReadable(partnerId: string): void {
  const ctx = getCurrentDbAccessContext();
  const ok = ctx?.scope === 'system'
    || (ctx?.scope === 'partner' && (ctx.accessiblePartnerIds ?? []).includes(partnerId));
  if (!ok) {
    throw new ContractServiceError(
      'Block-hours usage can only be read where time entries are visible: a system context, or a partner context for the owning partner',
      500, 'INVALID_STATE',
    );
  }
}

/** The period the figures are for: the contract period containing `today`, or —
 *  when the block starts counting later (an advance contract's current period was claimed before the block existed — index C9 "first unclaimed period") — the first
 *  counted period. Entries ended before `periodStart` are not eligible, so for a
 *  not-yet-started period the consumed figure is naturally 0. */
export function openPeriodFor(a: {
  startDate: string; intervalMonths: number; firstPeriodStart: string; today: string;
}): { periodStart: string; periodEnd: string } {
  let idx = periodIndexFor(a.startDate, a.intervalMonths, a.today);
  let p = computePeriod(a.startDate, a.intervalMonths, idx);
  // firstPeriodStart is itself a period boundary, so this terminates on equality.
  for (let guard = 0; p.periodStart < a.firstPeriodStart && guard < 100000; guard++) {
    idx += 1;
    p = computePeriod(a.startDate, a.intervalMonths, idx);
  }
  return p;
}

export interface OpenPeriodEntry { minutes: number; isApproved: boolean; currencyCode: string | null }

/** Pure: raw rows in, C8 out. Round-each-then-sum via sumEntryHours (20 min x 3 = 0.99 h). */
export function buildHourBlockEstimate(a: {
  line: {
    id: string; includedQuantity: string; overageUnitPrice: string; rolloverPolicy: string;
    rolloverCapHours: string | null; hourBlockAlertPct: number | null;
  };
  contract: { currencyCode: string; billingTiming: 'advance' | 'arrears' };
  period: { periodStart: string; periodEnd: string };
  carriedInHours: number;
  entries: readonly OpenPeriodEntry[];
  lateEntryMinutes: readonly number[];
}): HourBlockEstimate {
  const spec: HourBlockLineSpec = {
    includedQuantity: a.line.includedQuantity,
    overageUnitPrice: a.line.overageUnitPrice,
    rolloverPolicy: a.line.rolloverPolicy as RolloverPolicy,
    rolloverCapHours: a.line.rolloverCapHours,
  };
  const consumed = sumEntryHours(a.entries.map((e) => e.minutes));
  const unapproved = sumEntryHours(a.entries.filter((e) => !e.isApproved).map((e) => e.minutes));
  const foreign = sumEntryHours(
    a.entries.filter((e) => e.currencyCode !== a.contract.currencyCode).map((e) => e.minutes),
  );
  const math = computePeriodMath(spec, a.carriedInHours, consumed);
  const remaining = Math.max(0, Math.round((math.openingHours - math.consumedHours) * 100) / 100);
  return {
    lineId: a.line.id,
    periodStart: a.period.periodStart, periodEnd: a.period.periodEnd,
    includedHours: math.includedHours, carriedInHours: math.carriedInHours,
    consumedHours: math.consumedHours, unapprovedHours: unapproved,
    foreignCurrencyHours: foreign,
    remainingHours: remaining, overageHours: math.overageHours,
    overageUnitPrice: a.line.overageUnitPrice,
    overageValue: overageValue(
      { counted: math.consumedHours, billed: 1, included: math.openingHours, overage: math.overageHours, overageMode: 'bill' },
      { overageUnitPrice: a.line.overageUnitPrice }, a.contract.currencyCode,
    ),
    alertPct: a.line.hourBlockAlertPct,
    billingTiming: a.contract.billingTiming,
    lateEntryHours: sumEntryHours(a.lateEntryMinutes),
  };
}

/**
 * Live figures for a block line's OPEN period (index C8). Reads only; no FOR
 * UPDATE (the close, W02, is what locks). Eligibility is index C9's: org,
 * billable, not_billed, ended within the period (UTC-midnight bounds, the same set and carried-in rule as
 * W02's closeOne in contractHourBlockClose.ts), minutes =
 * COALESCE(billable_minutes, duration_minutes, 0); unapproved and any-currency
 * entries draw.
 *
 * CONTEXT: this function opens NO database context. It must be called where
 * `time_entries` rows of `contract.partnerId` are RLS-visible — a system context
 * (workers; W04's portal handler wraps it in runOutsideDbContext +
 * withSystemDbAccessContext) or a partner-scope context for the owning partner
 * (the contract routes and the AI tool, which run inside a held request
 * transaction and must NOT open a second connection). Any other context throws
 * rather than reading zero rows. The explicit `org_id` filter below scopes the
 * read inside either context.
 *
 * APPROXIMATION: carriedInHours is the last CLOSED ledger row's carried_out. In
 * the window between a period's end and the next billing sweep, that period is
 * claimed but unclosed, so its leftover is not yet reflected. The ledger, not
 * this read, is what bills.
 */
export async function computeOpenHourBlockPeriod(
  contract: typeof contracts.$inferSelect,
  line: typeof contractLines.$inferSelect,
  asOf: Date = new Date(),
): Promise<HourBlockEstimate> {
  assertDrawdownReadable(contract.partnerId);
  if (
    line.lineType !== 'hour_block' || line.includedQuantity === null || line.overageUnitPrice === null
    || line.rolloverPolicy === null || line.hourBlockFirstPeriodStart === null
  ) {
    throw new ContractServiceError(`Contract line ${line.id} is not a complete block-hours line`, 500, 'INVALID_STATE');
  }
  const period = openPeriodFor({
    startDate: contract.startDate, intervalMonths: contract.intervalMonths,
    firstPeriodStart: line.hourBlockFirstPeriodStart, today: todayISO(asOf),
  });
  // Dates -> instants: UTC midnight, the convention the invoice assembly range uses (index C9).
  const from = hourBlockDayStart(period.periodStart);
  const to = hourBlockDayStart(period.periodEnd);

  const [last] = await db.select({ carriedOut: contractHourPeriods.carriedOutHours }).from(contractHourPeriods)
    .where(and(eq(contractHourPeriods.contractLineId, line.id), lt(contractHourPeriods.periodStart, period.periodStart)))
    .orderBy(desc(contractHourPeriods.periodStart)).limit(1);

  const eligible = and(
    eq(timeEntries.orgId, contract.orgId), eq(timeEntries.isBillable, true),
    eq(timeEntries.billingStatus, 'not_billed'), isNotNull(timeEntries.endedAt),
  );
  const minutes = sql<number>`COALESCE(${timeEntries.billableMinutes}, ${timeEntries.durationMinutes}, 0)`;
  const entries = await db.select({ minutes, isApproved: timeEntries.isApproved, currencyCode: timeEntries.currencyCode })
    .from(timeEntries)
    .where(and(eligible, gte(timeEntries.endedAt, from), lt(timeEntries.endedAt, to)));
  // Not-billed billable entries whose end falls inside a period this line already
  // closed: the ledger cannot re-close, so they bill separately (spec "Out of scope").
  const late = await db.select({ minutes }).from(timeEntries).where(and(
    eligible,
    sql`EXISTS (
      SELECT 1 FROM contract_hour_periods p
       WHERE p.contract_line_id = ${line.id}
         AND ${timeEntries.endedAt} >= (p.period_start::timestamp AT TIME ZONE 'UTC')
         AND ${timeEntries.endedAt} <  (p.period_end::timestamp AT TIME ZONE 'UTC'))`,
  ));

  return buildHourBlockEstimate({
    line: {
      id: line.id, includedQuantity: line.includedQuantity, overageUnitPrice: line.overageUnitPrice,
      rolloverPolicy: line.rolloverPolicy, rolloverCapHours: line.rolloverCapHours,
      hourBlockAlertPct: line.hourBlockAlertPct,
    },
    contract: { currencyCode: contract.currencyCode, billingTiming: contract.billingTiming as 'advance' | 'arrears' },
    period,
    carriedInHours: last ? Number(last.carriedOut) : 0,
    entries: entries.map((e) => ({ minutes: Number(e.minutes), isApproved: e.isApproved, currencyCode: e.currencyCode })),
    lateEntryMinutes: late.map((e) => Number(e.minutes)),
  });
}
