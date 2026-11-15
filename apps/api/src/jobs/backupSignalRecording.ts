/**
 * When could this server last record agent backup signals without a break?
 * (#11766)
 *
 * The stale-backup reaper judges a running job by how long its agent has been
 * silent: `last_keepalive_at`, `last_progress_at`, the device's `last_seen_at`.
 * Those are the times the server last WROTE a signal, not the times the agent
 * last SENT one. While the database refuses writes, or while the API is down,
 * agents keep sending and nothing is written, so every running job looks
 * silent. Before this module the first reaper cycle after such an outage
 * failed every running backup with "no progress reported for 15 minutes".
 *
 * So the reaper only counts silence inside the current window: the stretch
 * during which it has evidence the server could record signals. A window
 * opens at the first healthy reaper cycle and closes on evidence that the
 * server could not record:
 *
 *   - the process started (first cycle): signals sent before the start, while
 *     the API was down or restarting, were never received;
 *   - the database reports the reaper's transaction is read-only (managed
 *     Postgres goes read-only when its disk fills; a replica in recovery is
 *     read-only too), so keepalive writes fail;
 *   - the backup reap pass itself threw (database unreachable, writes
 *     failing).
 *
 * The state is per process. Under BREEZE_ROLE=all every API process runs the
 * reaper and owns agent sockets, so an API restart restarts the window. An
 * outage longer than a couple of cycles is observed by whichever process
 * consumes those cycles. An API-only outage under the opt-in worker split is
 * not observed: the worker process keeps its window (see the PR for #11766).
 */

let windowStartMs: number | null = null;

/**
 * Record a cycle with no evidence of a recording problem. Opens a window at
 * `nowMs` if none is open, and returns the start of the open window.
 */
export function noteSignalRecordingHealthy(nowMs: number): number {
  if (windowStartMs === null) windowStartMs = nowMs;
  return windowStartMs;
}

/**
 * Record evidence that the server could not record agent signals. The next
 * healthy cycle opens a new window, so silence before it is not counted.
 */
export function noteSignalRecordingImpaired(): void {
  windowStartMs = null;
}

/** The start of the open window, or null when none is open. */
export function signalRecordingWindowStart(): number | null {
  return windowStartMs;
}

/**
 * Tests only: set the window start directly. 0 means "recording since the
 * epoch", so no silence is discounted; null means no window is open, like a
 * freshly started process.
 */
export function resetSignalRecordingWindowForTests(startMs: number | null): void {
  windowStartMs = startMs;
}
