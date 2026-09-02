/**
 * The two rules that decide when the timer bar is on screen and when it
 * replays the offline backlog.
 *
 * Pure module (no React, no React Native) because the app has no component
 * test runtime: both rules had a defect that only a test could pin, and both
 * defects were silent.
 */

/**
 * The replay-result toast is a child of the bar, not a portal, so the bar must
 * outlive the queue to report on it. A drain that empties the queue by
 * DROPPING writes returns `remaining: 0`; with no timer running, a rule of
 * "running || pending" unmounts the bar in the very render that would have
 * said "N offline time entries could not be saved" — discarded billable work
 * vanishing with no signal anywhere in the UI.
 */
export function isTimerBarVisible(input: {
  hasRunningTimer: boolean;
  pendingCount: number;
  hasToast: boolean;
}): boolean {
  return input.hasRunningTimer || input.pendingCount > 0 || input.hasToast;
}

/**
 * When to drain.
 *
 * `useNetworkConnected` seeds `true` (it treats "unknown" as connected), so an
 * app relaunched on strong WiFi never sees a false -> true edge: a backlog
 * queued in a previous launch would sit behind its badge until connectivity
 * happened to drop and return. Hence the explicit cold-start pass — gated on a
 * non-empty queue so an ordinary launch spends no round trip.
 *
 * After that, only a false -> true transition: replaying on every render (or on
 * a true -> true report) would race `drain`'s own serialisation for no gain.
 */
export function shouldReplayNow(input: {
  coldStart: boolean;
  previousConnected: boolean;
  connected: boolean;
  pendingCount: number;
}): boolean {
  if (!input.connected) return false;
  if (input.coldStart) return input.pendingCount > 0;
  return !input.previousConnected;
}

/**
 * Attempts on the head write beyond which the queue is wedged, not merely
 * behind a bad connection. Low deliberately: the retained statuses (401, 403,
 * 408, 429) are exactly the ones that do not clear themselves, and three failed
 * reconnects is already a technician who will otherwise see a badge that never
 * goes down and never learn why.
 */
export const WEDGED_ATTEMPTS = 3;

/**
 * Whether the queue is stuck rather than waiting.
 *
 * `headAttempts` was added in round one precisely as this signal and had no
 * consumer, so a queue wedged on a retained 403 replayed silently forever. That
 * is not an exotic state: issue #4251 means a default Partner Technician
 * genuinely lacks `time_entries:write`, so a permanent 403 is the EXPECTED
 * outcome for many users. Surfacing it is the whole point — the writes are
 * still there, and dropping them to unwedge the queue would destroy real work.
 */
export function isQueueWedged(input: { remaining: number; headAttempts: number }): boolean {
  return input.remaining > 0 && input.headAttempts >= WEDGED_ATTEMPTS;
}
