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
 * happens in `safeDiagnoseConnectTimeout`, which both production call sites (the
 * Hono `app.onError` handler and `services/sentry.ts`'s `captureException`) run
 * — but a background worker that swallows a DB error without reporting it will
 * not be counted. Treat a rising rate as evidence; never treat a zero as proof
 * that no timeouts occurred.
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
      samples = samples.slice(samples.length - MAX_RETAINED_SAMPLES);
    }
    recorder?.onConnectTimeout(cause);
  } catch {
    // Counting a failure must never become one.
  }
}

/**
 * Summarise the trailing `windowMs`. Trims expired samples as a side effect, so
 * a quiet process does not retain a storm from an hour ago.
 */
export function getDbConnectTimeoutStats(
  windowMs: number = DEFAULT_CONNECT_TIMEOUT_WINDOW_MS,
  now: number = Date.now(),
): DbConnectTimeoutWindowStats {
  const effectiveWindowMs = windowMs > 0 ? windowMs : DEFAULT_CONNECT_TIMEOUT_WINDOW_MS;
  const cutoff = now - effectiveWindowMs;
  samples = samples.filter((s) => s.at >= cutoff);

  const byCause: Record<DbConnectTimeoutCause, number> = {
    'event-loop-starvation': 0,
    connectivity: 0,
    unknown: 0,
  };
  for (const s of samples) {
    byCause[s.cause] += 1;
  }

  const timeouts = samples.length;
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
}
