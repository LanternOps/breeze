/**
 * A rolling count of Postgres CONNECT_TIMEOUT errors (#3214).
 *
 * WHY THIS EXISTS. When a pooled postgres.js connection is poisoned (see
 * `db/postgresJsPoolPoisoning.test.ts` for the mechanism), the only externally
 * visible symptom is a sustained stream of `write CONNECT_TIMEOUT` errors while
 * the database itself is perfectly healthy. In the incident behind #3214 that
 * stream ran at ~144/min for hours. It was never a first-class signal: it
 * existed only as individual Sentry events and console lines, so nobody could
 * see the RATE, and the pool decayed from 35 live connections to 9 before a
 * human noticed. This module makes the rate observable, which is what
 * `db/dbPoolHealthMonitor.ts` alerts on and what `/metrics` exports.
 *
 * WHY IT IS A ZERO-IMPORT LEAF. It is called from
 * `services/postgresConnectTimeout.ts`, which is itself in the module graph of
 * `services/sentry.ts` and of `db/requestDatabasePool.test.ts` (a suite under a
 * hard 15s budget). Importing anything from `db/` here would recreate the
 * `services -> db` back-edge that the connect-timeout classifier's docblock
 * exists to warn about. Keep this file dependency-free.
 *
 * WHAT THE NUMBER IS AND IS NOT. It is a FLOOR, not an exact count. Recording
 * happens in `safeDiagnoseConnectTimeout`, which both production call sites run:
 * the Hono `app.onError` handler and `services/sentry.ts`'s `captureException`.
 * The latter classifies ABOVE its `initialized` guard specifically so that
 * worker, scheduler and unhandledRejection paths are still counted on instances
 * with no Sentry DSN — without that, this counter saw only HTTP requests, which
 * is the one shape the original incident did NOT have.
 *
 * It is still a floor: a background path that swallows a DB error without
 * reporting it anywhere is invisible here, and the retention cap below biases
 * down. Treat a rising rate as evidence; NEVER treat a low or zero count as
 * proof that the pool is healthy. `db/dbPoolHealthMonitor.ts` is written to that
 * contract — its below-threshold verdict deliberately does not say "healthy".
 */

/** Causes mirror `ConnectTimeoutCause` in `services/postgresConnectTimeout.ts`. */
export type DbConnectTimeoutCause = 'event-loop-starvation' | 'connectivity' | 'unknown';

export interface DbConnectTimeoutWindowStats {
  /** Timeouts recorded within `windowMs` of `now`. */
  timeouts: number;
  /** Per-cause breakdown of `timeouts`. Always has all three keys. */
  byCause: Record<DbConnectTimeoutCause, number>;
  /** The window the counts cover, in ms. */
  windowMs: number;
  /** `timeouts` normalised to a per-minute rate over `windowMs`. */
  ratePerMin: number;
  /** Total recorded since process start (never trimmed). Monotonic. */
  totalSinceStart: number;
}

/**
 * Notified once per recorded timeout so `routes/metrics.ts` can drive a
 * Prometheus counter without this leaf module importing `prom-client`. Same
 * inversion the action-intent metrics use.
 */
export interface DbConnectTimeoutMetricsRecorder {
  onConnectTimeout(cause: DbConnectTimeoutCause): void;
}

let recorder: DbConnectTimeoutMetricsRecorder | null = null;

export function setDbConnectTimeoutMetricsRecorder(
  next: DbConnectTimeoutMetricsRecorder | null,
): void {
  recorder = next;
}

/**
 * Hard cap on retained samples. The window is time-based, but a pathological
 * storm (the incident ran at ~144/min; a worse one is imaginable) must not grow
 * the array without bound between trims. At the default 5-minute window this is
 * ~13x headroom over the observed incident rate. Once the cap is hit the OLDEST
 * samples are dropped, which biases the count DOWN — consistent with the
 * "floor, never an overcount" contract above.
 */
const MAX_RETAINED_SAMPLES = 10_000;

/** Default window. Long enough to smooth a bursty stream, short enough to react. */
export const DEFAULT_CONNECT_TIMEOUT_WINDOW_MS = 5 * 60_000;

interface Sample {
  at: number;
  cause: DbConnectTimeoutCause;
}

let samples: Sample[] = [];
let totalSinceStart = 0;
let recorderFailureLogged = false;
/**
 * The widest window any consumer has asked for. Retention is trimmed against
 * THIS, never the current caller's window — see `getDbConnectTimeoutStats`.
 */
let maxRequestedWindowMs = DEFAULT_CONNECT_TIMEOUT_WINDOW_MS;

/**
 * Marks an error object as already counted.
 *
 * Both production call sites classify the SAME error object: `app.onError`
 * diagnoses it for the console line, then `captureException` diagnoses it again
 * for the Sentry tags. Without this, every request-path timeout would count
 * twice while every worker-path timeout counted once — a rate metric that is
 * silently 2x wrong on part of its input is worse than no rate metric, because
 * an alert threshold tuned on it means nothing.
 *
 * A Symbol (not a property name) so it cannot collide with driver or Drizzle
 * fields, and non-enumerable so it never leaks into a serialized error body.
 */
const COUNTED = Symbol.for('breeze.dbConnectTimeoutCounted');

function alreadyCounted(err: unknown): boolean {
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) {
    // Primitives cannot carry the marker. Count them; they are vanishingly rare
    // and under-counting is the failure mode we accept, not double-counting.
    return false;
  }
  try {
    const target = err as Record<PropertyKey, unknown>;
    if (target[COUNTED] === true) return true;
    Object.defineProperty(target, COUNTED, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: true,
    });
    return false;
  } catch {
    // Frozen or exotic error (a Proxy with a throwing trap). Falling through to
    // "not yet counted" risks a double count for that one object; refusing to
    // count it at all would lose the signal entirely. Prefer the signal.
    return false;
  }
}

/**
 * Record one CONNECT_TIMEOUT. Idempotent per error object (see `COUNTED`).
 * Never throws: this runs on an error path, where a throw would displace the
 * original failure.
 *
 * `now` is injectable for tests; production omits it.
 */
export function recordDbConnectTimeout(
  err: unknown,
  cause: DbConnectTimeoutCause,
  now: number = Date.now(),
): void {
  try {
    if (alreadyCounted(err)) return;
    samples.push({ at: now, cause });
    totalSinceStart += 1;
    if (samples.length > MAX_RETAINED_SAMPLES) {
      // Drop the OLDEST — see MAX_RETAINED_SAMPLES. Trimming the newest instead
      // would zero the rate during exactly the storm the cap exists for.
      samples = samples.slice(samples.length - MAX_RETAINED_SAMPLES);
    }
  } catch {
    // Counting a failure must never become one.
  }

  // Separate try, and deliberately AFTER the sample is recorded: a throwing
  // recorder must not be able to corrupt the internal window count.
  try {
    recorder?.onConnectTimeout(cause);
  } catch (recorderErr) {
    // The recorder is a stable closure over a prom-client counter, so a throw
    // here is not one lost increment — it will throw every time, and
    // `breeze_db_connect_timeouts_total` then flatlines at its seeded 0 for the
    // life of the process while this module's own window keeps working. A
    // dashboard would show a clean chart during an active storm. Latched so the
    // condition is stated once rather than either hidden or flooding the log.
    if (!recorderFailureLogged) {
      recorderFailureLogged = true;
      console.error(
        '[db-connect-timeout-stats] metrics recorder threw; '
        + 'breeze_db_connect_timeouts_total will not advance for the rest of this process:',
        recorderErr,
      );
    }
  }
}

/**
 * Summarise the trailing `windowMs`. Trims expired samples as a side effect, so
 * a quiet process does not retain a storm from an hour ago.
 *
 * Retention is trimmed against the WIDEST window any caller has ever requested,
 * not this caller's. The samples are shared module state, so trimming to the
 * caller's own window would let a narrow reader permanently destroy evidence a
 * wider reader depends on: a future 60s `/health` readout or debug endpoint
 * would silently truncate the watchdog's 5-minute window, drop its count below
 * threshold, and produce a below-threshold verdict in the middle of a live
 * storm — with nothing going red.
 */
export function getDbConnectTimeoutStats(
  windowMs: number = DEFAULT_CONNECT_TIMEOUT_WINDOW_MS,
  now: number = Date.now(),
): DbConnectTimeoutWindowStats {
  const effectiveWindowMs = windowMs > 0 ? windowMs : DEFAULT_CONNECT_TIMEOUT_WINDOW_MS;
  maxRequestedWindowMs = Math.max(maxRequestedWindowMs, effectiveWindowMs);
  samples = samples.filter((s) => s.at >= now - maxRequestedWindowMs);

  const cutoff = now - effectiveWindowMs;
  const inWindow = samples.filter((s) => s.at >= cutoff);

  const byCause: Record<DbConnectTimeoutCause, number> = {
    'event-loop-starvation': 0,
    connectivity: 0,
    unknown: 0,
  };
  for (const s of inWindow) {
    byCause[s.cause] += 1;
  }

  const timeouts = inWindow.length;
  return {
    timeouts,
    byCause,
    windowMs: effectiveWindowMs,
    ratePerMin: (timeouts * 60_000) / effectiveWindowMs,
    totalSinceStart,
  };
}

export function __resetDbConnectTimeoutStatsForTests(): void {
  samples = [];
  totalSinceStart = 0;
  recorder = null;
  recorderFailureLogged = false;
  maxRequestedWindowMs = DEFAULT_CONNECT_TIMEOUT_WINDOW_MS;
}
