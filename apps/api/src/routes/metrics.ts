/**
 * Prometheus Metrics Endpoint
 *
 * Exposes metrics in Prometheus format for monitoring.
 * Uses prom-client library patterns - install with: pnpm add prom-client
 *
 * Documentation: https://prometheus.io/docs/instrumenting/writing_exporters/
 *
 * Usage:
 * 1. Import and mount the routes in your main app
 * 2. Access metrics at GET /metrics
 * 3. Configure Prometheus to scrape this endpoint
 */

import { Hono } from 'hono';

export const metricsRoutes = new Hono();

// ============================================
// Metric Types (prom-client compatible structure)
// ============================================

interface CounterValue {
  labels: Record<string, string>;
  value: number;
}

interface HistogramValue {
  labels: Record<string, string>;
  buckets: { le: number; count: number }[];
  sum: number;
  count: number;
}

interface GaugeValue {
  labels: Record<string, string>;
  value: number;
}

// ============================================
// Metrics Registry (in-memory storage)
// ============================================

// In production, use prom-client's Registry
// This is a simplified implementation showing the structure

const httpRequestsTotal: CounterValue[] = [];
const httpRequestDurationSeconds: HistogramValue[] = [];
const activeConnections: GaugeValue[] = [];

// Business metrics
let devicesActive = 0;
let organizationsTotal = 0;
let alertsActive = 0;
let agentHeartbeats: CounterValue[] = [];
let scriptsExecutedTotal = 0;
let alertQueueLength = 0;

// Default histogram buckets (in seconds)
const defaultBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// ============================================
// Metric Collection Helpers
// ============================================

/**
 * Records an HTTP request metric
 * Call this from middleware after each request completes
 */
export function recordHttpRequest(
  method: string,
  route: string,
  status: number,
  durationSeconds: number,
  orgId?: string
): void {
  // Increment request counter
  const counterLabels = {
    method,
    route: normalizeRoute(route),
    status: String(status),
    ...(orgId && { org_id: orgId }),
  };

  const existingCounter = httpRequestsTotal.find(
    (c) => JSON.stringify(c.labels) === JSON.stringify(counterLabels)
  );

  if (existingCounter) {
    existingCounter.value++;
  } else {
    httpRequestsTotal.push({ labels: counterLabels, value: 1 });
  }

  // Record duration histogram
  recordHistogram(httpRequestDurationSeconds, { method, route: normalizeRoute(route) }, durationSeconds);
}

/**
 * Records a value in a histogram
 */
function recordHistogram(
  histogram: HistogramValue[],
  labels: Record<string, string>,
  value: number
): void {
  const labelKey = JSON.stringify(labels);
  let entry = histogram.find((h) => JSON.stringify(h.labels) === labelKey);

  if (!entry) {
    entry = {
      labels,
      buckets: defaultBuckets.map((le) => ({ le, count: 0 })),
      sum: 0,
      count: 0,
    };
    histogram.push(entry);
  }

  entry.sum += value;
  entry.count++;

  // Increment all buckets where value <= le
  for (const bucket of entry.buckets) {
    if (value <= bucket.le) {
      bucket.count++;
    }
  }
}

/**
 * Normalizes route paths to prevent high cardinality
 * e.g., /api/devices/123 -> /api/devices/:id
 */
function normalizeRoute(route: string): string {
  return route
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:uuid')
    .replace(/\/\d+/g, '/:id');
}

/**
 * Records an agent heartbeat
 */
export function recordAgentHeartbeat(status: 'success' | 'failed'): void {
  const labels = { status };
  const existing = agentHeartbeats.find((h) => h.labels.status === status);
  if (existing) {
    existing.value++;
  } else {
    agentHeartbeats.push({ labels, value: 1 });
  }
}

/**
 * Updates business metric gauges
 * Call periodically or on relevant events
 */
export function updateBusinessMetrics(metrics: {
  devicesActive?: number;
  organizationsTotal?: number;
  alertsActive?: number;
  alertQueueLength?: number;
}): void {
  if (metrics.devicesActive !== undefined) devicesActive = metrics.devicesActive;
  if (metrics.organizationsTotal !== undefined) organizationsTotal = metrics.organizationsTotal;
  if (metrics.alertsActive !== undefined) alertsActive = metrics.alertsActive;
  if (metrics.alertQueueLength !== undefined) alertQueueLength = metrics.alertQueueLength;
}

/**
 * Increments script execution counter
 */
export function recordScriptExecution(): void {
  scriptsExecutedTotal++;
}

// ============================================
// Prometheus Format Output
// ============================================

/**
 * Formats all metrics in Prometheus exposition format
 */
function formatMetrics(): string {
  const lines: string[] = [];

  // HTTP Requests Total (Counter)
  lines.push('# HELP http_requests_total Total number of HTTP requests');
  lines.push('# TYPE http_requests_total counter');
  for (const metric of httpRequestsTotal) {
    const labels = formatLabels(metric.labels);
    lines.push(`http_requests_total${labels} ${metric.value}`);
  }
  lines.push('');

  // HTTP Request Duration (Histogram)
  lines.push('# HELP http_request_duration_seconds HTTP request duration in seconds');
  lines.push('# TYPE http_request_duration_seconds histogram');
  for (const metric of httpRequestDurationSeconds) {
    const baseLabels = formatLabels(metric.labels);
    for (const bucket of metric.buckets) {
      const bucketLabels = formatLabels({ ...metric.labels, le: String(bucket.le) });
      lines.push(`http_request_duration_seconds_bucket${bucketLabels} ${bucket.count}`);
    }
    // +Inf bucket
    const infLabels = formatLabels({ ...metric.labels, le: '+Inf' });
    lines.push(`http_request_duration_seconds_bucket${infLabels} ${metric.count}`);
    lines.push(`http_request_duration_seconds_sum${baseLabels} ${metric.sum}`);
    lines.push(`http_request_duration_seconds_count${baseLabels} ${metric.count}`);
  }
  lines.push('');

  // Active Connections (Gauge)
  lines.push('# HELP breeze_active_connections Number of active connections');
  lines.push('# TYPE breeze_active_connections gauge');
  for (const metric of activeConnections) {
    const labels = formatLabels(metric.labels);
    lines.push(`breeze_active_connections${labels} ${metric.value}`);
  }
  if (activeConnections.length === 0) {
    lines.push('breeze_active_connections 0');
  }
  lines.push('');

  // Business Metrics (Gauges)
  lines.push('# HELP breeze_devices_active Number of active devices');
  lines.push('# TYPE breeze_devices_active gauge');
  lines.push(`breeze_devices_active ${devicesActive}`);
  lines.push('');

  lines.push('# HELP breeze_organizations_total Total number of organizations');
  lines.push('# TYPE breeze_organizations_total gauge');
  lines.push(`breeze_organizations_total ${organizationsTotal}`);
  lines.push('');

  lines.push('# HELP breeze_alerts_active Number of active alerts');
  lines.push('# TYPE breeze_alerts_active gauge');
  lines.push(`breeze_alerts_active ${alertsActive}`);
  lines.push('');

  lines.push('# HELP breeze_alert_queue_length Number of alerts in processing queue');
  lines.push('# TYPE breeze_alert_queue_length gauge');
  lines.push(`breeze_alert_queue_length ${alertQueueLength}`);
  lines.push('');

  // Agent Heartbeats (Counter)
  lines.push('# HELP agent_heartbeat_total Total agent heartbeats received');
  lines.push('# TYPE agent_heartbeat_total counter');
  for (const metric of agentHeartbeats) {
    const labels = formatLabels(metric.labels);
    lines.push(`agent_heartbeat_total${labels} ${metric.value}`);
  }
  if (agentHeartbeats.length === 0) {
    lines.push('agent_heartbeat_total{status="success"} 0');
  }
  lines.push('');

  // Script Executions (Counter)
  lines.push('# HELP breeze_scripts_executed_total Total scripts executed');
  lines.push('# TYPE breeze_scripts_executed_total counter');
  lines.push(`breeze_scripts_executed_total ${scriptsExecutedTotal}`);
  lines.push('');

  // Process metrics (Node.js specific)
  lines.push('# HELP process_start_time_seconds Start time of the process since unix epoch in seconds');
  lines.push('# TYPE process_start_time_seconds gauge');
  lines.push(`process_start_time_seconds ${Math.floor(Date.now() / 1000 - process.uptime())}`);
  lines.push('');

  lines.push('# HELP nodejs_version_info Node.js version info');
  lines.push('# TYPE nodejs_version_info gauge');
  lines.push(`nodejs_version_info{version="${process.version}"} 1`);

  return lines.join('\n');
}

/**
 * Formats labels in Prometheus format: {key1="value1",key2="value2"}
 */
function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const labelPairs = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return `{${labelPairs.join(',')}}`;
}

/**
 * Escapes special characters in label values
 */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ============================================
// Routes
// ============================================

/**
 * GET /metrics
 * Returns metrics in Prometheus exposition format
 */
metricsRoutes.get('/metrics', async (c) => {
  const metrics = formatMetrics();

  return c.text(metrics, 200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
});

/**
 * GET /metrics/json
 * Returns metrics in JSON format (for debugging)
 */
metricsRoutes.get('/metrics/json', async (c) => {
  return c.json({
    http_requests_total: httpRequestsTotal,
    http_request_duration_seconds: httpRequestDurationSeconds,
    active_connections: activeConnections,
    business_metrics: {
      devices_active: devicesActive,
      organizations_total: organizationsTotal,
      alerts_active: alertsActive,
      alert_queue_length: alertQueueLength,
      scripts_executed_total: scriptsExecutedTotal,
    },
    agent_heartbeats: agentHeartbeats,
    process: {
      uptime_seconds: process.uptime(),
      node_version: process.version,
    },
  });
});

// ============================================
// Middleware for Automatic Metric Collection
// ============================================

/**
 * Middleware to automatically record HTTP request metrics
 * Mount this at the app level before other routes
 *
 * Usage:
 *   import { metricsMiddleware } from './routes/metrics';
 *   app.use('*', metricsMiddleware);
 */
export async function metricsMiddleware(c: any, next: () => Promise<void>): Promise<void> {
  const start = performance.now();

  await next();

  const duration = (performance.now() - start) / 1000; // Convert to seconds
  const status = c.res.status;
  const method = c.req.method;
  const path = c.req.path;

  // Extract org_id from auth context if available
  const auth = c.get('auth');
  const orgId = auth?.orgId;

  recordHttpRequest(method, path, status, duration, orgId);
}

// ============================================
// Production Implementation Notes
// ============================================

/**
 * For production use with prom-client:
 *
 * import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';
 *
 * const register = new Registry();
 *
 * // Collect default Node.js metrics
 * collectDefaultMetrics({ register, prefix: 'breeze_' });
 *
 * // Define custom metrics
 * const httpRequestsTotal = new Counter({
 *   name: 'http_requests_total',
 *   help: 'Total HTTP requests',
 *   labelNames: ['method', 'route', 'status', 'org_id'],
 *   registers: [register],
 * });
 *
 * const httpRequestDuration = new Histogram({
 *   name: 'http_request_duration_seconds',
 *   help: 'HTTP request duration in seconds',
 *   labelNames: ['method', 'route'],
 *   buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
 *   registers: [register],
 * });
 *
 * // In route handler:
 * metricsRoutes.get('/metrics', async (c) => {
 *   const metrics = await register.metrics();
 *   return c.text(metrics, 200, {
 *     'Content-Type': register.contentType,
 *   });
 * });
 */
