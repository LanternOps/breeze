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

/**
 * The billing sites' expiry test, evaluated against the period the sweep is
 * NEXT going to bill (`duePeriodStartFor`, exactly as generateDueInvoice does).
 * A contract with no pointer can never produce another invoice, so it is judged
 * against today instead. Open-ended (endDate null) is never past its end.
 */
export function isPastEndForReporting(
  c: { endDate: string | null; nextBillingAt: string | null; billingTiming: BillingTiming; intervalMonths: number },
  asOfISO: string,
): boolean {
  if (c.endDate === null || c.endDate === undefined) return false;
  const periodStart = c.nextBillingAt
    ? duePeriodStartFor(c.billingTiming, c.nextBillingAt, c.intervalMonths > 0 ? c.intervalMonths : 1)
    : asOfISO;
  return isExpired({ endDate: c.endDate, periodStart });
}

/** Why a contract counts as in term: still billing, or its final period is billed and still being served. */
export type ContractInTermBasis = 'active' | 'billed_final_term';

/**
 * #9220 (business-reports phase 2 spec, trap T8): is this contract in term on
 * `asOfISO`, for reporting (MRR)? `status` alone cannot answer it.
 * generateDueInvoice flips a contract to `expired` as soon as it bills a period
 * whose SUCCESSOR starts on/after end_date, so an advance-billed contract is
 * `expired` for the whole of its final, paid, still-served period — a one-year
 * contract billed annually in advance is `expired` right after its only invoice.
 *
 * In term when all hold:
 *  - start_date <= asOf (a future-start contract is not yet earning);
 *  - end_date is NULL or asOf < end_date (end_date is exclusive, like isExpired);
 *  - status is `active` and not isPastEndForReporting → 'active', or
 *    status is `expired` (or `active` past its billing end: an auto-renewing
 *    contract after its final invoice, #9243) and a billed
 *    contract_billing_periods row covers asOf (`billedPeriodCoversAsOf`,
 *    looked up by the caller) → 'billed_final_term'.
 * `paused`, `cancelled` and `draft` are never in term.
 *
 * Billing behaviour is deliberately untouched: this only stops reporting from
 * reading the early `expired` stamp as "ended".
 */
export function contractInTermForReporting(
  c: {
    status: string; startDate: string; endDate: string | null;
    nextBillingAt: string | null; billingTiming: BillingTiming; intervalMonths: number;
  },
  asOfISO: string,
  billedPeriodCoversAsOf: boolean,
): ContractInTermBasis | null {
  if (c.startDate > asOfISO) return null;
  if (c.endDate !== null && c.endDate !== undefined && asOfISO >= c.endDate) return null;
  // #9243: an auto-renewing contract is NOT expired by its final invoice. It
  // stays active with the pointer at end_date until the renewal sweep extends
  // it, so an active contract past its billing end is valued like an expired
  // one: by the billed period that covers asOf.
  if (c.status === 'active' && !isPastEndForReporting(c, asOfISO)) return 'active';
  if (c.status === 'active' || c.status === 'expired') return billedPeriodCoversAsOf ? 'billed_final_term' : null;
  return null;
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

/**
 * #9243: does this contract renew itself at end_date? `renewal_term_months` is
 * NULL or > 0 in the DB (CHECK constraint); a contract without a positive term
 * cannot renew, so it expires like any other. The ONE predicate both the renewal
 * sweep and generateDueInvoice use to decide "never expire this, renew it".
 */
export function isAutoRenewing(c: { autoRenew: boolean; renewalTermMonths: number | null }): boolean {
  return c.autoRenew === true && c.renewalTermMonths !== null && c.renewalTermMonths > 0;
}

/**
 * #9243: the auto-renewal decision. The term renews ON its end_date, the date the
 * advance notice promised ("auto-renews on {endDate}"), and not earlier: endDate
 * rolls forward by whole terms, from the previous end, until it is after asOf.
 * It is never a billing interval early, so the MSP keeps the notice window to
 * opt out. Several terms are added after an outage. A non-positive term never
 * renews.
 *
 * Paired with billingRunPeriods by the invariant in contractMath.test.ts: after
 * this runs on day D, the period billing is due to bill on D is never past the
 * end, so the billing due-check cannot expire a contract the sweep has renewed.
 */
export function extendTermThrough(input: { endDate: string; asOfISO: string; termMonths: number }):
  { newEndDate: string; renewed: boolean } {
  let endDate = input.endDate;
  let renewed = false;
  if (input.termMonths <= 0) return { newEndDate: endDate, renewed };
  let guard = 0;
  while (isExpired({ endDate, periodStart: input.asOfISO })) {
    endDate = addMonthsClamped(endDate, input.termMonths);
    renewed = true;
    if (++guard > 100000) break; // runaway guard (mirrors periodIndexFor)
  }
  return { newEndDate: endDate, renewed };
}

/**
 * The periods one generateDueInvoice run deals with, from the billing pointer:
 * `due` is the period this run bills (advance: the period starting at
 * nextBillingAt; arrears: the just-completed period ending at it) and `next` is
 * the one after it, which decides where the pointer goes. Walked from the START
 * date via periodIndexFor/computePeriod, NOT duePeriodStartFor, so month-end
 * contracts get the same periods the claims are keyed on.
 */
export function billingRunPeriods(c: {
  startDate: string; intervalMonths: number; billingTiming: BillingTiming; nextBillingAt: string;
}): { idx: number; due: Period; next: Period } {
  const idxAt = periodIndexFor(c.startDate, c.intervalMonths, c.nextBillingAt);
  const idx = Math.max(0, c.billingTiming === 'advance' ? idxAt : idxAt - 1);
  return {
    idx,
    due: computePeriod(c.startDate, c.intervalMonths, idx),
    next: computePeriod(c.startDate, c.intervalMonths, idx + 1),
  };
}
