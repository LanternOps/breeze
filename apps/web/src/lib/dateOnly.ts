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
