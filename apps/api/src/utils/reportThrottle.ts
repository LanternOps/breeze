/**
 * Per-process throttle for low-value-when-repeated warnings.
 *
 * Signals that describe a FLEET condition ("this phone's device id matches no
 * row") fire on every request from every affected client, so reporting each
 * one buries the signal and inflates Sentry without adding information. One
 * report per key per interval is enough to notice the condition; the fix is
 * driven by its presence, not its count.
 */
export function createReportThrottle(intervalMs: number) {
  const lastReportedAt = new Map<string, number>();

  return {
    /** True at most once per `intervalMs` for a given key. */
    shouldReport(key: string, now: number = Date.now()): boolean {
      const previous = lastReportedAt.get(key);
      if (previous !== undefined && now - previous < intervalMs) {
        return false;
      }
      lastReportedAt.set(key, now);
      return true;
    },
    /** Test seam. */
    reset(): void {
      lastReportedAt.clear();
    },
  };
}
