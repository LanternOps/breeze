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
 *   - the backup reap pass threw a database-unavailability error (see
 *     isSignalRecordingFailure). Any other error is a reaper bug, not an
 *     outage, and leaves the window alone.
 *
 * The state is per process. The reaper is one repeatable queue job, so each
 * cycle runs on one consumer: an API process under BREEZE_ROLE=all, or the
 * worker process under the opt-in worker split. A process that restarts opens
 * a fresh window. An outage is seen only by the processes that consume a cycle
 * during it; with a cycle every two minutes, a process that consumes none of
 * an outage's cycles is unlikely but possible once several processes share the
 * queue.
 *
 * Known gap: under the worker split, an outage of the API alone (agent signals
 * not received, database healthy) is not seen by the worker, so silence during
 * it is still counted.
 */
import { pgErrorCode } from '../utils/pgErrors';

let windowStartMs: number | null = null;
let readOnlyEpisode = false;
let probeUnreadableReported = false;

/**
 * Record a cycle with no evidence of a recording problem. Opens a window at
 * `nowMs` if none is open, and returns the start of the open window.
 */
export function noteSignalRecordingHealthy(nowMs: number): number {
  readOnlyEpisode = false;
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

/**
 * Record a cycle that found the database read-only. Closes the window like
 * noteSignalRecordingImpaired, and returns true when this starts a read-only
 * episode (the first such cycle since the last healthy one, or since the
 * process started), so the caller can say so once per episode.
 */
export function noteDatabaseReadOnly(): boolean {
  windowStartMs = null;
  const started = !readOnlyEpisode;
  readOnlyEpisode = true;
  return started;
}

/**
 * Record that the read-only probe returned a shape it could not read. Returns
 * true the first time in this process, so the caller reports it once.
 */
export function noteReadOnlyProbeUnreadable(): boolean {
  const first = !probeUnreadableReported;
  probeUnreadableReported = true;
  return first;
}

/** The start of the open window, or null when none is open. */
export function signalRecordingWindowStart(): number | null {
  return windowStartMs;
}

// postgres.js / Node socket codes for a connection that failed or dropped.
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN',
  'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT',
]);

/**
 * True when an error means the database could not serve the reaper, and so
 * could not have recorded keepalives either: SQLSTATE class 08 (connection),
 * 25006 (read-only transaction), 53 (insufficient resources: disk full, out of
 * memory, too many connections), 57P0x (shutdown, cannot connect now), 58
 * (system/I/O error), or a dropped or refused connection.
 */
export function isSignalRecordingFailure(err: unknown): boolean {
  const code = pgErrorCode(err);
  if (!code) return false;
  if (code === '25006') return true;
  if (/^(08|53|57P0|58)/.test(code)) return true;
  return CONNECTION_ERROR_CODES.has(code);
}

/**
 * Tests only: set the window start directly. 0 means "recording since the
 * epoch", so no silence is discounted; null means no window is open, like a
 * freshly started process.
 */
export function resetSignalRecordingWindowForTests(startMs: number | null): void {
  windowStartMs = startMs;
  readOnlyEpisode = false;
  probeUnreadableReported = false;
}
