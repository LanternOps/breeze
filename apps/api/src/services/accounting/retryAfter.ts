/**
 * A neutral leaf module (no imports) so every provider boundary can read a
 * `Retry-After` header without importing another provider or the limiter —
 * several QuickBooks suites mock `./accountingRateLimit` down to
 * `withProviderCallSlot` only, so a helper living there would vanish under
 * those mocks.
 */

/**
 * `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
 * Returns null when absent or unreadable (a negative delta included), so the
 * caller picks its own default.
 */
export function parseRetryAfterMs(header: string | null): number | null {
  if (!header || !header.trim()) return null;
  if (/^\s*-?\d+(?:\.\d+)?\s*$/.test(header)) {
    const seconds = Number(header);
    return seconds >= 0 ? Math.ceil(seconds * 1000) : null;
  }
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}
