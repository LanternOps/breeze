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
