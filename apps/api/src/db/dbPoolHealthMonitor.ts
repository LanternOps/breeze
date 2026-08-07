/**
 * Pool-health watchdog for the postgres.js connection-poisoning failure (#3214).
 *
 * THE FAILURE IT WATCHES FOR. postgres.js 3.4.9 leaves a pooled connection
 * permanently unable to flush a deferred write once its socket dies with one
 * buffered — see `db/postgresJsPoolPoisoning.test.ts`, which reproduces the
 * defect deterministically and cites the exact upstream lines. A poisoned slot
 * then reconnects forever, timing out at `connect_timeout` every time. Slots are
 * lost one at a time (in the production incident: 35 configured, 9 live after a
 * few hours) and only an API restart recovers them.
 *
 * WHY A WATCHDOG AND NOT A FIX. The broken state lives inside a closure in the
 * driver; nothing outside the driver can reach it. This module cannot repair the
 * pool. What it CAN do is collapse the diagnosis — which took hours of manual
 * work during the incident — into a single automatic verdict.
 *
 * THE DIAGNOSTIC TRICK. A sustained CONNECT_TIMEOUT rate on its own is
 * ambiguous: it looks identical whether the database is unreachable or the pool
 * is poisoned. The two are told apart by opening a BRAND NEW, single-use
 * connection to the same database, outside the main pool. A fresh postgres.js
 * client gets fresh connection closures, so it is immune to the poisoning:
 *
 *   - fresh connection succeeds  -> the DB is fine and the POOL is the problem
 *   - fresh connection also fails -> a real database/network fault
 *
 * That is exactly the manual step ("`psql` from the same host connected in under
 * a second") that ended the incident's guessing, performed automatically.
 *
 * WHAT THIS MODULE NEVER CLAIMS. There is no `healthy` verdict, on purpose. The
 * only evidence it has is a connect-timeout count that `dbConnectTimeoutStats`
 * documents as a FLOOR, and it does not observe pool slot occupancy at all — so
 * a pool that has quietly lost most of its slots while producing few
 * request-visible timeouts is below threshold, not proven well. The quiet verdict
 * is therefore named `below-threshold`, and every message states the measurement
 * rather than only the conclusion. Publishing an affirmative all-clear from
 * evidence that cannot support one is the failure mode this whole area of the
 * codebase exists to avoid.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not recycle or replace the `sql`
 * instance. `db/index.ts` hands the client to Drizzle at module load, and the
 * resulting `baseDb` is captured by the exported proxy, by every open
 * `withDbAccessContext` transaction, and by the AsyncLocalStorage stores.
 * Swapping it mid-flight would abort in-flight tenant transactions, and a bug in
 * that swap is a whole-API outage. Recycling is tracked separately; this module
 * is warn-only by design.
 */

import postgres from 'postgres';
import { captureMessage } from '../services/sentry';
import {
  DEFAULT_CONNECT_TIMEOUT_WINDOW_MS,
  getDbConnectTimeoutStats,
  type DbConnectTimeoutWindowStats,
} from '../services/dbConnectTimeoutStats';
import { resolveRequestDatabaseConfig } from './requestDatabaseConfig';

export type DbPoolHealthVerdict =
  /**
   * Connect-timeout rate is below the alert threshold, so no probe was run.
   * NOT a clean bill of health — see the module docblock.
   */
  | 'below-threshold'
  /** Timeouts are sustained, but a fresh connection succeeds — the #3214 signature. */
  | 'pool-degraded'
  /** Timeouts are sustained and a fresh connection fails too — a real DB fault. */
  | 'database-unreachable'
  /** The probe could not be carried out or its result proves nothing. */
  | 'unknown';

export const DB_POOL_HEALTH_VERDICTS: readonly DbPoolHealthVerdict[] = [
  'below-threshold',
  'pool-degraded',
  'database-unreachable',
  'unknown',
];

export interface DbPoolHealthAssessment {
  verdict: DbPoolHealthVerdict;
  stats: DbConnectTimeoutWindowStats;
  /** The `timeouts`-in-window count at or above which the probe runs. */
  thresholdTimeouts: number;
  /** Wall time the fresh-connection probe took, or null when it did not run. */
  probeMs: number | null;
  /** Probe failure message, or null when the probe succeeded or did not run. */
  probeError: string | null;
  /** Operator-facing one-liner. Always states the measurement, not just the verdict. */
  message: string;
  /**
   * Short, STABLE headline used as the Sentry event title. Deliberately free of
   * counts and durations: Sentry groups by message text, so interpolating a rate
   * would mint a fresh issue on every capture, and an alert bound to an issue
   * that never repeats never fires twice. The numbers live in `message` (console)
   * and in the tags.
   */
  headline: string;
  at: number;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function envFlag(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? '').trim().toLowerCase());
}

function envInt(name: string, fallback: number, min: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(raw) || raw < min) return fallback;
  return raw;
}

export function isDbPoolHealthMonitorDisabled(): boolean {
  return envFlag('DB_POOL_HEALTH_DISABLED');
}

/** How often the watchdog evaluates. Floor of 5s so it cannot be tuned into a hot loop. */
export function getDbPoolHealthIntervalMs(): number {
  return envInt('DB_POOL_HEALTH_INTERVAL_MS', 60_000, 5_000);
}

/** Trailing window the connect-timeout count is taken over. */
export function getDbPoolHealthWindowMs(): number {
  return envInt('DB_POOL_HEALTH_WINDOW_MS', DEFAULT_CONNECT_TIMEOUT_WINDOW_MS, 30_000);
}

/**
 * Timeouts within the window that trigger the probe.
 *
 * Default 10 over 5 minutes (2/min). Set well above the handful of timeouts a
 * healthy instance can produce during a failover or a deploy, and far below the
 * ~144/min the incident sustained, so an alert on this means something.
 */
export function getDbPoolHealthMinTimeouts(): number {
  return envInt('DB_POOL_HEALTH_MIN_TIMEOUTS', 10, 1);
}

/**
 * Hard bound on the probe, CLAMPED to half the watchdog interval.
 *
 * The clamp is not decoration. `DB_POOL_HEALTH_PROBE_TIMEOUT_MS` has a floor and
 * no natural ceiling while the interval floors at 5s, so the two knobs can
 * legally be set such that every probe outlives its tick. Combined with the
 * in-flight guard in `startDbPoolHealthMonitor`, this keeps the watchdog from
 * opening a growing number of fresh connections to a database that — in the
 * `pool-degraded` case it is diagnosing — is already the scarce resource.
 */
export function getDbPoolHealthProbeTimeoutMs(
  intervalMs: number = getDbPoolHealthIntervalMs(),
): number {
  return Math.min(
    envInt('DB_POOL_HEALTH_PROBE_TIMEOUT_MS', 5_000, 1_000),
    Math.floor(intervalMs / 2),
  );
}

/**
 * A degraded pool is a persistent CONDITION, not N distinct errors — it stays
 * broken until someone restarts the process, so every tick would report it. This
 * repo has twice had an unthrottled recurring warning exhaust the Sentry event
 * quota and black out ALL error reporting org-wide, so the capture is throttled.
 * Console logging stays unthrottled.
 */
export function getDbPoolHealthCaptureThrottleMs(): number {
  return envInt('DB_POOL_HEALTH_CAPTURE_THROTTLE_MS', 15 * 60_000, 0);
}

/** A probe returns void on success and throws on failure. */
export type DbPoolHealthProbe = () => Promise<void>;

/**
 * Thrown when the probe could not even be ATTEMPTED — an unparseable connection
 * URL, a driver that refused to construct. Distinct from a probe that ran and
 * failed, because the two license different conclusions: a failed attempt is
 * evidence the database is unreachable, whereas an attempt that never happened
 * is evidence of nothing at all.
 *
 * Reporting the latter as `database-unreachable` would be a confident, wrong
 * verdict issued with more authority than the raw error it replaced — the exact
 * misdirection `services/postgresConnectTimeout.ts` exists to remove, restated
 * one layer up.
 */
export class DbPoolProbeUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DbPoolProbeUnavailableError';
  }
}

/**
 * Thrown when the probe's own wall-clock budget expired.
 *
 * Separate from a driver-reported failure because this budget is a plain
 * `setTimeout`, and a `setTimeout` expires just as readily when the main thread
 * is too busy to run the socket callbacks as when the connection genuinely
 * failed — the precise ambiguity `services/postgresConnectTimeout.ts` was
 * written to resolve for `connect_timeout` (#3022). Treating it as proof the
 * database is unreachable would reintroduce that bug one layer up: a pegged
 * event loop would be reported as a database fault, with an explicit
 * "restarting the API will not help" attached to it.
 */
export class DbPoolProbeTimedOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbPoolProbeTimedOutError';
  }
}

/**
 * Opens a single-use postgres.js client, runs `select 1`, and closes it.
 *
 * MUST NOT reuse the main pool — that is the entire diagnostic. A fresh client
 * builds fresh connection closures, so it is unaffected by a poisoned slot in
 * the main pool and can therefore prove the database is reachable while the pool
 * cannot reach it.
 */
export async function probeFreshDatabaseConnection(
  timeoutMs: number = getDbPoolHealthProbeTimeoutMs(),
): Promise<void> {
  let client: ReturnType<typeof postgres>;
  try {
    const { url } = resolveRequestDatabaseConfig();
    client = postgres(url, {
      max: 1,
      // postgres.js takes seconds. Ceil so a sub-second budget still permits one
      // real attempt rather than being floored to an instant timeout.
      connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
      idle_timeout: 1,
      max_lifetime: 30,
      // The probe is the one connection that must never be mistaken for request
      // traffic in pg_stat_activity while someone is debugging this exact failure.
      connection: { application_name: 'breeze-pool-health-probe' },
    });
  } catch (err) {
    // Config resolution or client construction failed, so no connection was ever
    // attempted. Say exactly that instead of blaming the database.
    throw new DbPoolProbeUnavailableError(
      `could not construct a probe client: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  try {
    // postgres.js has no pool-acquire timeout, so bound the whole attempt
    // ourselves — otherwise a probe against a saturated server could outlive the
    // watchdog interval and overlap the next tick.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      client`select 1`.then(() => undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new DbPoolProbeTimedOutError(`pool-health probe exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } finally {
    // Swallowed deliberately: this is cleanup on a diagnostic path, and a failed
    // close must not displace the probe's verdict. It is NOT free, though — a
    // failed close leaks the probe socket, and `pool-degraded` persists until
    // someone restarts, so this would run every tick until then and add one
    // leaked connection per tick to a database that is already under connection
    // pressure. Counted and logged rather than hidden.
    //
    // Routed through `Promise.resolve().then(...)` so a SYNCHRONOUS throw from
    // `end()` also lands in the catch instead of escaping this `finally` and
    // replacing the probe's real outcome.
    // `timeout: 0` destroys immediately instead of waiting to drain, so a probe
    // that already timed out cannot block on the connection it was diagnosing.
    await Promise.resolve()
      .then(() => client.end({ timeout: 0 }))
      .catch((endErr: unknown) => {
        probeCloseFailures += 1;
        console.warn(
          `[db-pool-health] probe client end() failed (${probeCloseFailures} total); the probe `
          + 'connection may be leaked against a database already under connection pressure:',
          endErr,
        );
      });
  }
}

let probeCloseFailures = 0;

/** Probe connections whose close failed — each one is a possible leaked socket. */
export function getDbPoolHealthProbeCloseFailures(): number {
  return probeCloseFailures;
}

export interface AssessDbPoolHealthDeps {
  readStats?: (windowMs: number, now: number) => DbConnectTimeoutWindowStats;
  probe?: DbPoolHealthProbe;
  windowMs?: number;
  thresholdTimeouts?: number;
  now?: number;
}

/**
 * One evaluation. Every dependency is injectable so the verdict logic is unit
 * tested without a database or a timer.
 */
export async function assessDbPoolHealth(
  deps: AssessDbPoolHealthDeps = {},
): Promise<DbPoolHealthAssessment> {
  const now = deps.now ?? Date.now();
  const windowMs = deps.windowMs ?? getDbPoolHealthWindowMs();
  const thresholdTimeouts = deps.thresholdTimeouts ?? getDbPoolHealthMinTimeouts();
  const readStats = deps.readStats ?? getDbConnectTimeoutStats;
  const probe = deps.probe ?? probeFreshDatabaseConnection;

  const stats = readStats(windowMs, now);
  const rate =
    `${stats.timeouts} CONNECT_TIMEOUT(s) in ${windowMs}ms (${stats.ratePerMin.toFixed(1)}/min)`;
  const causes =
    `starvation=${stats.byCause['event-loop-starvation']} `
    + `connectivity=${stats.byCause.connectivity} unknown=${stats.byCause.unknown}`;

  if (stats.timeouts < thresholdTimeouts) {
    return {
      verdict: 'below-threshold',
      stats,
      thresholdTimeouts,
      probeMs: null,
      probeError: null,
      headline: '[db-pool-health] below threshold',
      message:
        `[db-pool-health] ${rate}, below the ${thresholdTimeouts} threshold — no probe run. `
        + `This is NOT a clean bill of health: the count is a floor (only timeouts that reach `
        + `app.onError or captureException are recorded) and pool slot occupancy is not `
        + `observed at all. Causes: ${causes}.`,
      at: now,
    };
  }

  const startedAt = Date.now();
  let probeError: string | null = null;
  let probeUnavailable = false;
  let probeTimedOut = false;
  try {
    await probe();
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
    probeUnavailable = err instanceof DbPoolProbeUnavailableError;
    probeTimedOut = err instanceof DbPoolProbeTimedOutError;
  }
  const probeMs = Date.now() - startedAt;

  if (probeUnavailable) {
    return {
      verdict: 'unknown',
      stats,
      thresholdTimeouts,
      probeMs,
      probeError,
      headline: '[db-pool-health] probe unavailable',
      message:
        `[db-pool-health] UNKNOWN — ${rate}, but the fresh-connection probe could not be `
        + `attempted (${probeError}), so nothing may be concluded about the pool OR the `
        + `database. Fix the probe's configuration before reading this signal. Causes: ${causes}.`,
      at: now,
    };
  }

  // A probe that timed out while most timeouts were attributed to a blocked
  // event loop proves nothing: the probe needs that same loop to run its socket
  // callbacks, so its budget expires for the same reason theirs did. Calling
  // this `database-unreachable` would send an operator hunting a DB incident and
  // explicitly tell them a restart will not help — while the actual fault is a
  // pegged main thread (#3022).
  const starvationDominates =
    stats.byCause['event-loop-starvation'] * 2 > stats.timeouts;
  if (probeTimedOut && starvationDominates) {
    return {
      verdict: 'unknown',
      stats,
      thresholdTimeouts,
      probeMs,
      probeError,
      headline: '[db-pool-health] probe timed out under event-loop starvation',
      message:
        `[db-pool-health] UNKNOWN — ${rate}, and the probe timed out after ${probeMs}ms, but `
        + `${stats.byCause['event-loop-starvation']} of those timeouts were attributed to `
        + `event-loop starvation (#3022). The probe's budget is an in-process timer that needs `
        + `the same blocked loop, so its expiry is NOT evidence about the database. Investigate `
        + `main-thread starvation first. Causes: ${causes}.`,
      at: now,
    };
  }

  if (probeError === null) {
    return {
      verdict: 'pool-degraded',
      stats,
      thresholdTimeouts,
      probeMs,
      probeError: null,
      headline: '[db-pool-health] POOL DEGRADED (#3214)',
      message:
        `[db-pool-health] POOL DEGRADED — ${rate}, yet a brand-new connection to the same `
        + `database succeeded in ${probeMs}ms. The database is reachable; the request pool is `
        + `not. This is the postgres.js connection-poisoning signature (#3214): a pooled `
        + `connection whose socket died with a buffered write can never flush again, so it `
        + `reconnect-loops on CONNECT_TIMEOUT forever and its slot is lost for the life of the `
        + `process. The pool cannot self-heal — restart the API process to recover it. `
        + `Causes: ${causes}.`,
      at: now,
    };
  }

  return {
    verdict: 'database-unreachable',
    stats,
    thresholdTimeouts,
    probeMs,
    probeError,
    headline: '[db-pool-health] DATABASE UNREACHABLE',
    message:
      `[db-pool-health] DATABASE UNREACHABLE — ${rate}, and a brand-new connection to the same `
      + `database ALSO failed after ${probeMs}ms (${probeError}). This is NOT the #3214 pool `
      + `poisoning: the fault is in the database, the network, TLS, or auth. Restarting the API `
      + `will not help. Causes: ${causes}.`,
    at: now,
  };
}

let timer: NodeJS.Timeout | null = null;
let activeIntervalMs: number | null = null;
let checkInFlight = false;
let lastAssessment: DbPoolHealthAssessment | null = null;
let checkFailures = 0;
let lastCaptureAtByKey = new Map<string, number>();
let suppressedSinceCaptureByKey = new Map<string, number>();

/**
 * Latest verdict, or null when the watchdog has not evaluated yet, is disabled,
 * or its last evaluation FAILED. Consumers must publish a null as "not
 * observed" — never as a healthy pool.
 */
export function getLastDbPoolHealthAssessment(): DbPoolHealthAssessment | null {
  return lastAssessment;
}

/** Evaluations that threw before producing a verdict. Monotonic. */
export function getDbPoolHealthCheckFailures(): number {
  return checkFailures;
}

/**
 * Throttle gate. Returns true — and RECORDS the claim — at most once per
 * `throttleMs` per key.
 *
 * Named `claim…` rather than `should…` because it mutates: a caller who
 * evaluates it twice (the natural "if I'm going to capture, also do X" refactor)
 * would silently lose every subsequent alert, and no test would catch it. The
 * name is the guard.
 */
export function claimDbPoolHealthCaptureSlot(
  key: string,
  now: number,
  throttleMs: number,
): boolean {
  if (throttleMs === 0) return true;
  const lastAt = lastCaptureAtByKey.get(key);
  if (lastAt === undefined || now - lastAt >= throttleMs) {
    lastCaptureAtByKey.set(key, now);
    return true;
  }
  suppressedSinceCaptureByKey.set(key, (suppressedSinceCaptureByKey.get(key) ?? 0) + 1);
  return false;
}

function takeSuppressedCount(key: string): number {
  const n = suppressedSinceCaptureByKey.get(key) ?? 0;
  suppressedSinceCaptureByKey.delete(key);
  return n;
}

/**
 * Run one evaluation and report it. Never throws — it is a watchdog, and a
 * watchdog that can crash the tick it runs on is worse than none.
 */
export async function runDbPoolHealthCheck(
  deps: AssessDbPoolHealthDeps = {},
): Promise<DbPoolHealthAssessment | null> {
  try {
    const assessment = await assessDbPoolHealth(deps);
    lastAssessment = assessment;

    if (assessment.verdict === 'below-threshold') return assessment;

    console.warn(assessment.message);
    const throttleMs = getDbPoolHealthCaptureThrottleMs();
    if (claimDbPoolHealthCaptureSlot(assessment.verdict, assessment.at, throttleMs)) {
      const suppressed = takeSuppressedCount(assessment.verdict);
      // The TITLE is the stable headline (Sentry groups by message text, so an
      // interpolated rate would mint a new issue every capture and no alert
      // bound to it could ever fire twice). Detail rides on the low-cardinality
      // tags; the full prose is already on console.warn above.
      captureMessage(assessment.headline, 'warning', {
        message: assessment.message,
        verdict: assessment.verdict,
        timeouts: assessment.stats.timeouts,
        ratePerMin: assessment.stats.ratePerMin,
        windowMs: assessment.stats.windowMs,
        byCause: assessment.stats.byCause,
        probeMs: assessment.probeMs,
        probeError: assessment.probeError,
        // States this event's own sampling rate, so the throttle cannot make a
        // storm look like a single occurrence.
        suppressedSinceLastCapture: suppressed,
      }, { dbPoolHealthVerdict: assessment.verdict });
    }
    return assessment;
  } catch (err) {
    checkFailures += 1;
    // Do NOT leave the previous verdict standing. `lastAssessment` drives the
    // Prometheus verdict series, so keeping a stale value here would republish
    // an old below-threshold reading on every scrape, for hours, about a
    // watchdog that has been dead the whole time — an affirmative wrong answer,
    // which is worse than the "not observed" that null produces.
    lastAssessment = null;
    console.error('[db-pool-health] check failed:', err);
    // Reaching Sentry matters as much here as for the verdicts themselves: a
    // watchdog failing on every tick is otherwise console-only, which is exactly
    // the invisibility this module exists to remove. Throttled on its own key so
    // it cannot flood, and wrapped because the reporter may be what failed.
    if (
      claimDbPoolHealthCaptureSlot(
        'check-failed',
        Date.now(),
        getDbPoolHealthCaptureThrottleMs(),
      )
    ) {
      try {
        captureMessage('[db-pool-health] watchdog evaluation failed', 'warning', {
          error: err instanceof Error ? err.message : String(err),
          checkFailures,
        }, { dbPoolHealthVerdict: 'check-failed' });
      } catch {
        // The reporter is the thing that failed; the console line above stands.
      }
    }
    return null;
  }
}

/**
 * Start the watchdog. Idempotent. Returns the effective interval, or null when
 * disabled — mirroring `startEventLoopMonitor`, so the caller can log which
 * happened instead of the instance going silently blind.
 */
export function startDbPoolHealthMonitor(): number | null {
  if (isDbPoolHealthMonitorDisabled()) return null;
  // Return the interval the ARMED timer actually uses, not a fresh read of the
  // env — otherwise a second call after an env change reports a cadence the
  // watchdog is not running at, and the boot log would state it as fact.
  if (timer) return activeIntervalMs;

  activeIntervalMs = getDbPoolHealthIntervalMs();
  timer = setInterval(() => {
    // A probe can outlive its tick (a saturated server, a blocked loop). Without
    // this guard those ticks stack, and each one opens another fresh connection
    // to a database that in the `pool-degraded` case is already the scarce
    // resource — the watchdog would then worsen the condition it is diagnosing.
    // Never silent: a skipped tick is itself a signal.
    if (checkInFlight) {
      console.warn(
        '[db-pool-health] skipping tick — the previous check is still in flight, '
        + 'so the probe outlived its interval.',
      );
      return;
    }
    checkInFlight = true;
    void runDbPoolHealthCheck().finally(() => {
      checkInFlight = false;
    });
  }, activeIntervalMs);
  // Unref'd: the watchdog must never be the reason the process stays alive.
  timer.unref?.();
  return activeIntervalMs;
}

export function stopDbPoolHealthMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    activeIntervalMs = null;
  }
}

export function __resetDbPoolHealthMonitorForTests(): void {
  stopDbPoolHealthMonitor();
  checkInFlight = false;
  lastAssessment = null;
  checkFailures = 0;
  probeCloseFailures = 0;
  lastCaptureAtByKey = new Map();
  suppressedSinceCaptureByKey = new Map();
}
