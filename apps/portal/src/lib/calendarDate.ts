/**
 * Format a value that is a CALENDAR DAY, not an instant.
 *
 * A Postgres `date` column arrives as "2026-09-23". `new Date("2026-09-23")`
 * reads that as UTC midnight, so a formatter running in the viewer's zone
 * prints the previous day everywhere west of UTC. On an SSR page that is a
 * hydration mismatch — the server (UTC in the container) and the browser (the
 * customer's zone) render different text, React discards the tree and
 * re-renders it, and the customer can see the date flip.
 *
 * So: a date-only string is formatted in UTC, which is the only reading under
 * which the day the MSP entered is the day the customer sees. A full timestamp
 * is an instant and is formatted in `timeZone` (pass the org's zone — the same
 * rule `formatDateTime` follows).
 */
export function formatCalendarDate(value: string, timeZone?: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Date(dateOnly ? `${value}T00:00:00.000Z` : value).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: dateOnly ? 'UTC' : timeZone,
  });
}
