/**
 * Role-agnostic RUNTIME metrics: process identity, event-loop lag (#3022) and
 * Postgres pool health (#3214).
 *
 * Extracted from `routes/metrics.ts` for #4143. Every series here describes the
 * PROCESS, not the HTTP surface, so all of it is equally meaningful in a
 * worker-role container — and, per the incidents that produced #3022 and
 * #3214, it matters MOST there: the pool-exhaustion and event-loop-starvation
 * signatures were loudest on the patch scheduler and the heavy jobs, which is
 * precisely the work that moved off the api process in split-role mode
 * (#4086). Left inside the route file, none of it could be published by the
 * container running that work.
 *
 * Import closure: `prom-client`, `./metricsRegistry`, `./eventLoopMonitor`,
 * `./dbConnectTimeoutStats` and `../db/dbPoolHealthMonitor` — none of which
 * reach `routes/`, which is what lets `worker.ts` load this module at boot
 * without violating `services/workerEntrypointClosure.contract.test.ts`.
 *
 * Importing this module REGISTERS the series (module-scope `new Gauge({
 * registers: [metricsRegistry] })`). Registration is therefore per-process and
 * happens exactly once — a second import is a no-op, and a process that never
 * imports it publishes none of these series rather than publishing zeros.
 */
import { Counter, Gauge } from 'prom-client';

import { metricsRegistry } from './metricsRegistry';
import { getEventLoopLagStats, readLatestEventLoopLag } from './eventLoopMonitor';
import { getDbConnectTimeoutStats, setDbConnectTimeoutMetricsRecorder } from './dbConnectTimeoutStats';
import {
  DB_POOL_HEALTH_VERDICTS,
  getDbPoolHealthCheckFailures,
  getDbPoolHealthProbeCloseFailures,
  getDbPoolHealthWindowMs,
  getLastDbPoolHealthAssessment,
} from '../db/dbPoolHealthMonitor';

const register = metricsRegistry;

const processStartTimeGauge = new Gauge({
  name: 'process_start_time_seconds',
  help: 'Start time of the process since unix epoch in seconds',
  registers: [register]
});

const nodejsVersionInfoGauge = new Gauge({
  name: 'nodejs_version_info',
  help: 'Node.js version info',
  labelNames: ['version'] as const,
  registers: [register]
});

// #3022 — event-loop lag as a scrapable series. This is the metric whose
// absence made the original incident a manual investigation: three unrelated
// Sentry signatures, all downstream of a stalled main thread, and nothing in
// the dashboards that showed the stall itself.
//
// Seconds, per Prometheus base-unit convention. The `breeze_` prefix is
// deliberate — prom-client's `collectDefaultMetrics()` is not called anywhere in
// this API, so there is no upstream `nodejs_eventloop_lag_*` series to collide
// with or to inherit alert rules from. These are ours and are named as such.
//
// `_lag_max_seconds` is INSTANTANEOUS (last completed sampling interval plus any
// in-flight stall), matching upstream's reset-per-collection semantics. Feeding
// it from the retained high-water mark instead would keep a 1.2s blip elevated
// for the full retention window, so `starved == 1 for 1m` would fire on a
// momentary spike and `max_over_time` would count one stall many times. The
// high-water mark is still published, under a name that says so.
const eventLoopLagMaxGauge = new Gauge({
  name: 'breeze_nodejs_eventloop_lag_max_seconds',
  help: 'Event-loop delay over the last completed sampling interval, including any in-flight stall',
  registers: [register]
});

const eventLoopLagWindowMaxGauge = new Gauge({
  name: 'breeze_nodejs_eventloop_lag_window_max_seconds',
  help: 'Worst event-loop delay retained across the whole sampling window (high-water mark)',
  registers: [register]
});

// Named `_window_` to match its time base. It summarises the retained window,
// while `_lag_max_seconds` is instantaneous — leaving it as a bare `_lag_mean_`
// made the two read as a matched max/mean pair that they are not, and a
// recovered loop could publish a max BELOW its mean (0.005 vs 0.011), which on
// a dashboard reads as an instrumentation bug.
const eventLoopLagWindowMeanGauge = new Gauge({
  name: 'breeze_nodejs_eventloop_lag_window_mean_seconds',
  help: 'Mean event-loop delay across the retained sampling window',
  registers: [register]
});

// Derived from the INSTANTANEOUS lag so it clears as soon as the loop recovers.
// Exposed as its own series rather than left to a `> threshold` alert
// expression so the API's own starvation threshold — configurable via
// EVENT_LOOP_STARVATION_WARN_MS — stays the single definition of "starved",
// instead of being restated (and drifting) in the alerting rules.
const eventLoopStarvedGauge = new Gauge({
  name: 'breeze_nodejs_eventloop_starved',
  help: '1 when the current event-loop lag is at or above the configured starvation threshold, else 0',
  registers: [register]
});

// 0 whenever the monitor is disabled or not yet started. Without this, the
// gauges above sit at 0 in exactly that case and read as a perfectly healthy
// loop — alert on `monitored == 0` to catch a blind instance.
const eventLoopMonitoredGauge = new Gauge({
  name: 'breeze_nodejs_eventloop_monitored',
  help: '1 when event-loop lag instrumentation is running, else 0',
  registers: [register]
});

// #3214 — Postgres CONNECT_TIMEOUT as a first-class series. During the incident
// this signal existed only as individual Sentry events and console lines, so the
// thing that actually mattered — the RATE, sustained at ~144/min for hours while
// the pool decayed from 35 live connections to 9 — was invisible. `cause` comes
// from services/postgresConnectTimeout.ts, so a starved event loop (#3022) can
// be told apart from a genuine connect failure on the same chart.
const dbConnectTimeoutsTotal = new Counter({
  name: 'breeze_db_connect_timeouts_total',
  help: 'Total Postgres CONNECT_TIMEOUT errors observed, by diagnosed cause',
  labelNames: ['cause'] as const,
  registers: [register]
});

// The same rate the watchdog evaluates, republished so an alert rule and the
// warning in the logs derive from one number instead of two definitions that can
// drift apart.
const dbConnectTimeoutRateGauge = new Gauge({
  name: 'breeze_db_connect_timeout_rate_per_min',
  help: 'Postgres CONNECT_TIMEOUT errors per minute over the pool-health window',
  registers: [register]
});

// Enum-style gauge: exactly one verdict carries 1, the rest carry 0. Modelled as
// a label rather than a numeric code because the operational response differs per
// verdict and an alert must be able to name which — `pool-degraded` means restart
// the API (the pool cannot self-heal, #3214), `database-unreachable` means do NOT
// restart, the fault is downstream. Before the first evaluation, whenever the
// watchdog is disabled, and after a failed evaluation, ALL series stay 0.
//
// Note there is no `healthy` verdict to publish — the quiet one is
// `below-threshold`, because the underlying count is a floor and pool occupancy
// is never observed. Alert on `verdict="pool-degraded" == 1`, never on the
// negation of a healthy series.
const dbPoolHealthGauge = new Gauge({
  name: 'breeze_db_pool_health',
  help: '1 for the pool-health watchdog current verdict, 0 for the others (all 0 before the first evaluation)',
  labelNames: ['verdict'] as const,
  registers: [register]
});

// Freshness, without which the gauge above cannot be trusted. A watchdog that
// starts throwing every tick would otherwise leave its last verdict asserted
// indefinitely; `lastAssessment` is cleared on failure so the verdict series go
// to 0, and this timestamp is what lets an alert require recency rather than
// merely a value. 0 = never evaluated.
const dbPoolHealthLastCheckGauge = new Gauge({
  name: 'breeze_db_pool_health_last_check_timestamp_seconds',
  help: 'Unix time of the last completed pool-health evaluation (0 = never)',
  registers: [register]
});

// Gauges, not Counters, and therefore deliberately WITHOUT the `_total` suffix
// (which OpenMetrics reserves for counters). The underlying values are
// process-lifetime totals owned by dbPoolHealthMonitor and read absolutely on
// each scrape, so there is no per-event increment to drive a Counter with.
const dbPoolHealthCheckFailuresGauge = new Gauge({
  name: 'breeze_db_pool_health_check_failures',
  help: 'Pool-health evaluations that threw before producing a verdict, since process start',
  registers: [register]
});

// Each failed close is a probe socket that may have been leaked — against the
// database the watchdog is diagnosing. Surfaced so the watchdog cannot quietly
// become a contributor to connection exhaustion.
const dbPoolHealthProbeCloseFailuresGauge = new Gauge({
  name: 'breeze_db_pool_health_probe_close_failures',
  help: 'Pool-health probe clients whose end() failed since process start, each a possible leaked connection',
  registers: [register]
});

/**
 * Seeds every series above so a dashboard or alert rule referencing them is
 * never querying a metric that does not exist yet. Idempotent — safe to call
 * again after `metricsRegistry.resetMetrics()`.
 */
export function initializeRuntimeMetricDefaults(): void {
  nodejsVersionInfoGauge.labels(process.version).set(1);
  processStartTimeGauge.set(Math.floor(Date.now() / 1000 - process.uptime()));
  // Publish the event-loop series from process start so a dashboard or alert
  // rule referencing them is never querying a metric that does not exist yet.
  eventLoopMonitoredGauge.set(0);
  eventLoopLagMaxGauge.set(0);
  eventLoopLagWindowMaxGauge.set(0);
  eventLoopLagWindowMeanGauge.set(0);
  eventLoopStarvedGauge.set(0);
  // #3214. Seeded at 0 for the same reason: an alert on the connect-timeout rate
  // must not silently match nothing on an instance that has not yet timed out.
  dbConnectTimeoutsTotal.labels('event-loop-starvation').inc(0);
  dbConnectTimeoutsTotal.labels('connectivity').inc(0);
  dbConnectTimeoutsTotal.labels('unknown').inc(0);
  dbConnectTimeoutRateGauge.set(0);
  for (const verdict of DB_POOL_HEALTH_VERDICTS) {
    dbPoolHealthGauge.labels(verdict).set(0);
  }
  dbPoolHealthLastCheckGauge.set(0);
  dbPoolHealthCheckFailuresGauge.set(0);
  dbPoolHealthProbeCloseFailuresGauge.set(0);
}

/**
 * #3214. The stats module is a zero-import leaf (it sits in the graph of
 * services/sentry.ts), so the Prometheus counter is pushed IN from here rather
 * than pulled by it — same inversion as setConnectTimeoutClassifier.
 *
 * Bound at module load rather than by a caller, because the recorder is a
 * single global slot: leaving it to each entrypoint meant the worker role
 * (which never loads `routes/metrics.ts`) counted no CONNECT_TIMEOUTs at all,
 * while `db/dbPoolHealthMonitor.ts` — running in that same process — was
 * alerting on the rate derived from them.
 *
 * Also EXPORTED and re-called from `routes/metrics.ts`'s `bindMetricsRecorders`
 * because `__resetDbConnectTimeoutStatsForTests()` nulls the recorder slot, and
 * `resetMetricsForTesting()` is what tests rely on to put it back. Idempotent:
 * the slot is overwritten, never appended to.
 */
export function bindRuntimeMetricsRecorders(): void {
  setDbConnectTimeoutMetricsRecorder({
    onConnectTimeout: (cause) => {
      dbConnectTimeoutsTotal.labels(cause).inc();
    },
  });
}

/**
 * Republishes the watchdog's latest verdict (#3214). Read on scrape rather than
 * pushed on evaluation so a scrape always reflects the most recent check even if
 * the watchdog interval and the scrape interval differ.
 *
 * The rate is recomputed here over the SAME window the watchdog uses, so the
 * gauge and the log warning cannot disagree. When no verdict exists yet, every
 * verdict series is left at 0 — see the gauge's declaration for why "not
 * observed" must not collapse into "healthy".
 */
function updateDbPoolHealthMetrics(): void {
  dbConnectTimeoutRateGauge.set(getDbConnectTimeoutStats(getDbPoolHealthWindowMs()).ratePerMin);
  const assessment = getLastDbPoolHealthAssessment();
  for (const verdict of DB_POOL_HEALTH_VERDICTS) {
    dbPoolHealthGauge.labels(verdict).set(assessment?.verdict === verdict ? 1 : 0);
  }
  dbPoolHealthLastCheckGauge.set(assessment ? Math.floor(assessment.at / 1000) : 0);
  dbPoolHealthCheckFailuresGauge.set(getDbPoolHealthCheckFailures());
  dbPoolHealthProbeCloseFailuresGauge.set(getDbPoolHealthProbeCloseFailures());
}

function updateEventLoopMetrics(): void {
  const stats = getEventLoopLagStats();
  const latest = readLatestEventLoopLag();
  eventLoopMonitoredGauge.set(stats.monitored ? 1 : 0);
  // `worstLagMs` on both, rather than the sampled max: it folds in a stall that
  // is still in flight and has therefore not been recorded as a sample yet. A
  // scrape landing mid-stall must not report the loop as healthy.
  eventLoopLagMaxGauge.set(latest.worstLagMs / 1000);
  eventLoopLagWindowMaxGauge.set(stats.worstLagMs / 1000);
  eventLoopLagWindowMeanGauge.set(stats.meanLagMs / 1000);
  // Uses the RAW EVENT_LOOP_STARVATION_WARN_MS, not the connect-window cap that
  // services/postgresConnectTimeout.ts applies. Deliberate: this gauge tracks
  // "is the loop unhealthy by the operator's own definition", whereas the cap
  // exists solely so a raised warn threshold cannot mis-attribute a specific
  // Postgres timeout. With EVENT_LOOP_STARVATION_WARN_MS above 10s the two can
  // disagree for the same stall — the gauge reads 0 while Sentry says
  // event-loop-starvation — and that is the intended reading of each.
  eventLoopStarvedGauge.set(
    latest.monitored && latest.worstLagMs >= stats.starvationThresholdMs ? 1 : 0,
  );
}

/**
 * Refreshes every read-on-scrape series here. Both entrypoints call this
 * immediately before rendering the registry.
 */
export function updateRuntimeMetrics(): void {
  processStartTimeGauge.set(Math.floor(Date.now() / 1000 - process.uptime()));
  updateEventLoopMetrics();
  updateDbPoolHealthMetrics();
}

initializeRuntimeMetricDefaults();
bindRuntimeMetricsRecorders();
