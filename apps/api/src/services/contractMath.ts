import type { BillingTiming, Period } from './contractTypes';

// All dates are ISO YYYY-MM-DD strings handled in UTC to avoid TZ drift.
function parts(iso: string): { y: number; m: number; d: number } {
  const segments = iso.split('-');
  const y = Number(segments[0]);
  const m = Number(segments[1]);
  const d = Number(segments[2]);
  return { y, m, d };
}
function daysInMonth(year: number, month1: number): number {
  // month1 is 1-based; Date day 0 of next month = last day of this month.
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}
function fmt(y: number, m1: number, d: number): string {
  const mm = String(m1).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return `${y}-${mm}-${dd}`;
}

export function addMonthsClamped(iso: string, months: number): string {
  const { y, m, d } = parts(iso);
  const zeroBased = (m - 1) + months;
  const ny = y + Math.floor(zeroBased / 12);
  const nm1 = (zeroBased % 12 + 12) % 12 + 1;
  const clampedDay = Math.min(d, daysInMonth(ny, nm1));
  return fmt(ny, nm1, clampedDay);
}

export function computePeriod(startDate: string, intervalMonths: number, periodIndex: number): Period {
  const periodStart = addMonthsClamped(startDate, intervalMonths * periodIndex);
  const periodEnd = addMonthsClamped(startDate, intervalMonths * (periodIndex + 1));
  return { periodStart, periodEnd };
}

export function periodIndexFor(startDate: string, intervalMonths: number, asOf: string): number {
  let idx = 0;
  // Walk forward until the next period start exceeds asOf. Bounded; contracts are short-lived in months.
  while (computePeriod(startDate, intervalMonths, idx + 1).periodStart <= asOf) {
    idx++;
    if (idx > 100000) break; // runaway guard
  }
  return idx;
}

export function nextBillingDate(input: {
  startDate: string;
  intervalMonths: number;
  billingTiming: BillingTiming;
  periodIndex: number;
}): string {
  const { periodStart, periodEnd } = computePeriod(input.startDate, input.intervalMonths, input.periodIndex);
  return input.billingTiming === 'advance' ? periodStart : periodEnd;
}

export function isExpired(input: { endDate: string | null; periodStart: string }): boolean {
  if (input.endDate === null) return false;
  return input.periodStart >= input.endDate;
}

/** Add (or subtract) whole days to an ISO YYYY-MM-DD date, in UTC. */
export function addDaysISO(iso: string, days: number): string {
  const segments = iso.split('-');
  const y = Number(segments[0]);
  const m = Number(segments[1]);
  const d = Number(segments[2]);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** ISO start of the period the billing sweep is about to bill. */
export function duePeriodStartFor(billingTiming: BillingTiming, nextBillingAt: string, intervalMonths: number): string {
  return billingTiming === 'advance' ? nextBillingAt : addMonthsClamped(nextBillingAt, -intervalMonths);
}

/** UTC calendar date of `asOf`. Contracts carry no timezone, so every "today" in
 *  the billing code is UTC (the claim query and the hour-block boundaries use the
 *  same convention). */
export function todayISO(asOf: Date = new Date()): string {
  return asOf.toISOString().slice(0, 10);
}

/**
 * Index C9: the first period whose block-hours fee has not yet been claimed, i.e.
 * where entitlement starts because the fee starts. Active: the period the billing
 * pointer will claim next (advance: the next period; arrears: the period in
 * progress). Draft: nothing is claimed, so the first period — provisional until
 * activateContract re-stamps it. Null when a non-draft contract has no pointer.
 *
 * Built from computePeriod/periodIndexFor, NOT duePeriodStartFor: `nextBillingAt`
 * is always a period boundary, so periodIndexFor returns its exact index k; the
 * pointer is period k's START (advance) or END (arrears, so the period in
 * progress is k-1). addMonthsClamped(nextBillingAt, -interval) would mis-derive
 * month-end starts. This is the PURE candidate; the caller must still walk it past
 * periods that are already claimed (advancePastClaimed) — a pause -> resume resets
 * an advance pointer onto a claimed period.
 */
export function firstUnclaimedPeriodStart(c: {
  status: string; startDate: string; intervalMonths: number;
  billingTiming: BillingTiming; nextBillingAt: string | null;
}): string | null {
  if (c.status === 'draft') return c.startDate;
  if (c.nextBillingAt === null) return null;
  const k = periodIndexFor(c.startDate, c.intervalMonths, c.nextBillingAt);
  const idx = c.billingTiming === 'arrears' ? Math.max(0, k - 1) : k;
  return computePeriod(c.startDate, c.intervalMonths, idx).periodStart;
}

/** `candidate` is a period boundary; step forward one period at a time while it is in `claimedStarts`. */
export function advancePastClaimed(
  candidate: string, claimedStarts: ReadonlySet<string>, startDate: string, intervalMonths: number,
): string {
  let idx = periodIndexFor(startDate, intervalMonths, candidate);
  let start = computePeriod(startDate, intervalMonths, idx).periodStart;
  for (let guard = 0; claimedStarts.has(start) && guard < 100000; guard++) {
    idx += 1;
    start = computePeriod(startDate, intervalMonths, idx).periodStart;
  }
  return start;
}

/** True when asOf is in [endDate - noticeDays, endDate). */
export function isWithinNoticeWindow(asOf: string, endDate: string, noticeDays: number): boolean {
  const windowStart = addDaysISO(endDate, -noticeDays);
  return asOf >= windowStart && asOf < endDate;
}

/** Roll endDate forward by whole terms until the due period no longer trips isExpired. */
export function extendTermPastDue(input: { endDate: string; duePeriodStart: string; termMonths: number }):
  { newEndDate: string; renewed: boolean } {
  let endDate = input.endDate;
  let renewed = false;
  let guard = 0;
  while (isExpired({ endDate, periodStart: input.duePeriodStart })) {
    endDate = addMonthsClamped(endDate, input.termMonths);
    renewed = true;
    if (++guard > 100000) break; // runaway guard (mirrors periodIndexFor)
  }
  return { newEndDate: endDate, renewed };
}
