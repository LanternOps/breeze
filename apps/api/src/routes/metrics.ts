/**
 * Prometheus Metrics Endpoint
 *
 * Exposes metrics in Prometheus format for monitoring.
 */

import { Hono } from 'hono';
import { avg, and, eq, gte, sql } from 'drizzle-orm';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { createHash, timingSafeEqual } from 'crypto';

import { db } from '../db';
import { deviceMetrics, devices, recoveryReadiness as recoveryReadinessTable, remoteSessions } from '../db/schema';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';
import { PERMISSIONS } from '../services/permissions';
import { BACKUP_LOW_READINESS_THRESHOLD } from './backup/verificationService';
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
  setS1MetricsRecorder
} from '../services/sentinelOne/metrics';

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
const rawMetricsScrapeToken = process.env.METRICS_SCRAPE_TOKEN?.trim();
// Production hardening: refuse to run with obvious placeholder tokens.
const METRICS_SCRAPE_TOKEN =
  (process.env.NODE_ENV ?? 'development') === 'production' && (!rawMetricsScrapeToken || rawMetricsScrapeToken === 'REDACTED_DEV_TOKEN')
    ? undefined
    : rawMetricsScrapeToken;

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
const METRICS_INCLUDE_ORG_ID = envFlag(
  'METRICS_INCLUDE_ORG_ID',
  (process.env.NODE_ENV ?? 'development') !== 'production'
);

const METRICS_SCRAPE_IP_ALLOWLIST = parseCsvSet(process.env.METRICS_SCRAPE_IP_ALLOWLIST);

const register = new Registry();

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status', 'org_id'] as const,
  registers: [register]
});

const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

const httpRequestsInFlight = new Gauge({
  name: 'http_requests_in_flight',
  help: 'Number of HTTP requests currently being processed',
  registers: [register]
});

const devicesActiveGauge = new Gauge({
  name: 'breeze_active_devices',
  help: 'Devices with recent heartbeat',
  registers: [register]
});

const organizationsTotalGauge = new Gauge({
  name: 'breeze_active_organizations',
  help: 'Organizations with active devices',
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

httpRequestsInFlight.set(0);
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
nodejsVersionInfoGauge.labels(process.version).set(1);

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

export function recordHttpRequest(
  method: string,
  route: string,
  status: number,
  durationSeconds: number,
  orgId?: string
): void {
  const normalizedRoute = normalizeRoute(route);
  const labels = {
    method,
    route: normalizedRoute,
    status: String(status),
    org_id: METRICS_INCLUDE_ORG_ID ? (orgId ?? 'unknown') : 'redacted'
  };

  httpRequestsTotal.labels(labels.method, labels.route, labels.status, labels.org_id).inc();
  httpRequestDurationSeconds.labels(labels.method, labels.route).observe(durationSeconds);
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

async function refreshBackupOperationalGauges(): Promise<void> {
  try {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(recoveryReadinessTable)
      .where(sql`${recoveryReadinessTable.readinessScore} < ${BACKUP_LOW_READINESS_THRESHOLD}`);
    setLowReadinessDevicesMetric(Number(row?.count ?? 0));
  } catch (error) {
    console.warn('[metrics] Failed to refresh backup gauges:', error);
  }
}

async function metricsResponse(c: any): Promise<Response> {
  await refreshBackupOperationalGauges();
  updateProcessMetrics();
  const metrics = await register.metrics();

  return c.text(metrics, 200, {
    'Content-Type': register.contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  });
}

metricsRoutes.get('/', authMiddleware, requireScope('organization', 'partner', 'system'), requireMetricsRead, async (c) => {
  const auth = c.get('auth');
  const orgCondition =
    typeof auth?.orgCondition === 'function'
      ? auth.orgCondition(devices.orgId)
      : auth?.orgId
        ? eq(devices.orgId, auth.orgId)
        : undefined;

  try {
    const deviceStatusCondition = orgCondition
      ? and(sql`${devices.status} != 'decommissioned'`, orgCondition)
      : sql`${devices.status} != 'decommissioned'`;
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
    for (const row of statusCounts) {
      const n = Number(row.count);
      total += n;
      if (row.status === 'online') online = n;
      if (row.status === 'offline' || row.status === 'maintenance') offline += n;
    }

    const uptime = total > 0 ? Math.round((online / total) * 1000) / 10 : 0;

    const activeSessionCondition = orgCondition
      ? and(eq(remoteSessions.status, 'active'), orgCondition)
      : eq(remoteSessions.status, 'active');
    const [sessionRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(remoteSessions)
      .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
      .where(activeSessionCondition);
    const activeSessions = Number(sessionRow?.count ?? 0);

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const totalSessionCondition = orgCondition
      ? and(gte(remoteSessions.createdAt, thirtyDaysAgo), orgCondition)
      : gte(remoteSessions.createdAt, thirtyDaysAgo);
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
        devices: { total, online, offline },
        business_metrics: {
          devices_total: total,
          devices_active: online
        }
      }
    });
  } catch (err) {
    console.error('[metrics] Failed to load dashboard metrics:', err);
    return c.json({ error: 'Failed to load metrics' }, 500);
  }
});

metricsRoutes.get('/trends', authMiddleware, requireScope('organization', 'partner', 'system'), requireMetricsRead, async (c) => {
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
  await refreshBackupOperationalGauges();
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

export async function metricsMiddleware(c: any, next: () => Promise<void>): Promise<void> {
  const start = performance.now();
  httpRequestsInFlight.inc();
  inFlightRequests += 1;

  try {
    await next();
  } finally {
    httpRequestsInFlight.dec();
    inFlightRequests -= 1;

    const duration = (performance.now() - start) / 1000;
    const status = c.res?.status ?? 500;
    const method = c.req.method;
    const path = c.req.path;

    const auth = c.get('auth');
    const orgId = auth?.orgId;

    recordHttpRequest(method, path, status, duration, orgId);
  }
}
