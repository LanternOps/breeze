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
 *   - the backup reap pass threw a database-unavailability error, or the
 *     system database context it runs in could not be opened at all (no pool
 *     slot in time, BEGIN or the RLS setup queries failed or timed out): see
 *     isSignalRecordingFailure. Any other error is a reaper bug, not an
 *     outage, and leaves the window alone.
 *
 * A pool or setup timeout under ordinary load closes the window too, because
 * the reaper cannot tell it from an outage. So a run of closures is never
 * silent: every SIGNAL_WINDOW_RESET_WARN_EVERY closures without the window
 * staying open for a full reaper cycle log a warning with the count.
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
import {
  DbAccessContextPrologueAbortedError,
  DbAccessContextPrologueTimeoutError,
  DbPoolAcquireAbortedError,
  DbPoolAcquireTimeoutError,
} from '../db/prologueDeadline';
import { pgErrorCode } from '../utils/pgErrors';

/**
 * A warning is logged each time this many window closures have happened in a
 * row, i.e. without the window staying open across a full reaper cycle.
 */
export const SIGNAL_WINDOW_RESET_WARN_EVERY = 5;

let windowStartMs: number | null = null;
let readOnlyEpisode = false;
let probeUnreadableReported = false;
let consecutiveResets = 0;
// Errors already counted: the backup pass notes a failure and rethrows it, and
// the reaper cycle sees the same object again from the context wrapper.
let notedFailures = new WeakSet<object>();

/**
 * Record a cycle with no evidence of a recording problem. Opens a window at
 * `nowMs` if none is open, and returns the start of the open window. A window
 * found already open has survived a full cycle, which ends any run of resets.
 */
export function noteSignalRecordingHealthy(nowMs: number): number {
  readOnlyEpisode = false;
  if (windowStartMs === null) windowStartMs = nowMs;
  else consecutiveResets = 0;
  return windowStartMs;
}

function closeWindow(cause: string): void {
  windowStartMs = null;
  consecutiveResets += 1;
  if (consecutiveResets % SIGNAL_WINDOW_RESET_WARN_EVERY !== 0) return;
  console.warn(
    `[StaleCommandReaper] The backup signal-recording window has been reset ${consecutiveResets} times in a row ` +
    `without staying open for a full reaper cycle (latest cause: ${cause}). While this continues no running backup ` +
    'job can be failed for silence (rules A, B and D; rule C still applies) and no pending job for a dispatch that ' +
    'never completed. ' +
    'If the database is otherwise healthy, look for recurring pool-acquire or context-setup timeouts.',
  );
}

/**
 * Record evidence that the server could not record agent signals when `err`
 * means the database could not serve the reaper (see isSignalRecordingFailure),
 * and return whether it did. The next healthy cycle opens a new window, so
 * silence before it is not counted. The same error object is counted once,
 * however many layers report it.
 */
export function noteSignalRecordingFailure(err: unknown): boolean {
  if (!isSignalRecordingFailure(err)) return false;
  if (typeof err === 'object' && err !== null) {
    if (notedFailures.has(err)) return true;
    notedFailures.add(err);
  }
  closeWindow(describeSignalRecordingFailure(err));
  return true;
}

/**
 * Record a cycle that found the database read-only. Closes the window like
 * noteSignalRecordingFailure, and returns true when this starts a read-only
 * episode (the first such cycle since the last healthy one, or since the
 * process started), so the caller can say so once per episode.
 */
export function noteDatabaseReadOnly(): boolean {
  closeWindow('database read-only');
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

// Raised by the database context openers (db/index.ts) before the caller's
// work runs: no pool slot within the acquire budget, a connection handed over
// after it, or RLS setup queries that did not finish in time. They carry no
// SQLSTATE, so they are recognised by type.
const CONTEXT_OPEN_ERROR_TYPES = [
  DbPoolAcquireTimeoutError,
  DbPoolAcquireAbortedError,
  DbAccessContextPrologueTimeoutError,
  DbAccessContextPrologueAbortedError,
] as const;

const MAX_CAUSE_DEPTH = 5;

function contextOpenError(err: unknown): Error | null {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const found = current;
    if (CONTEXT_OPEN_ERROR_TYPES.some((type) => found instanceof type)) return found;
    current = found.cause;
  }
  return null;
}

function describeSignalRecordingFailure(err: unknown): string {
  const contextError = contextOpenError(err);
  if (contextError) return contextError.name;
  return `database error ${pgErrorCode(err) ?? 'without a code'}`;
}

/**
 * True when an error means the database could not serve the reaper, and so
 * could not have recorded keepalives either: SQLSTATE class 08 (connection),
 * 25006 (read-only transaction), 53 (insufficient resources: disk full, out of
 * memory, too many connections), 57P0x (shutdown, cannot connect now), 58
 * (system/I/O error), a dropped or refused connection, or a database context
 * that could not be opened in time (pool acquire or setup-query timeout).
 */
export function isSignalRecordingFailure(err: unknown): boolean {
  if (contextOpenError(err)) return true;
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
  consecutiveResets = 0;
  notedFailures = new WeakSet<object>();
}
