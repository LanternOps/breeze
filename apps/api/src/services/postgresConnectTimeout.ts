/**
 * Tells apart the two very different things postgres.js reports with the same
 * `CONNECT_TIMEOUT` error (#3022).
 *
 * The driver arms `connect_timeout` with a plain `setTimeout`
 * (`postgres/src/connection.js:1042-1054`), starts it in `connect()` right after
 * the socket is created (`:343`), and cancels it only on ReadyForQuery (`:552`).
 * So the budget covers socket create → TCP → SSL → auth → ReadyForQuery, and
 * every one of those steps needs the event loop to run a socket callback. Two
 * unrelated conditions therefore produce a byte-identical error:
 *
 *   1. The handshake genuinely failed — the DB is down, unreachable, refusing,
 *      or too slow. A real connectivity fault.
 *   2. The handshake was fine but this process never got scheduled. The main
 *      thread was pegged, the socket callbacks queued up behind it, and the
 *      timer fired on a connection that was never actually in trouble.
 *
 * Case 2 is what #3022 turned out to be, and the driver's message —
 * `write CONNECT_TIMEOUT <host>:<port>` — actively points investigation at the
 * database and the network, both of which measured healthy throughout. Naming
 * the cause at the point the error is reported is most of the fix: it turns a
 * multi-hour "is the DB failing over?" hunt into a line that says the loop was
 * blocked for N ms.
 *
 * This module deliberately does NOT change control flow. It does not retry, it
 * does not remap the HTTP status, and it does not raise `connect_timeout` —
 * per #3022 a longer timeout just lengthens the failing request. It classifies
 * and describes; that is all.
 *
 * WHY IT LIVES IN services/ AND NOT db/: `services/sentry.ts` calls it, and
 * `db/index.ts` imports `services/sentry.ts`. Putting the classifier under db/
 * therefore created a `services → db` back-edge that dragged the whole db
 * subtree (schema, drizzle, the pool) into the module graph of anything that
 * reports an error — slow enough to push db/requestDatabasePool.test.ts past
 * its timeout. Nothing here needs the db module; it reads a driver error's
 * `code` and the event-loop monitor. Keep the dependency direction db → services.
 */

import { pgErrorCode } from '../utils/pgErrors';
import { recordDbConnectTimeout } from './dbConnectTimeoutStats';
import {
  bucketEventLoopLag,
  getEventLoopStarvationThresholdMs,
  readEventLoopLag,
  type EventLoopLagBucket,
  type EventLoopLagReading,
} from './eventLoopMonitor';

/**
 * postgres.js `connect_timeout`, in seconds — the single source of truth,
 * imported by the pool config in `db/index.ts`.
 *
 * Deliberately left at 10 (see the module docblock): #3022 concluded that
 * raising it alone is not a fix, because a starved loop simply fails ten
 * seconds later while holding the request slot for longer.
 */
export const POSTGRES_CONNECT_TIMEOUT_SECONDS = 10;

/**
 * The lag at or above which a CONNECT_TIMEOUT is attributed to the event loop.
 *
 * Capped at the connect budget on purpose. EVENT_LOOP_STARVATION_WARN_MS is a
 * *warning volume* knob — an operator quieting a noisy instance may raise it
 * freely, and has no reason to think that touches error attribution. Used
 * uncapped it does: at 15000 a 12s stall that demonstrably consumed the entire
 * 10s budget would be reported as `connectivity` — "the event loop stayed
 * healthy, check database reachability" — which is the precise misdirection
 * this module exists to remove, restated with the authority of a verdict.
 *
 * A stall at least as long as the window is sufficient on its own to explain
 * the timeout, so no configuration may classify it as anything else.
 */
export function getConnectTimeoutStarvationThresholdMs(): number {
  return Math.min(
    getEventLoopStarvationThresholdMs(),
    POSTGRES_CONNECT_TIMEOUT_SECONDS * 1_000,
  );
}

/** The driver's `code`/`errno` for a connect-phase timeout. */
export const CONNECT_TIMEOUT_CODE = 'CONNECT_TIMEOUT';

export type ConnectTimeoutCause =
  /** The loop was measurably blocked; the timeout is an artefact of that. */
  | 'event-loop-starvation'
  /** The loop was healthy, so the handshake really did fail. */
  | 'connectivity'
  /** No event-loop monitor was running, so there is nothing to conclude. */
  | 'unknown';

export interface ConnectTimeoutDiagnosis {
  cause: ConnectTimeoutCause;
  /** Worst event-loop lag observed across the connect window, in ms. */
  worstLagMs: number;
  /** The window that was examined, in ms (the connect budget). */
  windowMs: number;
  starvationThresholdMs: number;
  /** Bounded, low-cardinality lag band — safe to use as a Sentry tag. */
  lagBucket: EventLoopLagBucket;
  /** Operator-facing one-liner. Always states the measurement, never just the verdict. */
  message: string;
}

/**
 * True for a postgres.js connect-phase timeout, including one wrapped by
 * Drizzle (whose own `.code` is undefined — the driver's fields live on
 * `.cause`, which `pgErrorCode` walks).
 */
export function isPostgresConnectTimeout(err: unknown): boolean {
  return pgErrorCode(err) === CONNECT_TIMEOUT_CODE;
}

/**
 * Classify a thrown error. Returns null when it is not a connect timeout, so
 * callers can use it as their branch condition directly.
 *
 * `reading` is injectable for tests; production omits it and the current
 * process-wide monitor is consulted over the connect window.
 */
export function diagnoseConnectTimeout(
  err: unknown,
  reading?: EventLoopLagReading,
): ConnectTimeoutDiagnosis | null {
  if (!isPostgresConnectTimeout(err)) return null;

  const windowMs = POSTGRES_CONNECT_TIMEOUT_SECONDS * 1_000;
  const lag = reading ?? readEventLoopLag(windowMs);
  const worstLagMs = Math.round(lag.worstLagMs);

  const starvationThresholdMs = getConnectTimeoutStarvationThresholdMs();

  // Fail to 'unknown', never to 'connectivity'. Without evidence covering the
  // window, quietly asserting "the database was unreachable" is precisely the
  // misdirection this module exists to remove.
  //
  // `coversWindow` matters as much as `monitored` here: a monitor that is
  // running but has been up for less than the connect budget — or that samples
  // more coarsely than the budget is wide — reports a lag of 0 meaning "not
  // observed", not "did not happen". Reading that as health would produce a
  // confident, wrong verdict with MORE authority than the bare driver error.
  const evidence = lag.monitored && lag.coversWindow;
  const cause: ConnectTimeoutCause = !evidence
    ? 'unknown'
    : worstLagMs >= starvationThresholdMs
      ? 'event-loop-starvation'
      : 'connectivity';

  return {
    cause,
    worstLagMs,
    windowMs,
    starvationThresholdMs,
    lagBucket: bucketEventLoopLag(worstLagMs, evidence),
    message: describe(cause, worstLagMs, windowMs, starvationThresholdMs),
  };
}

function describe(
  cause: ConnectTimeoutCause,
  worstLagMs: number,
  windowMs: number,
  thresholdMs: number,
): string {
  const prefix =
    `[db] Postgres CONNECT_TIMEOUT after ${windowMs}ms. That budget is measured in-process `
    + `and covers socket create → TCP → SSL → auth, so it also expires when this process `
    + `simply never gets scheduled (#3022).`;

  switch (cause) {
    case 'event-loop-starvation':
      return (
        `${prefix} The event loop was blocked for up to ${worstLagMs}ms inside that window `
        + `(>= ${thresholdMs}ms) — treat this as main-thread starvation, NOT a database or `
        + `network fault. Look for CPU-bound request work, not for a DB incident.`
      );
    case 'connectivity':
      return (
        `${prefix} The event loop stayed healthy (worst lag ${worstLagMs}ms < ${thresholdMs}ms), `
        + `so the handshake itself failed — check database reachability, TLS, and auth.`
      );
    case 'unknown':
      return (
        `${prefix} No event-loop measurement covers that window — the monitor is disabled, has `
        + `not been running for a full ${windowMs}ms yet, is shutting down, or samples more `
        + `coarsely than the window is wide (EVENT_LOOP_MONITOR_INTERVAL_MS). Starvation could `
        + `be neither ruled in nor out, so do NOT conclude this was a database fault.`
      );
  }
}

/**
 * Never-throwing wrapper. Both production call sites — `services/sentry.ts`'s
 * captureException and the Hono `app.onError` handler — run while an error is
 * already in flight, and in `onError` a throw would cost the request its JSON
 * 500 AND prevent the original error from ever reaching Sentry. `pgErrorCode`
 * walks `.cause` and reads `.code` off arbitrary objects, so a hostile or exotic
 * error with a throwing getter is not purely hypothetical.
 *
 * Use this, not `diagnoseConnectTimeout`, anywhere the caller is itself an
 * error path.
 */
export function safeDiagnoseConnectTimeout(err: unknown): ConnectTimeoutDiagnosis | null {
  try {
    const diagnosis = diagnoseConnectTimeout(err);
    // Feed the rolling rate (#3214). Deliberately here and not in
    // `diagnoseConnectTimeout`: this wrapper is what BOTH production call sites
    // use, whereas the bare classifier is also called directly by its own unit
    // tests, which must not mutate process-wide counters. `recordDbConnectTimeout`
    // is idempotent per error object, so the two call sites seeing the same
    // error (onError, then captureException) count it once.
    if (diagnosis) recordDbConnectTimeout(err, diagnosis.cause);
    return diagnosis;
  } catch {
    // Diagnosis is commentary on someone else's failure; it must never become
    // the failure. Silence here costs two Sentry tags and a log line.
    return null;
  }
}
