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
  /** Connect-timeout rate is below the alert threshold. No probe was run. */
  | 'healthy'
  /** Timeouts are sustained, but a fresh connection succeeds — the #3214 signature. */
  | 'pool-degraded'
  /** Timeouts are sustained and a fresh connection fails too — a real DB fault. */
  | 'database-unreachable'
  /** The probe could not be carried out, so nothing may be concluded. */
  | 'unknown';

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
 * Hard bound on the probe. Must stay comfortably under the watchdog interval so
 * a hung probe can never overlap the next tick.
 */
export function getDbPoolHealthProbeTimeoutMs(): number {
  return envInt('DB_POOL_HEALTH_PROBE_TIMEOUT_MS', 5_000, 1_000);
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
          () => reject(new Error(`pool-health probe exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  } finally {
    // `timeout: 0` destroys immediately instead of waiting to drain. A probe
    // that already timed out must not then block shutdown on the same stuck
    // connection it was diagnosing.
    await client.end({ timeout: 0 }).catch(() => undefined);
  }
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

  if (stats.timeouts < thresholdTimeouts) {
    return {
      verdict: 'healthy',
      stats,
      thresholdTimeouts,
      probeMs: null,
      probeError: null,
      message:
        `[db-pool-health] ${stats.timeouts} CONNECT_TIMEOUT(s) in the last ${windowMs}ms `
        + `(${stats.ratePerMin.toFixed(1)}/min), below the ${thresholdTimeouts} threshold.`,
      at: now,
    };
  }

  const startedAt = Date.now();
  let probeError: string | null = null;
  let probeUnavailable = false;
  try {
    await probe();
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err);
    probeUnavailable = err instanceof DbPoolProbeUnavailableError;
  }
  const probeMs = Date.now() - startedAt;

  const rate = `${stats.timeouts} CONNECT_TIMEOUT(s) in ${windowMs}ms (${stats.ratePerMin.toFixed(1)}/min)`;
  const causes =
    `starvation=${stats.byCause['event-loop-starvation']} `
    + `connectivity=${stats.byCause.connectivity} unknown=${stats.byCause.unknown}`;

  if (probeUnavailable) {
    return {
      verdict: 'unknown',
      stats,
      thresholdTimeouts,
      probeMs,
      probeError,
      message:
        `[db-pool-health] UNKNOWN — ${rate}, but the fresh-connection probe could not be `
        + `attempted (${probeError}), so nothing may be concluded about the pool OR the `
        + `database. Fix the probe's configuration before reading this signal. Causes: ${causes}.`,
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
let lastAssessment: DbPoolHealthAssessment | null = null;
let lastCaptureAtByVerdict = new Map<DbPoolHealthVerdict, number>();

/**
 * Latest verdict, or null when the watchdog has not evaluated yet (including
 * when it is disabled). `routes/metrics.ts` reads this; a null must be published
 * as "not observed", never as "healthy".
 */
export function getLastDbPoolHealthAssessment(): DbPoolHealthAssessment | null {
  return lastAssessment;
}

/** Exported for testing the throttle without waiting on real clocks. */
export function shouldCaptureDbPoolHealth(
  verdict: DbPoolHealthVerdict,
  now: number,
  throttleMs: number,
): boolean {
  if (throttleMs === 0) return true;
  const lastAt = lastCaptureAtByVerdict.get(verdict);
  if (lastAt === undefined || now - lastAt >= throttleMs) {
    lastCaptureAtByVerdict.set(verdict, now);
    return true;
  }
  return false;
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

    if (assessment.verdict === 'healthy') return assessment;

    console.warn(assessment.message);
    if (
      shouldCaptureDbPoolHealth(
        assessment.verdict,
        assessment.at,
        getDbPoolHealthCaptureThrottleMs(),
      )
    ) {
      captureMessage(assessment.message, 'warning', {
        verdict: assessment.verdict,
        timeouts: assessment.stats.timeouts,
        ratePerMin: assessment.stats.ratePerMin,
        windowMs: assessment.stats.windowMs,
        byCause: assessment.stats.byCause,
        probeMs: assessment.probeMs,
        probeError: assessment.probeError,
      }, { dbPoolHealthVerdict: assessment.verdict });
    }
    return assessment;
  } catch (err) {
    console.error('[db-pool-health] check failed:', err);
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
    void runDbPoolHealthCheck();
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
  lastAssessment = null;
  lastCaptureAtByVerdict = new Map();
}
