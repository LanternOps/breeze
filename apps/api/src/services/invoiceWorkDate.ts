/**
 * #8603: the calendar date a time entry was worked, in the partner's timezone,
 * as `YYYY-MM-DD` for `invoice_lines.work_date`.
 *
 * Converted ONCE, at assembly, and stored as a `date` so renderers never turn an
 * instant into a day themselves. Callers pass the entry's `started_at`: an entry
 * spanning local midnight is dated by the day the work began.
 *
 * An unknown or empty zone falls back to UTC rather than throwing: a bad stored
 * partner zone must never block invoicing.
 */
export function toPartnerLocalDate(instant: Date, timeZone: string): string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  const parts = fmt.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}
