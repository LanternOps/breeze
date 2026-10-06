// retryDates.ts
import type { CollectionFailureClass } from '@breeze/shared';
function nthWeekday(year: number, month: number, weekday: number, ordinal: number): string {
  const day = new Date(Date.UTC(year, month, 1));
  day.setUTCDate(1 + (weekday - day.getUTCDay() + 7) % 7 + 7 * (ordinal - 1));
  return day.toISOString().slice(0, 10);
}
function lastMonday(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month + 1, 0));
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  return day.toISOString().slice(0, 10);
}
function bankHoliday(date: Date): boolean {
  const y = date.getUTCFullYear();
  const holidays = new Set([nthWeekday(y,0,1,3), nthWeekday(y,1,1,3), lastMonday(y,4),
    nthWeekday(y,8,1,1), nthWeekday(y,9,1,2), nthWeekday(y,10,4,4)]);
  for (const [month, day] of [[0,1], [5,19], [6,4], [10,11], [11,25]]) {
    const holiday = new Date(Date.UTC(y, month!, day!));
    // Federal Reserve closes Monday for a Sunday holiday; Saturday is already nonbusiness.
    if (holiday.getUTCDay() === 0) holiday.setUTCDate(holiday.getUTCDate() + 1);
    holidays.add(holiday.toISOString().slice(0,10));
  }
  return holidays.has(date.toISOString().slice(0,10));
}
export function retryAt(firstAttempt: Date, failure: Date,
  failureClass: CollectionFailureClass, attemptCount: number): Date | null {
  if (failureClass === 'soft' && attemptCount < 3) {
    const next = new Date(firstAttempt);
    next.setUTCDate(next.getUTCDate() + (attemptCount === 1 ? 3 : 7));
    return next;
  }
  if (failureClass === 'nsf' && attemptCount === 1) {
    const next = new Date(failure);
    let remaining = 3;
    while (remaining > 0) {
      next.setUTCDate(next.getUTCDate() + 1);
      if (next.getUTCDay() !== 0 && next.getUTCDay() !== 6 && !bankHoliday(next)) remaining--;
    }
    return next;
  }
  return null;
}
