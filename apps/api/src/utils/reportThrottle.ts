/**
 * Per-process throttle for low-value-when-repeated warnings.
 *
 * Signals that describe a FLEET condition ("this phone's device id matches no
 * row") fire on every request from every affected client, so reporting each
 * one buries the signal and inflates Sentry without adding information. One
 * report per key per interval is enough to notice the condition; the fix is
 * driven by its presence, not its count.
 */
export function createReportThrottle(intervalMs: number, maxKeys = 10_000) {
  const lastReportedAt = new Map<string, number>();

  return {
    /** True at most once per `intervalMs` for a given key. */
    shouldReport(key: string, now: number = Date.now()): boolean {
      const previous = lastReportedAt.get(key);
      if (previous !== undefined && now - previous < intervalMs) {
        return false;
      }
      // Per-caller keys make the key space unbounded, so cap it. Dropping the
      // whole window only ever makes us report MORE — never less — so the
      // signal cannot be lost, unlike an eviction policy that could silence a
      // key that is actively firing.
      if (lastReportedAt.size >= maxKeys && !lastReportedAt.has(key)) {
        lastReportedAt.clear();
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
