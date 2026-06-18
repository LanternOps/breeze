/**
 * Quote expiry helpers (Phase 3).
 *
 * `expiry_date` is a date-only column (no time). A quote is valid THROUGH the end
 * of its expiry_date and becomes expired only once the calendar day has moved
 * past it. We compare against the UTC calendar day — the lenient choice for any
 * timezone west of UTC (the quote stays live slightly into the next local day
 * rather than expiring early on the customer). The BullMQ sweep and the read-time
 * guard share this definition so they never disagree.
 */

/** UTC calendar day (YYYY-MM-DD) for a moment in time. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * True when a quote with the given `expiry_date` is past its validity as of
 * `asOf` (defaults to now). A null/absent expiry_date never expires.
 *
 * ISO date strings (YYYY-MM-DD) compare lexicographically in chronological order,
 * so a string `<` is a correct date comparison here.
 */
export function isQuoteExpired(expiryDate: string | null | undefined, asOf: Date = new Date()): boolean {
  if (!expiryDate) return false;
  return expiryDate < utcDay(asOf);
}
