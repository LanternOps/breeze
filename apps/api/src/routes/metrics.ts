/**
 * Prometheus Metrics Endpoint
 *
 * Exposes metrics in Prometheus format for monitoring.
 */

import { Hono } from 'hono';
import { routePath as honoRoutePath } from 'hono/route';
import { avg, and, eq, gte, inArray, sql } from 'drizzle-orm';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { createHash, timingSafeEqual } from 'crypto';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceMetrics, devices, metricRollups, recoveryReadiness as recoveryReadinessTable, remoteSessions } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { getEventLoopLagStats, readLatestEventLoopLag } from '../services/eventLoopMonitor';
import {
  getDbConnectTimeoutStats,
  setDbConnectTimeoutMetricsRecorder,
} from '../services/dbConnectTimeoutStats';
import {
  DB_POOL_HEALTH_VERDICTS,
  getDbPoolHealthCheckFailures,
  getDbPoolHealthProbeCloseFailures,
  getDbPoolHealthWindowMs,
  getLastDbPoolHealthAssessment,
} from '../db/dbPoolHealthMonitor';
import { PERMISSIONS, type UserPermissions } from '../services/permissions';
import { BACKUP_LOW_READINESS_THRESHOLD } from './backup/constants';
import {
  recordBackupCommandTimeout,
  recordBackupDispatchFailure,
  recordBackupVerificationResult,
  recordBackupVerificationSkip,
  recordRestoreTimeout,
  setLowReadinessDevices,
  setBackupMetricsRecorder,
} from '../services/backupMetrics';
import {
  getS1MetricsSnapshot,
  resetS1MetricsForTesting,
  setS1MetricsRecorder
} from '../services/sentinelOne/metrics';
import { setAnomalyMetricsRecorder } from '../services/anomalyMetrics';
import { setAbuseMetricsRecorder } from '../services/abuseMetrics';
import { setProxyTrustMetricsRecorder } from '../services/clientIp';
import {
  registerM365CustomerGraphActionsPrometheusCounter,
  registerM365CustomerGraphReadPrometheusCounter,
} from '../services/m365ControlPlane/metrics';
import { registerM365GraphReadActionPrometheusCounter } from '../services/m365ControlPlane/readActionMetrics';
import { registerM365GraphActionsPrometheusCounter } from '../services/m365ControlPlane/writeActionMetrics';
import { registerActionIntentPrometheusCounter } from '../services/actionIntents/metrics';
import { registerAgentCertificateBindingPrometheusCounter } from '../services/agentCertificateBinding';
import { setExtensionMetricsRecorder } from '../extensions/metrics';
import { envFloat } from '../utils/envFloat';

export {
  recordBackupCommandTimeout,
  recordBackupDispatchFailure,
  recordBackupVerificationResult,
  recordBackupVerificationSkip,
  recordRestoreTimeout,
  setLowReadinessDevices,
} from '../services/backupMetrics';

export const metricsRoutes = new Hono();
const requireMetricsRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

function resolveMetricsScrapeToken(): string | undefined {
  const rawToken = process.env.METRICS_SCRAPE_TOKEN?.trim();
  // Production hardening: refuse to run with obvious placeholder tokens.
  return (process.env.NODE_ENV ?? 'development') === 'production' && (!rawToken || rawToken === 'REDACTED_DEV_TOKEN')
    ? undefined
    : rawToken;
}

let METRICS_SCRAPE_TOKEN = resolveMetricsScrapeToken();

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseCsvSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// Default: hide org IDs in Prometheus labels in production (they can leak tenant identifiers).
function resolveMetricsIncludeOrgId(): boolean {
  return envFlag(
    'METRICS_INCLUDE_ORG_ID',
    (process.env.NODE_ENV ?? 'development') !== 'production'
  );
}

let METRICS_INCLUDE_ORG_ID = resolveMetricsIncludeOrgId();

let METRICS_SCRAPE_IP_ALLOWLIST = parseCsvSet(process.env.METRICS_SCRAPE_IP_ALLOWLIST);

const register = new Registry();
registerM365CustomerGraphReadPrometheusCounter(register);
registerM365CustomerGraphActionsPrometheusCounter(register);
registerM365GraphReadActionPrometheusCounter(register);
registerM365GraphActionsPrometheusCounter(register);
registerActionIntentPrometheusCounter(register);
registerAgentCertificateBindingPrometheusCounter(register);

/**
 * Route label for a request that never reached a registered handler — a 404, or
 * a global middleware (rate limit, body limit, CORS preflight rejection) that
 * short-circuited before routing. Collapsing these to one label is what keeps a
 * path-scanning bot from minting a series per probed URL. Declared here, above
 * `initializeMetricDefaults`, because that runs at module load.
 */
const UNMATCHED_ROUTE_LABEL = 'unmatched';

// SOC 2 A1.1 capacity evidence. Both series were declared here from the start
// and `docs/notes/SOC_A1.1_CAPACITY_NOTES.md` has always cited them, but nothing
// mounted `metricsMiddleware` — so a live scrape carried `http_requests_in_flight`
// (seeded to 0 at boot) and no per-request series at all, and every panel and
// alert rule built on them matched nothing. `index.ts` now installs the
// middleware as the outermost global handler.
//
// Labels are `method` × `route` × `status_class`, all closed sets:
//   - `method` is normalised against the known HTTP verbs, else `other`.
//   - `route` is the HONO ROUTE TEMPLATE (`/api/devices/:id`), read from
//     `c.req.routePath` after the downstream handler has run, so it is drawn from
//     the registered route table rather than the request path. The previous
//     regex-scrubbing of the raw path only collapsed numeric and UUID segments —
//     any other path parameter (slugs, hostnames, agent versions) went into the
//     label verbatim and would have made this series unbounded the moment it was
//     wired up.
//   - `status_class` is the response class, not the exact code: six values
//     (`1xx`-`5xx` plus `other`) instead of ~40, and every consumer of these
//     metrics aggregates by class anyway. The cost is that 429s are no longer
//     distinguishable from 404s, so rate-limit volume is not observable here.
// The `org_id` label was dropped for the same reason — tenant count is unbounded.
// It never carried a real value in production anyway: nothing mounted the
// middleware, so the series did not exist at all.
const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests by method, matched route template, and response class',
  labelNames: ['method', 'route', 'status_class'] as const,
  registers: [register]
});

const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds by method and matched route template',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

const httpRequestsInFlight = new Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed',
  registers: [register]
});

// Both gauges read a flat 0 in every region until the SOC 2 A1.1 review: they
// were seeded to 0 by initializeMetricDefaults() and the only thing that could
// move them, `updateBusinessMetrics()`, had no production caller — the export was
// reachable from tests and nowhere else. `refreshFleetGauges()` now populates
// them from the database on scrape. The setter is kept exported so the numbers
// can also be pushed from a scheduler later without another rewrite.
const devicesActiveGauge = new Gauge({
  name: 'breeze_active_devices',
  help: 'Non-decommissioned, non-ephemeral devices whose last heartbeat is within METRICS_ACTIVE_DEVICE_WINDOW_SECONDS',
  registers: [register]
});

const organizationsTotalGauge = new Gauge({
  name: 'breeze_active_organizations',
  help: 'Distinct organizations owning at least one device counted by breeze_active_devices',
  registers: [register]
});

// Freshness and failure for the fleet gauges above, mirroring
// `breeze_db_pool_health_last_check_timestamp_seconds` /
// `breeze_db_pool_health_check_failures`. Without these, a refresher that starts
// throwing every scrape leaves `breeze_active_devices` asserting its last good
// value forever — a flat, plausible line that cannot be told apart from a stable
// fleet. Note that dropping the `.set(0)` seeds would NOT make absence visible
// instead: prom-client emits an unlabelled Gauge as 0 whether or not it has ever
// been set, so `absent()` never fires on these. An explicit freshness series is
// the only way to distinguish "never read" from "read, and it is zero".
//
// Alert on `time() - ..._last_refresh_timestamp_seconds > 5 * TTL`, or on `== 0`
// (never succeeded since boot).
const fleetGaugeLastRefreshGauge = new Gauge({
  name: 'breeze_fleet_gauges_last_refresh_timestamp_seconds',
  help: 'Unix time of the last SUCCESSFUL fleet-gauge refresh (0 = never succeeded since process start)',
  registers: [register]
});

const fleetGaugeRefreshFailuresTotal = new Counter({
  name: 'breeze_fleet_gauge_refresh_failures_total',
  help: 'Fleet-gauge refresh attempts that failed or timed out, since process start',
  registers: [register]
});

const commandsTotalCounter = new Counter({
  name: 'breeze_commands_total',
  help: 'Commands executed by type',
  labelNames: ['type'] as const,
  registers: [register]
});

const alertsTotalCounter = new Counter({
  name: 'breeze_alerts_total',
  help: 'Alerts fired by severity',
  labelNames: ['severity'] as const,
  registers: [register]
});

const alertQueueLengthGauge = new Gauge({
  name: 'breeze_alert_queue_length',
  help: 'Number of alerts in processing queue',
  registers: [register]
});

const agentHeartbeatTotal = new Counter({
  name: 'agent_heartbeat_total',
  help: 'Total agent heartbeats received',
  labelNames: ['status'] as const,
  registers: [register]
});

const scriptsExecutedTotal = new Counter({
  name: 'breeze_scripts_executed_total',
  help: 'Total scripts executed',
  registers: [register]
});

const backupDispatchFailuresTotal = new Counter({
  name: 'breeze_backup_dispatch_failures_total',
  help: 'Backup, restore, and verification start failures by operation and reason',
  labelNames: ['operation', 'reason'] as const,
  registers: [register]
});

const backupVerificationSkipsTotal = new Counter({
  name: 'breeze_backup_verification_skips_total',
  help: 'Scheduled backup verification skips by verification type and reason',
  labelNames: ['verification_type', 'reason'] as const,
  registers: [register]
});

const restoreTimeoutsTotal = new Counter({
  name: 'breeze_restore_timeouts_total',
  help: 'Restore commands timed out by command type',
  labelNames: ['command_type'] as const,
  registers: [register]
});

const backupCommandTimeoutsTotal = new Counter({
  name: 'breeze_backup_command_timeouts_total',
  help: 'Backup-related command timeouts by command type and timeout source',
  labelNames: ['command_type', 'source'] as const,
  registers: [register]
});

const backupVerificationResultsTotal = new Counter({
  name: 'breeze_backup_verification_results_total',
  help: 'Backup verification outcomes by verification type and status',
  labelNames: ['verification_type', 'status'] as const,
  registers: [register]
});

const backupLowReadinessDevicesGauge = new Gauge({
  name: 'breeze_backup_low_readiness_devices',
  help: 'Current number of devices below the low-readiness threshold',
  registers: [register]
});

const softwarePolicyEvaluationsTotal = new Counter({
  name: 'breeze_software_policy_evaluations_total',
  help: 'Software policy evaluations by policy mode and result',
  labelNames: ['mode', 'status', 'reason'] as const,
  registers: [register]
});

const softwarePolicyEvaluationDurationSeconds = new Histogram({
  name: 'breeze_software_policy_evaluation_duration_seconds',
  help: 'Software policy evaluation duration in seconds',
  labelNames: ['mode', 'status'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register]
});

const softwarePolicyViolationsTotal = new Counter({
  name: 'breeze_software_policy_violations_total',
  help: 'Software policy violations detected',
  labelNames: ['mode'] as const,
  registers: [register]
});

const softwareRemediationDecisionsTotal = new Counter({
  name: 'breeze_software_remediation_decisions_total',
  help: 'Software remediation queueing and execution outcomes',
  labelNames: ['decision'] as const,
  registers: [register]
});

const s1SyncRunsTotal = new Counter({
  name: 'breeze_s1_sync_runs_total',
  help: 'SentinelOne sync jobs by job type and outcome',
  labelNames: ['job', 'outcome'] as const,
  registers: [register]
});

const s1SyncDurationSeconds = new Histogram({
  name: 'breeze_s1_sync_duration_seconds',
  help: 'SentinelOne sync job duration in seconds',
  labelNames: ['job', 'outcome'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [register]
});

const s1ActionDispatchTotal = new Counter({
  name: 'breeze_s1_action_dispatch_total',
  help: 'SentinelOne action dispatch attempts by action and outcome',
  labelNames: ['action', 'outcome'] as const,
  registers: [register]
});

const s1ActionPollTransitionsTotal = new Counter({
  name: 'breeze_s1_action_poll_transitions_total',
  help: 'SentinelOne action status transitions observed by poller',
  labelNames: ['status'] as const,
  registers: [register]
});

// Anomaly-detection signals (launch-readiness CRITICAL #5). The `tenant` label
// carries a partner identifier so a single noisy/attacked partner doesn't mask
// the rest of the fleet, but it is redacted in production by default so Prometheus
// never persists a tenant identifier unless the operator opts in via
// METRICS_INCLUDE_ORG_ID. (`http_requests_total` declared an `org_id` label under
// the same policy; it was dropped outright rather than redacted.)
const failedLoginsTotal = new Counter({
  name: 'breeze_failed_logins_total',
  help: 'Failed login attempts by reason and tenant',
  labelNames: ['reason', 'tenant'] as const,
  registers: [register]
});

const agentEnrollmentsTotal = new Counter({
  name: 'breeze_agent_enrollments_total',
  help: 'Agent enrollment attempts by result and tenant (partner)',
  labelNames: ['result', 'tenant'] as const,
  registers: [register]
});

const commandsDispatchedTotal = new Counter({
  name: 'breeze_commands_dispatched_total',
  help: 'Commands dispatched to agents by type, actor kind, and tenant',
  labelNames: ['type', 'actor', 'tenant'] as const,
  registers: [register]
});

// Droplet-abuse-detection sweep signals. `abuseMetrics.ts` is the thin
// recorder (same import-cycle rationale as `anomalyMetrics.ts` above).
const abuseSignalsFiredTotal = new Counter({
  name: 'breeze_abuse_signals_fired_total',
  help: 'Abuse signals fired by the sweep, by severity',
  labelNames: ['severity'] as const,
  registers: [register]
});
const abuseSweepRunsTotal = new Counter({
  name: 'breeze_abuse_sweep_runs_total',
  help: 'Abuse sweep job runs by result',
  labelNames: ['result'] as const,
  registers: [register]
});
const opsAlertDeliveriesTotal = new Counter({
  name: 'breeze_ops_alert_deliveries_total',
  help: 'Ops-alert delivery attempts by channel and result',
  labelNames: ['channel', 'result'] as const,
  registers: [register]
});

// Proxy-trust misconfiguration signal (#2364, extended by #2987/TRANSPORT-001).
// Counts occurrences (not unique requests — the trust gate is evaluated more
// than once per request: FORCE_HTTPS scheme checks, auth-cookie Secure-flag
// resolution, mTLS header binding, and client-IP resolution each consult it,
// so a broken deploy increments this 2-4x per request) of trust-gated forwarded
// headers (CF-Connecting-IP/X-Forwarded-For/X-Real-IP/X-Forwarded-Proto)
// arriving from a TCP peer outside TRUSTED_PROXY_CIDRS while proxy-header
// trust is enabled. A nonzero rate in production means the pinned proxy CIDR
// is stale: per-IP limits/audit attribution pool onto the proxy IP, and under
// FORCE_HTTPS every non-health route 308-loops. `services/clientIp.ts` holds
// the thin recorder (same import-cycle rationale as `abuseMetrics.ts`).
const proxyTrustUntrustedPeerTotal = new Counter({
  name: 'breeze_proxy_trust_untrusted_peer_total',
  help: 'Trust-gated forwarded headers (client-IP headers or X-Forwarded-Proto) seen from a peer outside TRUSTED_PROXY_CIDRS while proxy trust is enabled (stale-pin signal; increments per gate evaluation, not per request)',
  registers: [register]
});

// ── Runtime-extension request + job signals ──────────────────────────────────
// Labels are restricted to the manifest-bounded closed sets `extension`,
// `route`, and `job` (plus a fixed `outcome` enum). URLs, org/tenant, device,
// and exception text are NEVER labels here — they are unbounded / PII and would
// blow up Prometheus cardinality or leak identifiers.
const extensionRequestsTotal = new Counter({
  name: 'breeze_extension_requests_total',
  help: 'Runtime-extension gateway requests by extension and normalized route',
  labelNames: ['extension', 'route'] as const,
  registers: [register],
});

const extensionRequestDurationSeconds = new Histogram({
  name: 'breeze_extension_request_duration_seconds',
  help: 'Runtime-extension gateway request duration in seconds',
  labelNames: ['extension', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const extensionRequestErrorsTotal = new Counter({
  name: 'breeze_extension_request_errors_total',
  help: 'Runtime-extension gateway responses with a 5xx status, by extension and route',
  labelNames: ['extension', 'route'] as const,
  registers: [register],
});

const extensionJobsTotal = new Counter({
  name: 'breeze_extension_jobs_total',
  help: 'Runtime-extension job runs by extension and job',
  labelNames: ['extension', 'job'] as const,
  registers: [register],
});

const extensionJobDurationSeconds = new Histogram({
  name: 'breeze_extension_job_duration_seconds',
  help: 'Runtime-extension job run duration in seconds',
  labelNames: ['extension', 'job'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [register],
});

const extensionJobOutcomeTotal = new Counter({
  name: 'breeze_extension_job_outcome_total',
  help: 'Runtime-extension job outcomes by extension, job, and outcome',
  labelNames: ['extension', 'job', 'outcome'] as const,
  registers: [register],
});

// org-install (L1 tenant-scoped install) deny signal — bounded to extension +
// surface only, NEVER orgId (that would blow up cardinality and, worse, leak
// which orgs are probing which extensions into a metrics label). One counter
// shared by all three production deny sites: the gateway's buildOrgInstallGuard,
// executeTool's org-install gate, and the MCP tools/call gate.
const extensionOrgInstallDeniesTotal = new Counter({
  name: 'breeze_extension_org_install_denies_total',
  help: 'Org-install gate denials by extension and dispatch surface',
  labelNames: ['extension', 'surface'] as const,
  registers: [register],
});

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

function initializeMetricDefaults(): void {
  httpRequestsInFlight.set(0);
  // Seeded so `sum(rate(http_requests_total{...}))` has a denominator from the
  // first scrape. `unmatched`/`4xx` is a real combination (every 404 lands there),
  // not a synthetic placeholder, so this publishes nothing that is untrue.
  httpRequestsTotal.labels('GET', UNMATCHED_ROUTE_LABEL, '4xx').inc(0);
  // 0 = "never successfully refreshed", which is exactly what it means at boot.
  fleetGaugeLastRefreshGauge.set(0);
  fleetGaugeRefreshFailuresTotal.inc(0);
  devicesActiveGauge.set(0);
  organizationsTotalGauge.set(0);
  commandsTotalCounter.labels('script').inc(0);
  alertsTotalCounter.labels('info').inc(0);
  alertQueueLengthGauge.set(0);
  agentHeartbeatTotal.labels('success').inc(0);
  agentHeartbeatTotal.labels('failed').inc(0);
  scriptsExecutedTotal.inc(0);
  backupDispatchFailuresTotal.labels('manual_backup', 'device_offline').inc(0);
  backupVerificationSkipsTotal.labels('integrity', 'device_offline').inc(0);
  restoreTimeoutsTotal.labels('backup_restore').inc(0);
  backupCommandTimeoutsTotal.labels('backup_restore', 'reaper').inc(0);
  backupVerificationResultsTotal.labels('integrity', 'passed').inc(0);
  backupLowReadinessDevicesGauge.set(0);
  softwarePolicyEvaluationsTotal.labels('allowlist', 'compliant', 'evaluated').inc(0);
  softwarePolicyViolationsTotal.labels('allowlist').inc(0);
  softwareRemediationDecisionsTotal.labels('queued').inc(0);
  s1SyncRunsTotal.labels('sync-integration', 'success').inc(0);
  s1ActionDispatchTotal.labels('isolate', 'accepted').inc(0);
  s1ActionPollTransitionsTotal.labels('queued').inc(0);
  failedLoginsTotal.labels('invalid_password', 'redacted').inc(0);
  agentEnrollmentsTotal.labels('success', 'redacted').inc(0);
  commandsDispatchedTotal.labels('script', 'user', 'redacted').inc(0);
  abuseSignalsFiredTotal.labels('alert').inc(0);
  abuseSweepRunsTotal.labels('success').inc(0);
  opsAlertDeliveriesTotal.labels('webhook', 'success').inc(0);
  proxyTrustUntrustedPeerTotal.inc(0);
  extensionRequestsTotal.labels('unknown', 'unknown').inc(0);
  extensionRequestErrorsTotal.labels('unknown', 'unknown').inc(0);
  extensionJobsTotal.labels('unknown', 'unknown').inc(0);
  extensionJobOutcomeTotal.labels('unknown', 'unknown', 'success').inc(0);
  extensionOrgInstallDeniesTotal.labels('unknown', 'gateway').inc(0);
  nodejsVersionInfoGauge.labels(process.version).set(1);
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

initializeMetricDefaults();

interface CounterValue {
  labels: Record<string, string>;
  value: number;
}

const httpRequestState = new Map<string, CounterValue>();
const agentHeartbeatState = new Map<string, CounterValue>();
const softwarePolicyEvaluationState = new Map<string, CounterValue>();
const softwareRemediationDecisionState = new Map<string, CounterValue>();
const sensitiveDataFindingState = new Map<string, CounterValue>();
const sensitiveDataRemediationState = new Map<string, CounterValue>();
const backupDispatchFailureState = new Map<string, CounterValue>();
const backupVerificationSkipState = new Map<string, CounterValue>();
const restoreTimeoutState = new Map<string, CounterValue>();
const backupCommandTimeoutState = new Map<string, CounterValue>();
const backupVerificationResultState = new Map<string, CounterValue>();
let backupLowReadinessDevices = 0;
let sensitiveDataScansQueuedTotal = 0;

let devicesActive = 0;
let organizationsTotal = 0;
let commandsTotal = 0;
let alertsTotal = 0;
let alertQueueLength = 0;
let scriptsExecutedCount = 0;
let inFlightRequests = 0;
let softwarePolicyViolationsCount = 0;

function normalizeRoute(route: string): string {
  return route
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id');
}

const KNOWN_HTTP_METHODS = new Set([
  'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT'
]);

/** Closed set, so a garbage verb on a probe request cannot open a new series. */
function methodLabel(method: string | undefined): string {
  const normalized = (method ?? '').toUpperCase();
  return KNOWN_HTTP_METHODS.has(normalized) ? normalized : 'other';
}

/** `1xx`-`5xx`, or `other` for anything outside 100-599. Six values, closed. */
function statusClassLabel(status: number): string {
  if (!Number.isFinite(status)) return 'other';
  const bucket = Math.floor(status / 100);
  return bucket >= 1 && bucket <= 5 ? `${bucket}xx` : 'other';
}

/**
 * Response status for a request that has finished unwinding.
 *
 * `c.finalized`, not `c.res`. `c.res` is a lazy getter — when nothing ever set a
 * response it MATERIALISES one via `new Response(null, {headers})`, whose status
 * is **200** (hono/dist/context.js). So reading `c.res.status` unconditionally
 * books the two cases where Hono still returns a 500 to the client as a success:
 *
 *   1. a middleware that returns without responding and without `await next()` —
 *      the chain unwinds unfinalized and `hono-base` throws "Context is not
 *      finalized"; and
 *   2. `next()` rejecting with a NON-`Error` value, which `compose` rethrows
 *      instead of routing to `onError`.
 *
 * Booking those as 2xx is strictly worse than not measuring them: a heartbeat
 * handler failing this way would drive `agent_heartbeat_total{status="success"}`
 * at full fleet rate while every agent gets a 500 — a metric actively asserting
 * the fleet is healthy. `finalized` is the only honest signal, and reading it
 * first also avoids the getter's side effect of materialising a Response.
 */
export function resolveResponseStatus(c: any): number {
  return c?.finalized ? (c.res?.status ?? 500) : 500;
}

/**
 * The route TEMPLATE for the handler that actually ran.
 *
 * `routePath(c)` from `hono/route` rather than the `c.req.routePath` getter: the
 * getter is deprecated in Hono 4.13 AND indexes `matchedRoutes[routeIndex]`
 * unguarded, so an out-of-range index is a TypeError thrown from inside a
 * `finally`. The helper is `.at(...)?.path ?? ''`, which degrades to `unmatched`.
 *
 * `compose` sets `routeIndex` before each dispatch and never restores it, so once
 * `next()` has unwound this names the deepest handler that ran — with the prefix
 * contributed by any `app.route()` mount already merged in at registration time.
 * A request that matched no route is still sitting on the last global middleware's
 * own registration; every global in index.ts is registered at `'*'`, which Hono
 * normalises to `/*`, so that is what `unmatched` keys on. NOTE: this means a
 * request short-circuited by a global middleware (rate limit, body limit) also
 * reports `unmatched`, and a path-scoped guard reports ITS pattern
 * (`/api/v1/agents/:id/*`) rather than the leaf route.
 */
function resolveRoutePattern(c: any): string {
  const resolved = honoRoutePath(c);
  const pattern = typeof resolved === 'string' ? resolved.trim() : '';
  if (pattern.length === 0 || pattern === '/*' || pattern === '*') return UNMATCHED_ROUTE_LABEL;
  return pattern;
}

function normalizeMetricLabel(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : fallback;
}

function updateProcessMetrics(): void {
  processStartTimeGauge.set(Math.floor(Date.now() / 1000 - process.uptime()));
  updateEventLoopMetrics();
  updateDbPoolHealthMetrics();
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

function upsertCounterState(state: Map<string, CounterValue>, labels: Record<string, string>, amount = 1): void {
  const key = JSON.stringify(labels);
  const existing = state.get(key);
  if (existing) {
    existing.value += amount;
    return;
  }

  state.set(key, {
    labels,
    value: amount
  });
}

/**
 * `route` MUST be a route TEMPLATE, not a request path — see the
 * `httpRequestsTotal` declaration. `normalizeRoute` is deliberately NOT applied
 * here: it was a backstop for raw paths, but its `/\/\d+/g` rule rewrites any
 * digit-leading segment, so a future `/2fa/verify` route would be labelled
 * `/:idfa`. Now that the only caller passes a template resolved from the route
 * table, the backstop can only corrupt correct input. (`normalizeRoute` is still
 * used by the extension-gateway recorder, which does receive raw paths.)
 */
export function recordHttpRequest(
  method: string,
  route: string,
  status: number,
  durationSeconds: number
): void {
  const labels = {
    method: methodLabel(method),
    route: route.trim() || UNMATCHED_ROUTE_LABEL,
    status_class: statusClassLabel(status)
  };
  const safeDuration = Number.isFinite(durationSeconds) ? Math.max(durationSeconds, 0) : 0;

  httpRequestsTotal.labels(labels.method, labels.route, labels.status_class).inc();
  httpRequestDurationSeconds.labels(labels.method, labels.route).observe(safeDuration);
  upsertCounterState(httpRequestState, labels);
}

export function recordAgentHeartbeat(status: 'success' | 'failed'): void {
  agentHeartbeatTotal.labels(status).inc();
  upsertCounterState(agentHeartbeatState, { status });
}

export function updateBusinessMetrics(metrics: {
  devicesActive?: number;
  organizationsTotal?: number;
  alertsActive?: number;
  alertQueueLength?: number;
}): void {
  if (metrics.devicesActive !== undefined) {
    devicesActive = metrics.devicesActive;
    devicesActiveGauge.set(devicesActive);
  }

  if (metrics.organizationsTotal !== undefined) {
    organizationsTotal = metrics.organizationsTotal;
    organizationsTotalGauge.set(organizationsTotal);
  }

  if (metrics.alertQueueLength !== undefined) {
    alertQueueLength = metrics.alertQueueLength;
    alertQueueLengthGauge.set(alertQueueLength);
  }
}

export function recordCommand(type = 'script'): void {
  commandsTotalCounter.labels(type).inc();
  commandsTotal += 1;
}

// Resolve the `tenant` label for anomaly counters. Redacted in production by
// default (METRICS_INCLUDE_ORG_ID) so a partner identifier never lands in
// Prometheus unless explicitly enabled. `null`/`undefined` becomes 'unknown'
// so an unattributable event is still counted rather than dropped.
function tenantLabel(id: string | null | undefined): string {
  if (!METRICS_INCLUDE_ORG_ID) return 'redacted';
  const trimmed = id?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'unknown';
}

function recordFailedLoginMetric(reason: string, tenantId?: string | null): void {
  failedLoginsTotal.labels(normalizeMetricLabel(reason, 'unknown'), tenantLabel(tenantId)).inc();
}

function recordAgentEnrollmentMetric(
  result: 'success' | 'denied' | 'error',
  partnerId?: string | null
): void {
  agentEnrollmentsTotal.labels(result, tenantLabel(partnerId)).inc();
}

function recordCommandDispatchMetric(
  type: string,
  actor: 'user' | 'system',
  orgId?: string | null
): void {
  commandsDispatchedTotal.labels(normalizeMetricLabel(type, 'unknown'), actor, tenantLabel(orgId)).inc();
}

export function recordAlert(severity = 'info'): void {
  alertsTotalCounter.labels(severity).inc();
  alertsTotal += 1;
}

export function recordScriptExecution(): void {
  scriptsExecutedTotal.inc();
  scriptsExecutedCount += 1;
}

function recordBackupDispatchFailureMetric(operation: string, reason: string, count = 1): void {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount === 0) return;

  const normalizedOperation = normalizeMetricLabel(operation, 'unknown');
  const normalizedReason = normalizeMetricLabel(reason, 'unknown');
  backupDispatchFailuresTotal.labels(normalizedOperation, normalizedReason).inc(safeCount);
  upsertCounterState(backupDispatchFailureState, {
    operation: normalizedOperation,
    reason: normalizedReason,
  }, safeCount);
}

function recordBackupVerificationSkipMetric(
  verificationType: string,
  reason: string,
  count = 1
): void {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount === 0) return;

  const normalizedType = normalizeMetricLabel(verificationType, 'unknown');
  const normalizedReason = normalizeMetricLabel(reason, 'unknown');
  backupVerificationSkipsTotal.labels(normalizedType, normalizedReason).inc(safeCount);
  upsertCounterState(backupVerificationSkipState, {
    verification_type: normalizedType,
    reason: normalizedReason,
  }, safeCount);
}

function recordRestoreTimeoutMetric(commandType: string, count = 1): void {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount === 0) return;

  const normalizedType = normalizeMetricLabel(commandType, 'unknown');
  restoreTimeoutsTotal.labels(normalizedType).inc(safeCount);
  upsertCounterState(restoreTimeoutState, {
    command_type: normalizedType,
  }, safeCount);
}

function recordBackupCommandTimeoutMetric(commandType: string, source: string, count = 1): void {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount === 0) return;

  const normalizedType = normalizeMetricLabel(commandType, 'unknown');
  const normalizedSource = normalizeMetricLabel(source, 'unknown');
  backupCommandTimeoutsTotal.labels(normalizedType, normalizedSource).inc(safeCount);
  upsertCounterState(backupCommandTimeoutState, {
    command_type: normalizedType,
    source: normalizedSource,
  }, safeCount);
}

function recordBackupVerificationResultMetric(
  verificationType: string,
  status: string,
  count = 1
): void {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount === 0) return;

  const normalizedType = normalizeMetricLabel(verificationType, 'unknown');
  const normalizedStatus = normalizeMetricLabel(status, 'unknown');
  backupVerificationResultsTotal.labels(normalizedType, normalizedStatus).inc(safeCount);
  upsertCounterState(backupVerificationResultState, {
    verification_type: normalizedType,
    status: normalizedStatus,
  }, safeCount);
}

function setLowReadinessDevicesMetric(count: number): void {
  backupLowReadinessDevices = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  backupLowReadinessDevicesGauge.set(backupLowReadinessDevices);
}

export function recordSoftwarePolicyEvaluation(
  mode: 'allowlist' | 'blocklist' | 'audit',
  status: 'compliant' | 'violation' | 'unknown',
  durationMs: number,
  reason = 'evaluated'
): void {
  const safeDuration = Number.isFinite(durationMs) ? Math.max(durationMs, 0) : 0;
  const normalizedReason = reason.trim().length > 0 ? reason : 'evaluated';

  softwarePolicyEvaluationsTotal.labels(mode, status, normalizedReason).inc();
  softwarePolicyEvaluationDurationSeconds.labels(mode, status).observe(safeDuration / 1000);
  upsertCounterState(softwarePolicyEvaluationState, {
    mode,
    status,
    reason: normalizedReason,
  });
}

export function recordSoftwarePolicyViolation(
  mode: 'allowlist' | 'blocklist' | 'audit',
  count = 1
): void {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount === 0) return;
  softwarePolicyViolationsTotal.labels(mode).inc(safeCount);
  softwarePolicyViolationsCount += safeCount;
}

export function recordSensitiveDataFinding(dataType: string, risk: string, count = 1): void {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount === 0) return;
  upsertCounterState(sensitiveDataFindingState, { data_type: dataType, risk }, safeCount);
}

export function recordSensitiveDataRemediationDecision(decision: string, count = 1): void {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount === 0) return;
  upsertCounterState(sensitiveDataRemediationState, { decision }, safeCount);
}

export function recordSensitiveDataScanQueued(count = 1): void {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount === 0) return;
  sensitiveDataScansQueuedTotal += safeCount;
}

export function recordSoftwareRemediationDecision(decision: string, count = 1): void {
  const normalizedDecision = decision.trim().toLowerCase() || 'unknown';
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safeCount === 0) return;
  softwareRemediationDecisionsTotal.labels(normalizedDecision).inc(safeCount);
  upsertCounterState(softwareRemediationDecisionState, {
    decision: normalizedDecision,
  }, safeCount);
}

function recordExtensionRequestMetric(
  extension: string,
  route: string,
  status: number,
  durationSeconds: number,
): void {
  const ext = normalizeMetricLabel(extension, 'unknown');
  const normalizedRoute = normalizeMetricLabel(normalizeRoute(route), 'root');
  const safeDuration = Number.isFinite(durationSeconds) ? Math.max(durationSeconds, 0) : 0;
  extensionRequestsTotal.labels(ext, normalizedRoute).inc();
  extensionRequestDurationSeconds.labels(ext, normalizedRoute).observe(safeDuration);
  if (status >= 500) {
    extensionRequestErrorsTotal.labels(ext, normalizedRoute).inc();
  }
}

function recordExtensionJobMetric(
  extension: string,
  job: string,
  outcome: 'success' | 'failure',
  durationSeconds: number,
): void {
  const ext = normalizeMetricLabel(extension, 'unknown');
  const jobLabel = normalizeMetricLabel(job, 'unknown');
  const safeDuration = Number.isFinite(durationSeconds) ? Math.max(durationSeconds, 0) : 0;
  extensionJobsTotal.labels(ext, jobLabel).inc();
  extensionJobDurationSeconds.labels(ext, jobLabel).observe(safeDuration);
  extensionJobOutcomeTotal.labels(ext, jobLabel, outcome).inc();
}

function recordExtensionOrgInstallDenyMetric(
  extension: string,
  surface: 'gateway' | 'ai-tool' | 'mcp',
): void {
  const ext = normalizeMetricLabel(extension, 'unknown');
  extensionOrgInstallDeniesTotal.labels(ext, surface).inc();
}

function bindMetricsRecorders(): void {
  // #3214. The stats module is a zero-import leaf (it sits in the graph of
  // services/sentry.ts), so the Prometheus counter is pushed IN from here rather
  // than pulled by it — same inversion as setConnectTimeoutClassifier.
  setDbConnectTimeoutMetricsRecorder({
    onConnectTimeout: (cause) => {
      dbConnectTimeoutsTotal.labels(cause).inc();
    },
  });

  setS1MetricsRecorder({
    onSyncRun: (job, outcome, durationMs) => {
      const safeDuration = Number.isFinite(durationMs) ? Math.max(durationMs, 0) : 0;
      s1SyncRunsTotal.labels(job, outcome).inc();
      s1SyncDurationSeconds.labels(job, outcome).observe(safeDuration / 1000);
    },
    onActionDispatch: (action, outcome) => {
      s1ActionDispatchTotal.labels(action, outcome).inc();
    },
    onActionPollTransition: (status) => {
      s1ActionPollTransitionsTotal.labels(status).inc();
    }
  });

  setBackupMetricsRecorder({
    onDispatchFailure: recordBackupDispatchFailureMetric,
    onVerificationSkip: recordBackupVerificationSkipMetric,
    onRestoreTimeout: recordRestoreTimeoutMetric,
    onCommandTimeout: recordBackupCommandTimeoutMetric,
    onVerificationResult: recordBackupVerificationResultMetric,
    onLowReadinessDevices: setLowReadinessDevicesMetric,
  });

  setAnomalyMetricsRecorder({
    onFailedLogin: recordFailedLoginMetric,
    onAgentEnrollment: recordAgentEnrollmentMetric,
    onCommandDispatch: recordCommandDispatchMetric,
  });

  setAbuseMetricsRecorder({
    onSignalFired: (severity) => abuseSignalsFiredTotal.labels(normalizeMetricLabel(severity, 'unknown')).inc(),
    onSweepRun: (result) => abuseSweepRunsTotal.labels(result).inc(),
    onAlertDelivery: (channel, result) => opsAlertDeliveriesTotal.labels(normalizeMetricLabel(channel, 'unknown'), result).inc(),
  });

  setProxyTrustMetricsRecorder({
    onForwardedHeadersFromUntrustedPeer: () => proxyTrustUntrustedPeerTotal.inc(),
  });

  setExtensionMetricsRecorder({
    onRequest: recordExtensionRequestMetric,
    onJob: recordExtensionJobMetric,
    onOrgInstallDeny: recordExtensionOrgInstallDenyMetric,
  });

}

bindMetricsRecorders();

export function resetMetricsForTesting(): void {
  METRICS_SCRAPE_TOKEN = resolveMetricsScrapeToken();
  METRICS_INCLUDE_ORG_ID = resolveMetricsIncludeOrgId();
  METRICS_SCRAPE_IP_ALLOWLIST = parseCsvSet(process.env.METRICS_SCRAPE_IP_ALLOWLIST);

  resetS1MetricsForTesting();
  register.resetMetrics();
  initializeMetricDefaults();

  httpRequestState.clear();
  agentHeartbeatState.clear();
  softwarePolicyEvaluationState.clear();
  softwareRemediationDecisionState.clear();
  sensitiveDataFindingState.clear();
  sensitiveDataRemediationState.clear();
  backupDispatchFailureState.clear();
  backupVerificationSkipState.clear();
  restoreTimeoutState.clear();
  backupCommandTimeoutState.clear();
  backupVerificationResultState.clear();

  backupLowReadinessDevices = 0;
  sensitiveDataScansQueuedTotal = 0;
  fleetGaugesRefreshedAtMs = 0;
  fleetGaugeRefreshInFlight = null;
  devicesActive = 0;
  organizationsTotal = 0;
  commandsTotal = 0;
  alertsTotal = 0;
  alertQueueLength = 0;
  scriptsExecutedCount = 0;
  inFlightRequests = 0;
  softwarePolicyViolationsCount = 0;

  bindMetricsRecorders();
}

/**
 * `envFloat` rather than raw `Number(...)`: compose threads unmapped variables in
 * as `VAR=""`, and `Number('')` is 0 — which here would mean a zero-second cache
 * TTL (a fleet aggregate on every scrape) or a zero-second activity window (every
 * device counted as inactive). Both are the silent-misconfiguration failures the
 * `noRawEnvNumberCoercion` contract exists to prevent. Fractional values are
 * accepted so tests can drive a sub-second TTL.
 */
function envSeconds(name: string, fallback: number): number {
  const parsed = envFloat(name, fallback);
  return parsed > 0 ? parsed : fallback;
}

/**
 * Fleet-wide gauges are read as a SYSTEM db context, never off the bare pool.
 * `devices` and `recovery_readiness` are both RLS-enabled and FORCEd, and the API
 * connects as unprivileged `breeze_app` — a contextless SELECT does not error, it
 * returns zero rows. That failure mode is indistinguishable from "the fleet is
 * empty", which is precisely how a wired-up gauge would keep reporting 0.
 *
 * `runOutsideDbContext` first because `/metrics/prometheus`, `/metrics/metrics`
 * and `/metrics/json` reach here from inside an authenticated request that already
 * holds a db context. Those routes are all `requireScope('system')`, so the
 * inherited context would be system-scoped anyway — the reason this matters is the
 * #1105 held-connection tripwire: `withDbAccessContext` early-returns when a store
 * already exists, so without the exit the refresh would run on the REQUEST's
 * transaction and extend its lifetime.
 */
function withFleetWideDbContext<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

const DEFAULT_FLEET_GAUGE_TTL_SECONDS = 30;
// The agent heartbeats every 60s (see `heartbeatIntervalSeconds` in
// routes/agents/enrollment.ts), so five minutes absorbs a few dropped beats
// without counting an agent that is genuinely gone.
const DEFAULT_ACTIVE_DEVICE_WINDOW_SECONDS = 300;
// A scrape must never hang on the database. See `metricsResponse`.
const DEFAULT_FLEET_GAUGE_TIMEOUT_SECONDS = 5;

let fleetGaugesRefreshedAtMs = 0;
let fleetGaugeRefreshInFlight: Promise<void> | null = null;

function timeoutAfter(ms: number): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`fleet gauge refresh exceeded ${ms}ms`)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Reads every fleet-wide gauge in ONE system-context transaction:
 * `breeze_active_devices`, `breeze_active_organizations`, and the backup
 * low-readiness count.
 *
 * One transaction, not three: `withDbAccessContext` costs a BEGIN, six
 * `set_config` round-trips and a COMMIT, and it holds a pooled connection for the
 * duration. Against the documented 25-connection ceiling on the US droplet, a
 * per-gauge transaction on every scrape is real pressure from the endpoint whose
 * whole job is to observe that pressure.
 *
 * Ephemeral Quick Support devices and decommissioned records are excluded, the
 * same exclusions `GET /metrics/` applies, so the gauge and the dashboard count
 * the same fleet.
 */
async function readFleetGauges(nowMs: number): Promise<void> {
  const activeSince = new Date(
    nowMs - envSeconds('METRICS_ACTIVE_DEVICE_WINDOW_SECONDS', DEFAULT_ACTIVE_DEVICE_WINDOW_SECONDS) * 1000
  );

  await withFleetWideDbContext(async () => {
    const [fleetRow] = await db
      .select({
        devicesActive: sql<number>`count(*)`,
        organizationsActive: sql<number>`count(distinct ${devices.orgId})`
      })
      .from(devices)
      .where(
        and(
          gte(devices.lastSeenAt, activeSince),
          eq(devices.isEphemeral, false),
          sql`${devices.status} != 'decommissioned'`
        )
      );

    // A bare `count(*)` always returns exactly one row, so a missing row is a
    // driver anomaly, NOT an empty fleet. Publishing 0 for it would recreate the
    // reading this whole change exists to eliminate, so it fails loudly instead
    // and lands in the failure counter below.
    if (!fleetRow) throw new Error('[metrics] fleet gauge query returned no rows');

    const [readinessRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(recoveryReadinessTable)
      .where(sql`${recoveryReadinessTable.readinessScore} < ${BACKUP_LOW_READINESS_THRESHOLD}`);
    if (!readinessRow) throw new Error('[metrics] readiness gauge query returned no rows');

    updateBusinessMetrics({
      devicesActive: Number(fleetRow.devicesActive ?? 0),
      organizationsTotal: Number(fleetRow.organizationsActive ?? 0)
    });
    setLowReadinessDevicesMetric(Number(readinessRow.count ?? 0));
  });
}

/**
 * Cache + single-flight in front of `readFleetGauges`.
 *
 * A timestamp alone is not enough. It throttles scrapes that arrive INSIDE the
 * TTL, but the aggregate only gets slow when the database is already unwell —
 * exactly when a query outlives the 30s TTL and the next scrape happily starts a
 * second concurrent full scan. The in-flight promise is what actually bounds
 * concurrency to one; the timestamp is the cheap fast path.
 *
 * The timestamp is advanced only on SUCCESS. Advancing it on failure would make a
 * transient error suppress retries for a full TTL, and — worse — a failure on the
 * very first refresh after boot would leave both gauges pinned at their seeded 0
 * for that window, which reads as an empty fleet.
 */
async function refreshFleetGauges(): Promise<void> {
  const now = Date.now();
  const ttlMs = envSeconds('METRICS_FLEET_GAUGE_TTL_SECONDS', DEFAULT_FLEET_GAUGE_TTL_SECONDS) * 1000;
  if (fleetGaugesRefreshedAtMs !== 0 && now - fleetGaugesRefreshedAtMs < ttlMs) return;
  if (fleetGaugeRefreshInFlight) return fleetGaugeRefreshInFlight;

  const timeoutMs = envSeconds('METRICS_FLEET_GAUGE_TIMEOUT_SECONDS', DEFAULT_FLEET_GAUGE_TIMEOUT_SECONDS) * 1000;
  const timeout = timeoutAfter(timeoutMs);

  fleetGaugeRefreshInFlight = Promise.race([readFleetGauges(now), timeout.promise])
    .then(() => {
      fleetGaugesRefreshedAtMs = Date.now();
      fleetGaugeLastRefreshGauge.set(Math.floor(fleetGaugesRefreshedAtMs / 1000));
    })
    .catch((error) => {
      // Gauges keep their last good values rather than reverting to 0 — but the
      // staleness is now VISIBLE, via the timestamp gauge above (which is not
      // advanced here) and the failure counter. Without those two series a dead
      // refresher is indistinguishable from a stable fleet: a flat, entirely
      // plausible line for as long as it keeps failing. This file already makes
      // that argument for `breeze_db_pool_health` — the same rule applies here.
      fleetGaugeRefreshFailuresTotal.inc();
      console.warn('[metrics] Failed to refresh fleet gauges:', error);
    })
    .finally(() => {
      timeout.cancel();
      fleetGaugeRefreshInFlight = null;
    });

  return fleetGaugeRefreshInFlight;
}

async function metricsResponse(c: any): Promise<Response> {
  // Deliberately NOT awaited before rendering when it would block: `register.metrics()`
  // must always be reachable. Gating the response on a database read means that during
  // the pool-exhaustion incidents these metrics exist to diagnose, the scrape times out
  // and Prometheus loses EVERY series from this instance — event-loop lag, in-flight
  // requests, connect-timeout counters — at the exact moment they matter most, and
  // `up` flips to 0 so it reads as a dead API rather than a sick database.
  // `refreshFleetGauges` is internally timeout-bounded and never rejects.
  await refreshFleetGauges();
  updateProcessMetrics();
  const metrics = await register.metrics();

  return c.text(metrics, 200, {
    'Content-Type': register.contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  });
}

/** Current-metric response shape with every aggregate zeroed. */
function emptyDashboardMetrics() {
  return {
    data: {
      uptime: 0,
      remoteSessions: 0,
      sessions: 0,
      devices: { total: 0, online: 0, offline: 0, pending: 0 },
      business_metrics: {
        devices_total: 0,
        devices_active: 0,
        devices_pending: 0
      }
    }
  };
}

metricsRoutes.get('/', authMiddleware, requireScope('organization', 'partner', 'system'), requireMetricsRead, async (c) => {
  const auth = c.get('auth');
  const orgCondition =
    typeof auth?.orgCondition === 'function'
      ? auth.orgCondition(devices.orgId)
      : auth?.orgId
        ? eq(devices.orgId, auth.orgId)
        : undefined;

  // `allowedSiteIds` is populated by requirePermission. `undefined` is
  // unrestricted; `[]` is restricted to no sites and must never widen into
  // an unscoped aggregate.
  const perms = c.get('permissions') as UserPermissions | undefined;
  const allowedSiteIds = perms?.allowedSiteIds;
  if (allowedSiteIds !== undefined && allowedSiteIds.length === 0) {
    return c.json(emptyDashboardMetrics());
  }
  const siteCondition =
    allowedSiteIds === undefined ? undefined : inArray(devices.siteId, allowedSiteIds);

  try {
    // Ephemeral Quick Support devices sit in the hidden 'quick_support' org,
    // which stays inside accessibleOrgIds for RLS — exclude them explicitly so
    // they never inflate the fleet counts or skew the uptime denominator.
    const deviceStatusCondition = and(
      sql`${devices.status} != 'decommissioned'`,
      eq(devices.isEphemeral, false),
      orgCondition,
      siteCondition
    );
    const statusCounts = await db
      .select({
        status: devices.status,
        count: sql<number>`count(*)`
      })
      .from(devices)
      .where(deviceStatusCondition)
      .groupBy(devices.status);

    let total = 0;
    let online = 0;
    let offline = 0;
    let pending = 0;
    for (const row of statusCounts) {
      const n = Number(row.count);
      total += n;
      if (row.status === 'online') online = n;
      if (row.status === 'offline' || row.status === 'maintenance') offline += n;
      if (row.status === 'pending') pending = n;
    }

    // Exclude pending (admin pre-created, not yet enrolled) from uptime denominator
    const enrolledTotal = total - pending;
    const uptime = enrolledTotal > 0 ? Math.round((online / enrolledTotal) * 1000) / 10 : 0;

    // Remote-session counts join through devices, so the same site predicate
    // applies to them.
    const activeSessionCondition = and(
      eq(remoteSessions.status, 'active'),
      orgCondition,
      siteCondition
    );
    const [sessionRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .where(activeSessionCondition);
    const activeSessions = Number(sessionRow?.count ?? 0);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const totalSessionCondition = and(
      gte(remoteSessions.createdAt, thirtyDaysAgo),
      orgCondition,
      siteCondition
    );
    const [totalSessionRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .where(totalSessionCondition);
    const totalSessions = Number(totalSessionRow?.count ?? 0);

    return c.json({
      data: {
        uptime,
        remoteSessions: activeSessions,
        sessions: totalSessions,
        devices: { total, online, offline, pending },
        business_metrics: {
          devices_total: total,
          devices_active: online,
          devices_pending: pending
        }
      }
    });
  } catch (err) {
    console.error('[metrics] Failed to load dashboard metrics:', err);
    return c.json({ error: 'Failed to load metrics' }, 500);
  }
});

metricsRoutes.get('/trends', authMiddleware, requireScope('organization', 'partner', 'system'), requireMetricsRead, async (c) => {
  // Trend metrics aggregate `metric_rollups`, which is pre-aggregated per
  // organization and carries no site axis. There is no safe site predicate to
  // apply, so a site-restricted caller (including restricted-empty) is denied
  // outright before any aggregate query rather than served org-wide data.
  const trendPerms = c.get('permissions') as UserPermissions | undefined;
  if (trendPerms?.allowedSiteIds !== undefined) {
    return c.json(
      {
        error: 'Trend metrics are unavailable for site-restricted users',
        code: 'SITE_SCOPED_TRENDS_UNAVAILABLE'
      },
      403
    );
  }

  const auth = c.get('auth');
  const orgCondition =
    typeof auth?.orgCondition === 'function'
      ? auth.orgCondition(devices.orgId)
      : auth?.orgId
        ? eq(devices.orgId, auth.orgId)
        : undefined;
  const range = c.req.query('range') ?? '30d';
  const days = range === '24h' ? 1 : range === '7d' ? 7 : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    const rollupOrgCondition =
      typeof auth?.orgCondition === 'function'
        ? auth.orgCondition(metricRollups.orgId)
        : auth?.orgId
          ? eq(metricRollups.orgId, auth.orgId)
          : undefined;
    const rollupCondition = and(
      eq(metricRollups.sourceTable, 'device_metrics'),
      eq(metricRollups.bucketSeconds, 86400),
      inArray(metricRollups.metricName, ['cpu_percent', 'ram_percent']),
      gte(metricRollups.bucketStart, since),
      sql`${metricRollups.sampleCount} > 0`,
      sql`${metricRollups.avgValue} IS NOT NULL`,
      ...(rollupOrgCondition ? [rollupOrgCondition] : [])
    );
    const rollupRows = await db
      .select({
        bucket: metricRollups.bucketStart,
        metricName: metricRollups.metricName,
        value: sql<number>`sum(${metricRollups.avgValue} * ${metricRollups.sampleCount}) / nullif(sum(${metricRollups.sampleCount}), 0)`
      })
      .from(metricRollups)
      .where(rollupCondition)
      .groupBy(metricRollups.bucketStart, metricRollups.metricName)
      .orderBy(metricRollups.bucketStart);

    if (rollupRows.length > 0) {
      const byBucket = new Map<string, { timestamp: string; cpu: number; memory: number }>();
      for (const row of rollupRows) {
        const timestamp = row.bucket instanceof Date ? row.bucket.toISOString() : String(row.bucket);
        const bucket = byBucket.get(timestamp) ?? { timestamp, cpu: 0, memory: 0 };
        if (row.metricName === 'cpu_percent') {
          bucket.cpu = Math.round(Number(row.value ?? 0));
        } else if (row.metricName === 'ram_percent') {
          bucket.memory = Math.round(Number(row.value ?? 0));
        }
        byBucket.set(timestamp, bucket);
      }
      return c.json(Array.from(byBucket.values()));
    }

    const trendsCondition = orgCondition
      ? and(gte(deviceMetrics.timestamp, since), orgCondition)
      : gte(deviceMetrics.timestamp, since);
    const rows = await db
      .select({
        bucket: sql<string>`date_trunc('day', ${deviceMetrics.timestamp})`.as('bucket'),
        cpu: avg(deviceMetrics.cpuPercent).as('cpu'),
        memory: avg(deviceMetrics.ramPercent).as('memory')
      })
      .from(deviceMetrics)
      .innerJoin(devices, eq(deviceMetrics.deviceId, devices.id))
      .where(trendsCondition)
      .groupBy(sql`date_trunc('day', ${deviceMetrics.timestamp})`)
      .orderBy(sql`date_trunc('day', ${deviceMetrics.timestamp})`);

    if (rows.length > 0) {
      return c.json(
        rows.map((r) => ({
          timestamp: r.bucket,
          cpu: Math.round(Number(r.cpu ?? 0)),
          memory: Math.round(Number(r.memory ?? 0))
        }))
      );
    }

    return c.json([]);
  } catch (err) {
    console.error('[metrics] Failed to load trend metrics:', err);
    return c.json({ error: 'Failed to load metrics' }, 500);
  }
});

metricsRoutes.get('/scrape', async (c) => {
  if (!METRICS_SCRAPE_TOKEN) {
    return c.json({ error: 'Metrics scrape token is not configured' }, 503);
  }

  if (METRICS_SCRAPE_IP_ALLOWLIST.size > 0) {
    const ip = getTrustedClientIpOrUndefined(c);
    if (!ip || !METRICS_SCRAPE_IP_ALLOWLIST.has(ip)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const authHeader = c.req.header('Authorization');
  const expectedHeader = `Bearer ${METRICS_SCRAPE_TOKEN}`;
  if (!safeEqual(authHeader ?? '', expectedHeader)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return metricsResponse(c);
});

metricsRoutes.get('/json', authMiddleware, requireScope('system'), async (c) => {
  await refreshFleetGauges();
  const s1Snapshot = getS1MetricsSnapshot();
  return c.json({
    http_requests_total: Array.from(httpRequestState.values()),
    http_requests_in_flight: [{ labels: {}, value: inFlightRequests }],
    business_metrics: {
      breeze_active_devices: devicesActive,
      breeze_active_organizations: organizationsTotal,
      breeze_commands_total: commandsTotal,
      breeze_alerts_total: alertsTotal,
      alert_queue_length: alertQueueLength,
      scripts_executed_total: scriptsExecutedCount,
      software_policy_violations_total: softwarePolicyViolationsCount,
      sensitive_data_scans_queued_total: sensitiveDataScansQueuedTotal
    },
    software_policy: {
      evaluations: Array.from(softwarePolicyEvaluationState.values()),
      remediation_decisions: Array.from(softwareRemediationDecisionState.values()),
      violations_total: softwarePolicyViolationsCount
    },
    sentinelone: {
      sync_runs: s1Snapshot.syncRuns,
      action_dispatches: s1Snapshot.actionDispatches,
      action_poll_transitions: s1Snapshot.actionPollTransitions,
    },
    sensitive_data: {
      scans_queued_total: sensitiveDataScansQueuedTotal,
      findings: Array.from(sensitiveDataFindingState.values()),
      remediation_decisions: Array.from(sensitiveDataRemediationState.values()),
    },
    backup_operations: {
      dispatch_failures: Array.from(backupDispatchFailureState.values()),
      verification_skips: Array.from(backupVerificationSkipState.values()),
      verification_results: Array.from(backupVerificationResultState.values()),
      restore_timeouts: Array.from(restoreTimeoutState.values()),
      command_timeouts: Array.from(backupCommandTimeoutState.values()),
      low_readiness_devices: backupLowReadinessDevices,
    },
    agent_heartbeats: Array.from(agentHeartbeatState.values()),
    process: {
      uptime_seconds: process.uptime(),
      node_version: process.version
    }
  });
});

metricsRoutes.get('/prometheus', authMiddleware, requireScope('system'), async (c) => {
  return metricsResponse(c);
});

metricsRoutes.get('/metrics', authMiddleware, requireScope('system'), async (c) => {
  return metricsResponse(c);
});

/**
 * Mounted as the outermost global middleware in `index.ts`, so the duration it
 * records is the full server-side cost of the request (rate limiting, body
 * limits, auth, handler) rather than handler time alone.
 *
 * Everything runs in `finally`: a handler that throws still decrements the
 * in-flight gauge and still lands in the counter as a 5xx. Reading the route
 * template after `next()` has unwound is deliberate and is the reason this cannot
 * be collapsed into the `try` block — see `resolveRoutePattern`.
 */
export async function metricsMiddleware(c: any, next: () => Promise<void>): Promise<void> {
  const start = performance.now();
  httpRequestsInFlight.inc();
  inFlightRequests += 1;

  try {
    await next();
  } finally {
    httpRequestsInFlight.dec();
    inFlightRequests -= 1;

    // The whole body is guarded: this is the OUTERMOST middleware, so anything
    // thrown here escapes into `app.onError` and would turn a successful response
    // into a 500 — instrumentation must never be able to break the request it is
    // measuring, nor mask an in-flight exception on its way out.
    try {
      recordHttpRequest(
        c.req.method,
        resolveRoutePattern(c),
        resolveResponseStatus(c),
        (performance.now() - start) / 1000
      );
    } catch (error) {
      console.warn('[metrics] Failed to record request metrics:', error);
    }
  }
}
