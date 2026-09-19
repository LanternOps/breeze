/**
 * Process-local rate limiter for `captureMessage` call sites that fire on a
 * condition which is BURSTY by nature.
 *
 * WHY: `captureMessage` (services/sentry.ts) has no sampling, dedup or
 * throttle of its own — every call ships an event. That is correct for a
 * once-per-boot or once-per-outage report, but wrong for anything driven by
 * request volume: the conditions worth reporting (lock contention, a query
 * bound tripping) are exactly the ones that arrive in storms, so the
 * unthrottled call site turns one incident into thousands of events and burns
 * the quota that makes the NEXT incident visible.
 *
 * This is the pattern the existing call sites already implement inline — the
 * LLM egress audit shedder and the payment-delete alert both bound themselves
 * before calling, and `sentry.ts`'s own tag comments cite that bound as the
 * reason their tag cardinality is safe ("at most one event per outage"). This
 * module is that pattern factored out so a new call site gets it by
 * construction rather than by remembering.
 *
 * Deliberately per-process and in-memory: it bounds Sentry volume, and every
 * suppressed occurrence is still handed to the caller as a count so the full
 * signal can go to the (unscrubbed, unthrottled) server log. It is NOT a
 * cross-replica limiter and is not trying to be one — an N-replica deployment
 * gets at most N events per window, which is still bounded.
 */
export function throttledReporter(
  windowMs: number,
  report: (suppressedSinceLastReport: number) => void,
): () => void {
  let lastReportedAt = 0;
  let suppressed = 0;

  return () => {
    const now = Date.now();
    if (lastReportedAt !== 0 && now - lastReportedAt < windowMs) {
      suppressed += 1;
      return;
    }
    lastReportedAt = now;
    const sinceLast = suppressed;
    suppressed = 0;
    report(sinceLast);
  };
}
