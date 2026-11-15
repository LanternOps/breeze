import { captureException } from '../services/sentry';
import { pgErrorCode } from '@breeze/shared/pgErrors';
import { isReadOnlySqlError } from './readOnlyDatabase';

/**
 * #11741 item 2: a startup write that hit a read-only database runs again once
 * the database accepts writes, instead of failing the caller for the life of
 * the process.
 *
 * Before this, a worker initializer that wrote during `init()` (the CIS
 * catalog seed, the patch-settings repair) threw SQLSTATE 25006 on a
 * read-only boot. The registry then marked its consumers terminally failed,
 * and `/health/ready` kept reporting `workers-pending` after the provider made
 * the database writable again, until the API restarted. Retrying the whole
 * initializer is not safe (it has usually created and attached its BullMQ
 * Worker before the write, and readiness refuses a second attachment), so the
 * initializer catches the read-only error, carries on, and hands just the
 * write to this helper.
 *
 * The retry runs every `intervalMs` (60 s), one run at a time, until the task
 * succeeds (logged once) or fails with an error that is neither 25006 nor a
 * connection fault (logged and reported, and the retry stops: that is a real
 * bug, not the database state). A read-only episode often comes with a
 * failover or restart, so a refused, reset or terminated connection keeps
 * waiting too. While waiting, one reminder is logged every
 * `REMINDER_EVERY_ATTEMPTS` attempts (30 min at the default interval).
 *
 * Shutdown calls `stopDeferredWrites()`: every pending retry is cleared and no
 * new retry starts, so nothing retries against a pool that is draining or
 * closed. A run already in flight settles quietly unless it fails with an
 * error that is neither read-only nor a connection fault.
 */

export const DEFERRED_WRITE_RETRY_MS = 60_000;
const REMINDER_EVERY_ATTEMPTS = 30;

/**
 * Connection-class failures: SQLSTATE class 08 (connection exception), the
 * 57P0x shutdown/startup codes, too many connections, and the socket and
 * postgres.js connection codes. `pgErrorCode` reads `code` from the error or
 * its `cause`, which is where both drivers and Node put these.
 */
const TRANSIENT_CODES = new Set([
  '57P01', '57P02', '57P03', '53300',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECT_TIMEOUT',
]);

/** True for an error that says "try again later", not "this write is wrong". */
export function isRetryableWhileDeferred(error: unknown): boolean {
  if (isReadOnlySqlError(error)) return true;
  const code = pgErrorCode(error);
  return code !== undefined && (code.startsWith('08') || TRANSIENT_CODES.has(code));
}

interface Deferred {
  timer: NodeJS.Timeout;
  running: boolean;
  attempts: number;
}

const deferred = new Map<string, Deferred>();
/** Set by stopDeferredWrites() (shutdown): no new retry starts. */
let stopped = false;

/** True while `label`'s write is waiting for a writable database. */
export function isDeferredUntilWritable(label: string): boolean {
  return deferred.has(label);
}

export function deferUntilDatabaseWritable(
  label: string,
  task: () => Promise<void>,
  options: { intervalMs?: number } = {},
): void {
  if (stopped) {
    console.warn(`[db] ${label}: not deferred; the process is shutting down (it runs again on the next boot).`);
    return;
  }
  if (deferred.has(label)) return;
  const intervalMs = options.intervalMs ?? DEFERRED_WRITE_RETRY_MS;
  console.warn(
    `[db] ${label}: the database is read-only (SQLSTATE 25006); deferred until it accepts writes ` +
      `(retried every ${Math.round(intervalMs / 1000)}s).`,
  );

  const entry: Deferred = {
    running: false,
    attempts: 0,
    timer: setInterval(() => {
      if (entry.running) return;
      entry.running = true;
      entry.attempts += 1;
      void task()
        .then(() => {
          if (!isCurrent(label, entry)) return; // stopped while in flight
          stop(label, entry);
          console.log(`[db] ${label}: deferred write completed; the database accepts writes again.`);
        })
        .catch((error: unknown) => {
          if (!isCurrent(label, entry)) {
            // Stopped while in flight (shutdown). A read-only or connection
            // error is expected while the pool drains; anything else is a
            // real fault and is still reported.
            if (!isRetryableWhileDeferred(error)) {
              console.error(`[db] ${label}: deferred write failed during shutdown:`, error);
              captureException(error, undefined, { area: 'deferred_write_retry' });
            }
            return;
          }
          if (isRetryableWhileDeferred(error)) {
            // Still read-only, a stale session, or the database is restarting.
            if (entry.attempts % REMINDER_EVERY_ATTEMPTS === 0) {
              const message = error instanceof Error ? error.message : String(error);
              console.warn(
                `[db] ${label}: still deferred after ${entry.attempts} attempts; last error: ${message}`,
              );
            }
            return;
          }
          stop(label, entry);
          console.error(`[db] ${label}: deferred write failed after the database became writable:`, error);
          captureException(error, undefined, { area: 'deferred_write_retry' });
        })
        .finally(() => {
          entry.running = false;
        });
    }, intervalMs),
  };
  entry.timer.unref?.();
  deferred.set(label, entry);
}

function isCurrent(label: string, entry: Deferred): boolean {
  return deferred.get(label) === entry;
}

function stop(label: string, entry: Deferred): void {
  clearInterval(entry.timer);
  if (isCurrent(label, entry)) deferred.delete(label);
}

/**
 * Shutdown: clears every pending retry and refuses new ones for the rest of
 * the process. A write still waiting is dropped; it runs again on the next
 * boot, where the initializer that deferred it repeats.
 */
export function stopDeferredWrites(): void {
  stopped = true;
  for (const [label, entry] of deferred) stop(label, entry);
}

/** Clears every pending retry and re-arms the helper (tests). */
export function __resetDeferredWritesForTests(): void {
  for (const [label, entry] of deferred) stop(label, entry);
  stopped = false;
}
