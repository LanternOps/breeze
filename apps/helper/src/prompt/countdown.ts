/**
 * The `{remaining}` countdown (#10190). Display only: the agent's timer decides
 * expiry, so a renderer never acts when this reaches zero, and a sleep or a
 * clock jump past the deadline shows `0:00`, never negative time.
 */

/** Whole seconds left, rounded up (so `0:00` means the deadline has come), never negative. */
export function remainingSeconds(deadlineMs: number, nowMs: number): number {
  const left = deadlineMs - nowMs;
  if (!Number.isFinite(left) || left <= 0) return 0;
  return Math.ceil(left / 1000);
}

/** `M:SS` (minutes unbounded: `90:00`), floored at `0:00`. */
export function formatRemaining(deadlineMs: number, nowMs: number): string {
  const total = remainingSeconds(deadlineMs, nowMs);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
