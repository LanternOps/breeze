import { captureException } from '../services/sentry';
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
 * succeeds (logged once) or fails with anything other than 25006 (logged and
 * reported, and the retry stops: that is a real bug, not the database state).
 * While the database stays read-only the retry is quiet.
 */

export const DEFERRED_WRITE_RETRY_MS = 60_000;

interface Deferred {
  timer: NodeJS.Timeout;
  running: boolean;
}

const deferred = new Map<string, Deferred>();

/** True while `label`'s write is waiting for a writable database. */
export function isDeferredUntilWritable(label: string): boolean {
  return deferred.has(label);
}

export function deferUntilDatabaseWritable(
  label: string,
  task: () => Promise<void>,
  options: { intervalMs?: number } = {},
): void {
  if (deferred.has(label)) return;
  const intervalMs = options.intervalMs ?? DEFERRED_WRITE_RETRY_MS;
  console.warn(
    `[db] ${label}: the database is read-only (SQLSTATE 25006); deferred until it accepts writes ` +
      `(retried every ${Math.round(intervalMs / 1000)}s).`,
  );

  const entry: Deferred = {
    running: false,
    timer: setInterval(() => {
      if (entry.running) return;
      entry.running = true;
      void task()
        .then(() => {
          stop(label, entry);
          console.log(`[db] ${label}: deferred write completed; the database accepts writes again.`);
        })
        .catch((error: unknown) => {
          if (isReadOnlySqlError(error)) return; // still read-only (or a stale session); keep waiting
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

function stop(label: string, entry: Deferred): void {
  clearInterval(entry.timer);
  if (deferred.get(label) === entry) deferred.delete(label);
}

/** Clears every pending retry (tests, shutdown). */
export function __resetDeferredWritesForTests(): void {
  for (const [label, entry] of deferred) stop(label, entry);
}
