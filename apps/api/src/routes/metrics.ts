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
import { deviceMetrics, devices, remoteSessions } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { getTrustedClientIpOrUndefined } from '../services/clientIp';

export const metricsRoutes = new Hono();
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

const activeConnectionsGauge = new Gauge({
  name: 'breeze_active_connections',
  help: 'Number of active connections',
  registers: [register]
});

const devicesActiveGauge = new Gauge({
  name: 'breeze_devices_active',
  help: 'Number of active devices',
  registers: [register]
});

const organizationsTotalGauge = new Gauge({
  name: 'breeze_organizations_total',
  help: 'Total number of organizations',
  registers: [register]
});

const alertsActiveGauge = new Gauge({
  name: 'breeze_alerts_active',
  help: 'Number of active alerts',
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

activeConnectionsGauge.set(0);
devicesActiveGauge.set(0);
organizationsTotalGauge.set(0);
alertsActiveGauge.set(0);
alertQueueLengthGauge.set(0);
agentHeartbeatTotal.labels('success').inc(0);
agentHeartbeatTotal.labels('failed').inc(0);
scriptsExecutedTotal.inc(0);
nodejsVersionInfoGauge.labels(process.version).set(1);

interface CounterValue {
  labels: Record<string, string>;
  value: number;
}

const httpRequestState = new Map<string, CounterValue>();
const agentHeartbeatState = new Map<string, CounterValue>();

let devicesActive = 0;
let organizationsTotal = 0;
let alertsActive = 0;
let alertQueueLength = 0;
let scriptsExecutedCount = 0;
let activeConnections = 0;

function normalizeRoute(route: string): string {
  return route
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id');
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

  if (metrics.alertsActive !== undefined) {
    alertsActive = metrics.alertsActive;
    alertsActiveGauge.set(alertsActive);
  }

  if (metrics.alertQueueLength !== undefined) {
    alertQueueLength = metrics.alertQueueLength;
    alertQueueLengthGauge.set(alertQueueLength);
  }
}

export function recordScriptExecution(): void {
  scriptsExecutedTotal.inc();
  scriptsExecutedCount += 1;
}

async function metricsResponse(c: any): Promise<Response> {
  updateProcessMetrics();
  const metrics = await register.metrics();

  return c.text(metrics, 200, {
    'Content-Type': register.contentType,
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  });
}

metricsRoutes.get('/', authMiddleware, requireScope('organization', 'partner', 'system'), async (c) => {
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

metricsRoutes.get('/trends', authMiddleware, requireScope('organization', 'partner', 'system'), async (c) => {
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
  return c.json({
    http_requests_total: Array.from(httpRequestState.values()),
    active_connections: [{ labels: {}, value: activeConnections }],
    business_metrics: {
      devices_active: devicesActive,
      organizations_total: organizationsTotal,
      alerts_active: alertsActive,
      alert_queue_length: alertQueueLength,
      scripts_executed_total: scriptsExecutedCount
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

  await next();

  const duration = (performance.now() - start) / 1000;
  const status = c.res.status;
  const method = c.req.method;
  const path = c.req.path;

  const auth = c.get('auth');
  const orgId = auth?.orgId;

  recordHttpRequest(method, path, status, duration, orgId);
}
