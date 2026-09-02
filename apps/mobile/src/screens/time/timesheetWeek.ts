/**
 * Calendar arithmetic for the weekly timesheet.
 *
 * Everything here is date-only (`YYYY-MM-DD`) and computed from LOCAL calendar
 * fields. `GET /time-entries/timesheet?weekStart=` takes a calendar date, so
 * sending a full ISO timestamp shifts the day boundary by the phone's UTC
 * offset and silently moves entries between weeks — 23:45 on a Sunday in
 * London is already Monday in UTC.
 *
 * Pure module: no React Native imports, so it is unit-testable.
 */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function toDateOnly(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Parses `YYYY-MM-DD` into a LOCAL midnight Date. `new Date('2026-08-24')`
 * parses as UTC midnight, which is the previous day west of Greenwich — the
 * exact off-by-one this module exists to avoid.
 */
export function localMidnightMs(dateOnly: string): number {
  return fromDateOnly(dateOnly).getTime();
}

function fromDateOnly(dateOnly: string): Date {
  const [year, month, day] = dateOnly.split('-').map((part) => Number(part));
  return new Date(year, month - 1, day);
}

/** Monday of the week containing `date`, as a local calendar date. */
export function weekStartFor(date: Date): string {
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // getDay(): 0 = Sunday. Monday-based weeks put Sunday six days after the start.
  const offset = (local.getDay() + 6) % 7;
  local.setDate(local.getDate() - offset);
  return toDateOnly(local);
}

/** Steps `weeks` whole weeks from a week start, crossing month/year boundaries. */
export function shiftWeek(weekStart: string, weeks: number): string {
  const date = fromDateOnly(weekStart);
  date.setDate(date.getDate() + weeks * 7);
  return toDateOnly(date);
}

/** The seven calendar days of the week, so empty days still render a row. */
export function daysOfWeek(weekStart: string): string[] {
  const start = fromDateOnly(weekStart);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    return toDateOnly(day);
  });
}

/**
 * Fixed English weekday/month names rather than `toLocaleDateString`: Hermes
 * ships a reduced ICU, so locale formatting varies by device and engine and the
 * header becomes unpredictable across the fleet.
 */
export function dayLabel(dateOnly: string): string {
  const date = fromDateOnly(dateOnly);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

export function weekRangeLabel(weekStart: string): string {
  const start = fromDateOnly(weekStart);
  const end = fromDateOnly(shiftWeek(weekStart, 0));
  end.setDate(end.getDate() + 6);
  return `${start.getDate()} ${MONTHS[start.getMonth()]} – ${end.getDate()} ${MONTHS[end.getMonth()]} ${end.getFullYear()}`;
}
