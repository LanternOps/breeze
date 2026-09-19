/**
 * Device liveness, in one place (RMM-QA-176 D7).
 *
 * `DEFAULT_OFFLINE_THRESHOLD_MINUTES` was a private const inside
 * jobs/offlineDetector.ts, which also owns a BullMQ queue — importing that
 * module from a request path would drag the queue in. The maintenance EXIT
 * path (routes/devices/commands.ts) needs the same threshold to answer "is
 * this device actually alive right now?" instead of restoring a stale stored
 * status, so the number and the predicate live here and the detector imports
 * the constant. No behaviour change: the value is unchanged and the six
 * offlineDetector suites are the guard.
 */
export const DEFAULT_OFFLINE_THRESHOLD_MINUTES = 5;

/**
 * Fresh-evidence liveness. `online` iff the agent was seen within the
 * threshold; a never-seen device is `offline`. A `lastSeenAt` in the future
 * (clock skew) reads as `online` — the conservative direction for a device
 * that is demonstrably reporting.
 */
export function resolveLivenessStatus(
  lastSeenAt: Date | null | undefined,
  now: Date,
): 'online' | 'offline' {
  if (!lastSeenAt) return 'offline';
  const ageMs = now.getTime() - lastSeenAt.getTime();
  return ageMs <= DEFAULT_OFFLINE_THRESHOLD_MINUTES * 60_000 ? 'online' : 'offline';
}
