const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a bare calendar date (`YYYY-MM-DD`) with no time or zone. */
export function isDateOnly(value: string): boolean {
  return DATE_ONLY_RE.test(value);
}

/**
 * Parse a date string. A bare `YYYY-MM-DD` is built as a LOCAL calendar date:
 * `new Date('2026-10-14')` is UTC midnight, which renders the previous day in
 * zones west of UTC. Anything else falls through to `new Date(value)`.
 */
export function parseDateOnly(value: string): Date {
  const m = DATE_ONLY_RE.exec(value);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
}

/** Locale date string for an API date, safe for bare calendar dates. Returns the input when unparseable. */
export function formatDateOnly(value: string): string {
  const date = parseDateOnly(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

/**
 * The UTC calendar date (`YYYY-MM-DD`) of an instant. Use it for server-side
 * day buckets, which arrive as UTC-midnight instants but mean a calendar date:
 * feed the result to `parseDateOnly` so it does not render a day early west of
 * UTC. A bare date passes through; unparseable input is returned unchanged.
 */
export function utcDateOnly(value: string): string {
  if (DATE_ONLY_RE.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}
