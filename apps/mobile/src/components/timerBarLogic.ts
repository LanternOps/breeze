/**
 * The two rules that decide when the timer bar is on screen and when it
 * replays the offline backlog.
 *
 * Pure module (no React, no React Native) because the app has no component
 * test runtime: both rules had a defect that only a test could pin, and both
 * defects were silent.
 */

/**
 * The bar used to also stay mounted while its own toast was on screen: the
 * replay-result toast was a CHILD of the bar, so a drain that emptied the queue
 * by DROPPING writes (`remaining: 0`, no timer running) unmounted the bar in
 * the very render that would have said "N offline time entries could not be
 * saved" — discarded billable work vanishing with no signal anywhere in the UI.
 *
 * Since #5368 that toast goes to the app-wide host instead, which outlives the
 * bar by construction, so the rule is back to the two conditions that describe
 * the BAR: a running timer, or a queue with something in it. The
 * needs-attention count is folded into `pendingCount` by the caller, which is
 * what keeps the dropped-writes case reported after the toast has gone.
 */
export function isTimerBarVisible(input: {
  hasRunningTimer: boolean;
  pendingCount: number;
}): boolean {
  return input.hasRunningTimer || input.pendingCount > 0;
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
 * Grace period before the bar reports a queued write as "waiting to sync".
 *
 * The ordinary case — Stop enqueues one write, replay drains it — completes
 * in well under a second. Reporting the queue depth the instant it goes
 * positive made "Time entries waiting to sync" flash after every stop, which
 * reads like an error for work that is about to sync fine.
 */
export const WAITING_TO_SYNC_GRACE_MS = 3000;

/**
 * Whether the bar should show "Time entries waiting to sync" for a queue that
 * has had `elapsedMs` to drain. False for an empty queue regardless of how
 * long it has been empty, and false for a non-empty queue still inside the
 * grace period — only a queue that is BOTH non-empty AND past the grace
 * period has earned the label.
 */
export function shouldShowWaitingToSync(input: { pendingCount: number; elapsedMs: number }): boolean {
  return input.pendingCount > 0 && input.elapsedMs >= WAITING_TO_SYNC_GRACE_MS;
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

/**
 * Elapsed seconds past which a running timer is flagged as runaway.
 *
 * Issue #5115: a timesheet showed a 12h31m entry from a timer nobody
 * stopped. 4h is deliberately conservative — long enough that an ordinary
 * uninterrupted work session never trips it, short enough to catch a
 * forgotten timer well before it becomes a full-day billing error. This
 * warns; it never auto-stops, since only the technician knows when the
 * work actually ended.
 */
export const LONG_RUNNING_TIMER_WARNING_SECONDS = 4 * 60 * 60;

/** Whether a running timer has been going long enough to warn about. */
export function isRunningTimerLong(elapsedSeconds: number): boolean {
  return elapsedSeconds >= LONG_RUNNING_TIMER_WARNING_SECONDS;
}
