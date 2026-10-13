import { captureMessage } from './sentry';

/** Zones already reported, so a 500-line invoice reports a bad zone once, not 500 times. */
const reportedInvalidZones = new Set<string>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
}

/**
 * #8603: the calendar date a time entry was worked, in the partner's timezone,
 * as `YYYY-MM-DD` for `invoice_lines.work_date`.
 *
 * Converted ONCE, at assembly, and stored as a `date` so renderers never turn an
 * instant into a day themselves. Callers pass the entry's `started_at`: an entry
 * spanning local midnight is dated by the day the work began.
 *
 * An unknown or empty zone falls back to UTC rather than throwing: a bad stored
 * partner zone must never block invoicing. It is reported (once per zone) so the
 * wrong-by-a-day risk near midnight is visible, not silent.
 */
export function toPartnerLocalDate(instant: Date, timeZone: string): string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = dayFormatter(timeZone);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    if (!reportedInvalidZones.has(timeZone)) {
      reportedInvalidZones.add(timeZone);
      console.warn(`[invoiceWorkDate] invalid partner timezone ${JSON.stringify(timeZone)}; dating invoice lines in UTC`);
      captureMessage('Invoice work date: invalid partner timezone, fell back to UTC', {
        eventCode: 'invoice_work_date_invalid_timezone',
      });
    }
    fmt = dayFormatter('UTC');
  }
  const parts = fmt.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
