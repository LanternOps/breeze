import { z } from 'zod';
import type { ReportPeriodInput } from '../types/businessReports';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True when `YYYY-MM-DD` names a real calendar day (rejects 2026-02-31,
 *  month 13, day 00, and 02-29 outside a leap year). */
export function isRealCalendarDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The single definition of a report period input. Consumed by the three API
 *  config schemas (`apps/api/src/services/businessReports/period.ts` re-exports
 *  it) and by W03's `ReportPeriodField`. `z.ZodType<ReportPeriodInput>` pins the
 *  schema and the type together — they cannot drift apart silently.
 *
 *  A `custom` period must carry BOTH dates, each a real calendar day, with
 *  `start <= end` (`end` is INCLUSIVE: the resolver ends the window at the
 *  midnight after it, so a single-day period is `start === end`). Anything
 *  else is refused here, at write time — the resolver throws rather than
 *  silently substituting a different window (#3198 W02 fix round). */
export const periodSchema: z.ZodType<ReportPeriodInput> = z.object({
  kind: z.enum(['last_full_month', 'last_30_days', 'last_quarter', 'custom']),
  start: z.string().regex(DATE_ONLY).refine(isRealCalendarDate, 'start must be a real calendar date').optional(),
  end: z.string().regex(DATE_ONLY).refine(isRealCalendarDate, 'end must be a real calendar date').optional(),
}).superRefine((value, ctx) => {
  if (value.kind !== 'custom') return;
  if (!value.start || !value.end) {
    ctx.addIssue({ code: 'custom', message: 'a custom period requires both start and end', path: [value.start ? 'end' : 'start'] });
    return;
  }
  // Both are validated YYYY-MM-DD strings, so lexical order is date order.
  if (value.start > value.end) {
    ctx.addIssue({ code: 'custom', message: 'a custom period start must not be after its end', path: ['end'] });
  }
});
