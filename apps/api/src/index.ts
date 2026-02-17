import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { secureHeaders } from 'hono/secure-headers';

import { securityMiddleware } from './middleware/security';
import { authRoutes } from './routes/auth';
import { agentRoutes } from './routes/agents';
import { deviceRoutes } from './routes/devices';
import { scriptRoutes } from './routes/scripts';
import { scriptLibraryRoutes } from './routes/scriptLibrary';
import { automationRoutes, automationWebhookRoutes } from './routes/automations';
import { alertRoutes } from './routes/alerts';
import { alertTemplateRoutes } from './routes/alertTemplates';
import { orgRoutes } from './routes/orgs';
import { userRoutes } from './routes/users';
import { roleRoutes } from './routes/roles';
import { auditLogRoutes } from './routes/auditLogs';
import { backupRoutes } from './routes/backup';
import { reportRoutes } from './routes/reports';
import { searchRoutes } from './routes/search';
import { remoteRoutes } from './routes/remote';
import { apiKeyRoutes } from './routes/apiKeys';
import { enrollmentKeyRoutes } from './routes/enrollmentKeys';
import { ssoRoutes } from './routes/sso';
import { docsRoutes } from './routes/docs';
import { accessReviewRoutes } from './routes/accessReviews';
import { webhookRoutes } from './routes/webhooks';
import { policyRoutes } from './routes/policyManagement';
import { configPolicyRoutes } from './routes/configurationPolicies';
import { psaRoutes } from './routes/psa';
import { patchRoutes } from './routes/patches';
import { patchPolicyRoutes } from './routes/patchPolicies';
import { mobileRoutes } from './routes/mobile';
import { analyticsRoutes } from './routes/analytics';
import { discoveryRoutes } from './routes/discovery';
import { portalRoutes } from './routes/portal';
import { pluginRoutes } from './routes/plugins';
import { maintenanceRoutes } from './routes/maintenance';
import { securityRoutes } from './routes/security';
import { snmpRoutes } from './routes/snmp';
import { monitorRoutes } from './routes/monitors';
import { monitoringRoutes } from './routes/monitoring';
import { softwareRoutes } from './routes/software';
import { systemToolsRoutes } from './routes/systemTools';
import { notificationRoutes } from './routes/notifications';
import { metricsRoutes } from './routes/metrics';
import { groupRoutes } from './routes/groups';
import { integrationRoutes } from './routes/integrations';
import { partnerRoutes } from './routes/partner';
import { tagRoutes } from './routes/tags';
import { customFieldRoutes } from './routes/customFields';
import { filterRoutes } from './routes/filters';
import { deploymentRoutes } from './routes/deployments';
import { createAgentWsRoutes } from './routes/agentWs';
import { createTerminalWsRoutes } from './routes/terminalWs';
import { createDesktopWsRoutes } from './routes/desktopWs';
import { agentVersionRoutes } from './routes/agentVersions';
import { viewerRoutes } from './routes/viewers';
import { aiRoutes } from './routes/ai';
import { mcpServerRoutes } from './routes/mcpServer';
import { devPushRoutes } from './routes/devPush';

// Workers
import { initializeAlertWorkers, shutdownAlertWorkers } from './jobs/alertWorker';
import { initializeOfflineDetector, shutdownOfflineDetector } from './jobs/offlineDetector';
import { initializeNotificationDispatcher, shutdownNotificationDispatcher } from './services/notificationDispatcher';
import { initializeEventLogRetention, shutdownEventLogRetention } from './jobs/eventLogRetention';
import { initializeAgentLogRetention, shutdownAgentLogRetention } from './jobs/agentLogRetention';
import { initializeDiscoveryWorker, shutdownDiscoveryWorker } from './jobs/discoveryWorker';
import { initializeSnmpWorker, shutdownSnmpWorker } from './jobs/snmpWorker';
import { initializeMonitorWorker, shutdownMonitorWorker } from './jobs/monitorWorker';
import { initializeSnmpRetention, shutdownSnmpRetention } from './jobs/snmpRetention';
import { initializePolicyEvaluationWorker, shutdownPolicyEvaluationWorker } from './jobs/policyEvaluationWorker';
import { initializeAutomationWorker, shutdownAutomationWorker } from './jobs/automationWorker';
import { initializeSecurityPostureWorker, shutdownSecurityPostureWorker } from './jobs/securityPostureWorker';
import { initializePatchComplianceReportWorker, shutdownPatchComplianceReportWorker } from './jobs/patchComplianceReportWorker';
import { initializePolicyAlertBridge } from './services/policyAlertBridge';
import { getWebhookWorker, initializeWebhookDelivery } from './workers/webhookDelivery';
import { initializeTransferCleanup, stopTransferCleanup } from './workers/transferCleanup';
import { closeRedis, getRedis, isRedisAvailable } from './services/redis';
import { getEventBus } from './services/eventBus';
import { writeAuditEvent } from './services/auditEvents';
import { createCorsOriginResolver } from './services/corsOrigins';
import { validateConfig } from './config/validate';
import { autoMigrate } from './db/autoMigrate';
import { syncBinaries } from './services/binarySync';
import * as dbModule from './db';
import { deviceGroups, devices, securityThreats, webhookDeliveries, webhooks as webhooksTable } from './db/schema';
import { and, eq, sql } from 'drizzle-orm';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;

  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

const REQUIRE_DB_ON_STARTUP = envFlag('REQUIRE_DB_ON_STARTUP', true);
const REQUIRE_REDIS_ON_STARTUP = envFlag(
  'REQUIRE_REDIS_ON_STARTUP',
  (process.env.NODE_ENV ?? 'development') === 'production'
);

const app = new Hono();

const readinessState: {
  dbOk: boolean;
  redisOk: boolean;
  workersHealthy: boolean;
  checkedAt: string | null;
} = {
  dbOk: false,
  redisOk: false,
  workersHealthy: false,
  checkedAt: null
};

function isReady(): boolean {
  const redisReady = REQUIRE_REDIS_ON_STARTUP ? readinessState.redisOk : true;
  return readinessState.dbOk && redisReady && readinessState.workersHealthy;
}

// Create WebSocket helpers (must be done before routes are registered)
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
const resolveCorsOrigin = createCorsOriginResolver({
  configuredOriginsRaw: process.env.CORS_ALLOWED_ORIGINS,
  nodeEnv: process.env.NODE_ENV
});

// Global middleware
app.use('*', logger());
app.use(
  '*',
  secureHeaders({
    // Override defaults to match Breeze security policy:
    // - HSTS: 1 year (secureHeaders default is 180 days / 15552000s)
    strictTransportSecurity: 'max-age=31536000; includeSubDomains',
    // - X-Frame-Options: DENY (default is SAMEORIGIN)
    xFrameOptions: 'DENY',
    // - Referrer-Policy: strict-origin-when-cross-origin (default is no-referrer)
    referrerPolicy: 'strict-origin-when-cross-origin',
  })
);
app.use('*', securityMiddleware());
app.use('*', prettyJSON());
app.use(
  '*',
  cors({
    origin: (origin) => resolveCorsOrigin(origin),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key', 'X-Breeze-CSRF'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'X-Request-Id'],
    maxAge: 86400
  })
);

const API_VERSION = '0.2.0';
const startedAt = Date.now();

// Health check — basic liveness with version and uptime
app.get('/health', (c) => {
  const uptimeSeconds = Math.floor((Date.now() - startedAt) / 1000);
  return c.json({
    status: 'ok',
    version: API_VERSION,
    uptime: uptimeSeconds
  });
});

// Kubernetes liveness probe — minimal 200 OK
app.get('/health/live', (c) => {
  return c.json({ status: 'ok' });
});

// Full readiness check — live DB + Redis connectivity
app.get('/health/ready', async (c) => {
  const checks: Record<string, string> = {};

  // Check database connectivity
  try {
    await runWithSystemDbAccess(async () => {
      await db.execute(sql`select 1`);
    });
    checks.database = 'ok';
  } catch (error) {
    checks.database = `error: ${error instanceof Error ? error.message : 'unknown'}`;
  }

  // Check Redis connectivity
  try {
    const redis = getRedis();
    if (!redis) {
      checks.redis = 'error: not configured';
    } else {
      await redis.ping();
      checks.redis = 'ok';
    }
  } catch (error) {
    checks.redis = `error: ${error instanceof Error ? error.message : 'unknown'}`;
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');

  return c.json(
    {
      status: allOk ? 'ready' : 'not_ready',
      checks
    },
    allOk ? 200 : 503
  );
});

// Legacy /ready alias (backward compatibility)
app.get('/ready', (c) => {
  const ready = isReady();
  return c.json(
    {
      ready,
      db: readinessState.dbOk,
      redis: readinessState.redisOk,
      workers: readinessState.workersHealthy,
      checkedAt: readinessState.checkedAt
    },
    ready ? 200 : 503
  );
});

// Metrics endpoint (for Prometheus scraping at /metrics)
app.route('/metrics', metricsRoutes);

// API routes
const api = new Hono();

const FALLBACK_AUDIT_PREFIXES = [
  '/alerts',
  '/snmp',
  '/agents',
  '/backup',
  '/script-library',
  '/portal',
  '/analytics',
  '/alert-templates',
  '/software',
  '/maintenance',
  '/psa',
  '/mobile',
  '/discovery',
  '/monitors',
  '/monitoring',
  '/sso',
  '/reports',
  '/filters',
  '/ai',
  '/notifications',
  '/custom-fields',
  '/access-reviews',
  '/mcp',
  '/audit-logs',
  '/agent-versions',
  '/viewers',
  '/devices',
  '/security',
  '/system-tools'
];

const FALLBACK_AUDIT_EXCLUDE_PATHS: RegExp[] = [
  // Agent telemetry endpoints are high-volume and many already emit explicit audit events.
  /^\/api\/v1\/agents\/[^/]+\/heartbeat$/,
  /^\/api\/v1\/agents\/[^/]+\/security\/status$/,
  /^\/api\/v1\/agents\/[^/]+\/eventlogs$/,
  /^\/api\/v1\/agents\/[^/]+\/logs$/,
  /^\/api\/v1\/agents\/[^/]+\/patches$/,
  /^\/api\/v1\/agents\/[^/]+\/commands\/[^/]+\/result$/,
  /^\/api\/v1\/agents\/[^/]+\/hardware$/,
  /^\/api\/v1\/agents\/[^/]+\/software$/,
  /^\/api\/v1\/agents\/[^/]+\/disks$/,
  /^\/api\/v1\/agents\/[^/]+\/network$/,
  /^\/api\/v1\/agents\/[^/]+\/connections$/,
  /^\/api\/v1\/agents\/[^/]+\/registry-state$/,
  /^\/api\/v1\/agents\/[^/]+\/config-state$/,
  /^\/api\/v1\/security\/recommendations\/[^/]+\/(complete|dismiss)$/,
  /^\/api\/v1\/system-tools\/devices\/[^/]+\/processes\/[^/]+\/kill$/,
  /^\/api\/v1\/system-tools\/devices\/[^/]+\/registry\/value$/,
  /^\/api\/v1\/system-tools\/devices\/[^/]+\/registry\/key$/,
  /^\/api\/v1\/system-tools\/devices\/[^/]+\/files\/upload$/
];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method);
}

function sanitizeActionSegment(segment: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
    return ':id';
  }
  if (/^[0-9]+$/.test(segment)) {
    return ':n';
  }
  if (segment.length > 24 && /^[0-9a-z-]+$/i.test(segment)) {
    return ':id';
  }
  return segment;
}

function isLikelyUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function buildFallbackAction(method: string, apiPath: string): string {
  const cleaned = apiPath.replace(/^\/api\/v1\//, '/');
  const segments = cleaned
    .split('/')
    .filter(Boolean)
    .map(sanitizeActionSegment)
    .slice(0, 4);

  const action = `api.${method.toLowerCase()}.${segments.join('.') || 'unknown'}`;
  return action.length > 100 ? action.slice(0, 100) : action;
}

function getResourceTypeFromPath(apiPath: string): string {
  const cleaned = apiPath.replace(/^\/api\/v1\//, '/');
  const first = cleaned.split('/').filter(Boolean)[0];
  return (first ?? 'system').slice(0, 50);
}

function fallbackAuditEligible(path: string): boolean {
  if (FALLBACK_AUDIT_EXCLUDE_PATHS.some((pattern) => pattern.test(path))) {
    return false;
  }

  return FALLBACK_AUDIT_PREFIXES.some((prefix) => path.startsWith(`/api/v1${prefix}`));
}

async function resolveFallbackOrgId(c: Context, path: string): Promise<string | null> {
  const auth = c.get('auth') as { orgId?: string | null; accessibleOrgIds?: string[] } | undefined;
  if (auth?.orgId) {
    return auth.orgId;
  }

  if (auth?.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }

  if (path.startsWith('/api/v1/agents/')) {
    const segments = path.split('/').filter(Boolean);
    const agentId = segments[3];
    if (!agentId || agentId === 'enroll') {
      return null;
    }

    try {
      const [device] = await db
        .select({ orgId: devices.orgId })
        .from(devices)
        .where(eq(devices.agentId, agentId))
        .limit(1);
      return device?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId from path:', err);
      return null;
    }
  }

  if (path.startsWith('/api/v1/devices/')) {
    const segments = path.split('/').filter(Boolean);
    const entity = segments[3];
    if (!entity) {
      return null;
    }

    if (entity === 'groups') {
      const groupId = segments[4];
      if (!groupId || !isLikelyUuid(groupId)) {
        return null;
      }

      try {
        const [group] = await db
          .select({ orgId: deviceGroups.orgId })
          .from(deviceGroups)
          .where(eq(deviceGroups.id, groupId))
          .limit(1);
        return group?.orgId ?? null;
      } catch (err) {
        console.error('[audit] Failed to resolve orgId from device group:', err);
        return null;
      }
    }

    if (!isLikelyUuid(entity)) {
      return null;
    }

    try {
      const [device] = await db
        .select({ orgId: devices.orgId })
        .from(devices)
        .where(eq(devices.id, entity))
        .limit(1);
      return device?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId from path:', err);
      return null;
    }
  }

  if (path.startsWith('/api/v1/security/scan/')) {
    const segments = path.split('/').filter(Boolean);
    const deviceId = segments[4];
    if (!deviceId || !isLikelyUuid(deviceId)) {
      return null;
    }

    try {
      const [device] = await db
        .select({ orgId: devices.orgId })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      return device?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId from path:', err);
      return null;
    }
  }

  if (path.startsWith('/api/v1/security/threats/')) {
    const segments = path.split('/').filter(Boolean);
    const threatId = segments[4];
    if (!threatId || !isLikelyUuid(threatId)) {
      return null;
    }

    try {
      const [threat] = await db
        .select({ orgId: devices.orgId })
        .from(securityThreats)
        .innerJoin(devices, eq(securityThreats.deviceId, devices.id))
        .where(eq(securityThreats.id, threatId))
        .limit(1);
      return threat?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId from path:', err);
      return null;
    }
  }

  if (path.startsWith('/api/v1/system-tools/devices/')) {
    const segments = path.split('/').filter(Boolean);
    const deviceId = segments[4];
    if (!deviceId || !isLikelyUuid(deviceId)) {
      return null;
    }

    try {
      const [device] = await db
        .select({ orgId: devices.orgId })
        .from(devices)
        .where(eq(devices.id, deviceId))
        .limit(1);
      return device?.orgId ?? null;
    } catch (err) {
      console.error('[audit] Failed to resolve orgId from path:', err);
      return null;
    }
  }

  return null;
}

api.use('*', async (c, next) => {
  await next();

  const method = c.req.method.toUpperCase();
  if (!isMutatingMethod(method)) {
    return;
  }

  const path = c.req.path;
  if (!fallbackAuditEligible(path)) {
    return;
  }

  if (c.res.status === 404) {
    return;
  }

  const orgId = await resolveFallbackOrgId(c, path);
  if (!orgId) {
    return;
  }

  const auth = c.get('auth') as { user?: { id?: string; email?: string }; orgId?: string | null } | undefined;
  const status = c.res.status;

  let result: 'success' | 'denied' | 'failure';
  if (status >= 200 && status < 400) {
    result = 'success';
  } else if (status === 401 || status === 403) {
    result = 'denied';
  } else {
    result = 'failure';
  }

  let actorType: 'user' | 'agent' | 'system';
  if (auth?.user?.id) {
    actorType = 'user';
  } else if (path.startsWith('/api/v1/agents/')) {
    actorType = 'agent';
  } else {
    actorType = 'system';
  }

  writeAuditEvent(c, {
    orgId,
    actorType,
    actorId: auth?.user?.id ?? undefined,
    actorEmail: auth?.user?.email,
    action: buildFallbackAction(method, path),
    resourceType: getResourceTypeFromPath(path),
    details: { path, method, statusCode: status, fallback: true },
    result
  });
});

api.route('/auth', authRoutes);
api.route('/agents', agentRoutes);
api.route('/devices', deviceRoutes);
api.route('/scripts', scriptRoutes);
api.route('/script-library', scriptLibraryRoutes);
api.route('/automations/webhooks', automationWebhookRoutes);
api.route('/automations', automationRoutes);
api.route('/alerts', alertRoutes);
api.route('/alert-templates', alertTemplateRoutes);
api.route('/orgs', orgRoutes);
api.route('/users', userRoutes);
api.route('/roles', roleRoutes);
api.route('/audit-logs', auditLogRoutes);
api.route('/backup', backupRoutes);
api.route('/reports', reportRoutes);
api.route('/search', searchRoutes);
api.route('/remote/sessions', createTerminalWsRoutes(upgradeWebSocket)); // WebSocket routes first (no auth middleware)
api.route('/desktop-ws', createDesktopWsRoutes(upgradeWebSocket)); // Desktop WebSocket routes (outside /remote to avoid auth middleware)
api.route('/remote', remoteRoutes);
api.route('/api-keys', apiKeyRoutes);
api.route('/enrollment-keys', enrollmentKeyRoutes);
api.route('/sso', ssoRoutes);
api.route('/docs', docsRoutes);
api.route('/access-reviews', accessReviewRoutes);
api.route('/webhooks', webhookRoutes);
api.route('/policies', policyRoutes);
api.route('/configuration-policies', configPolicyRoutes);
api.route('/psa', psaRoutes);
api.route('/patches', patchRoutes);
api.route('/patch-policies', patchPolicyRoutes);
api.route('/mobile', mobileRoutes);
api.route('/analytics', analyticsRoutes);
api.route('/discovery', discoveryRoutes);
api.route('/portal', portalRoutes);
api.route('/plugins', pluginRoutes);
api.route('/maintenance', maintenanceRoutes);
api.route('/security', securityRoutes);
api.route('/snmp', snmpRoutes);
api.route('/monitors', monitorRoutes);
api.route('/monitoring', monitoringRoutes);
api.route('/software', softwareRoutes);
api.route('/system-tools', systemToolsRoutes);
api.route('/notifications', notificationRoutes);
api.route('/groups', groupRoutes);
api.route('/device-groups', groupRoutes);
api.route('/integrations', integrationRoutes);
api.route('/partner', partnerRoutes);
api.route('/tags', tagRoutes);
api.route('/custom-fields', customFieldRoutes);
api.route('/filters', filterRoutes);
api.route('/deployments', deploymentRoutes);
api.route('/metrics', metricsRoutes);
api.route('/agent-ws', createAgentWsRoutes(upgradeWebSocket));
api.route('/agent-versions', agentVersionRoutes);
api.route('/viewers', viewerRoutes);
api.route('/ai', aiRoutes);
api.route('/mcp', mcpServerRoutes);
api.route('/dev', devPushRoutes);

app.route('/api/v1', api);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// Error handler
app.onError((err, c) => {
  // Handle HTTPException properly (e.g., 401, 403, etc.)
  if (err instanceof HTTPException) {
    return c.json(
      {
        error: err.message || 'Request failed',
        message: err.message
      },
      err.status
    );
  }

  console.error('Error:', err);
  return c.json(
    {
      error: 'Internal Server Error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined
    },
    500
  );
});

const port = parseInt(process.env.API_PORT || '3001', 10);

// Initialize background workers (only if Redis is available)
const workerStatus: Record<string, boolean> = {};
export function areWorkersHealthy(): boolean {
  return readinessState.workersHealthy;
}
export function getWorkerStatus(): Record<string, boolean> { return { ...workerStatus }; }

let server: ReturnType<typeof serve> | null = null;
let shutdownInProgress = false;

function headersToRecord(headers: unknown): Record<string, string> {
  if (!headers) return {};

  if (Array.isArray(headers)) {
    return headers.reduce<Record<string, string>>((acc, header) => {
      if (
        header
        && typeof header === 'object'
        && typeof (header as { key?: unknown }).key === 'string'
        && typeof (header as { value?: unknown }).value === 'string'
      ) {
        acc[(header as { key: string }).key] = (header as { value: string }).value;
      }
      return acc;
    }, {});
  }

  if (typeof headers === 'object') {
    return Object.entries(headers as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
      if (typeof value === 'string') {
        acc[key] = value;
      }
      return acc;
    }, {});
  }

  return {};
}

async function initializeWebhookDeliveryWorker(): Promise<void> {
  const webhookWorker = getWebhookWorker();

  webhookWorker.setDeliveryCallback(async (result) => {
    await runWithSystemDbAccess(async () => {
      const deliveryStatus = result.success ? 'delivered' : 'failed';
      const deliveredAt = result.success ? new Date(result.deliveredAt ?? new Date().toISOString()) : null;
      const responseTimeMs = typeof result.responseTimeMs === 'number'
        ? Math.max(0, Math.round(result.responseTimeMs))
        : null;

      await db
        .update(webhookDeliveries)
        .set({
          status: deliveryStatus,
          attempts: result.attempts,
          responseStatus: result.responseStatus ?? null,
          responseBody: result.responseBody ?? null,
          responseTimeMs,
          errorMessage: result.errorMessage ?? null,
          deliveredAt
        })
        .where(eq(webhookDeliveries.id, result.deliveryId));

      const aggregateUpdate = result.success
        ? {
          successCount: sql`${webhooksTable.successCount} + 1`,
          lastSuccessAt: new Date(),
          lastDeliveryAt: new Date()
        }
        : {
          failureCount: sql`${webhooksTable.failureCount} + 1`,
          lastDeliveryAt: new Date()
        };

      await db
        .update(webhooksTable)
        .set(aggregateUpdate)
        .where(eq(webhooksTable.id, result.webhookId));
    });
  });

  await initializeWebhookDelivery(
    async (orgId, eventType) => {
      return runWithSystemDbAccess(async () => {
        const rows = await db
          .select()
          .from(webhooksTable)
          .where(
            and(
              eq(webhooksTable.orgId, orgId),
              eq(webhooksTable.status, 'active')
            )
          );

        return rows
          .filter((webhook) => {
            const events = webhook.events ?? [];
            return events.includes(eventType) || events.includes('*');
          })
          .map((webhook) => ({
            id: webhook.id,
            orgId: webhook.orgId,
            name: webhook.name,
            url: webhook.url,
            secret: webhook.secret ?? undefined,
            events: webhook.events ?? [],
            headers: headersToRecord(webhook.headers),
            retryPolicy: (webhook.retryPolicy ?? undefined) as {
              maxRetries: number;
              backoffMultiplier: number;
              initialDelayMs: number;
              maxDelayMs: number;
            } | undefined
          }));
      });
    },
    async (webhook, event) => {
      return runWithSystemDbAccess(async () => {
        const [delivery] = await db
          .insert(webhookDeliveries)
          .values({
            webhookId: webhook.id,
            eventType: event.type,
            eventId: event.id,
            payload: event.payload,
            status: 'pending',
            attempts: 0
          })
          .returning({ id: webhookDeliveries.id });

        return delivery?.id ?? null;
      });
    }
  );
}

async function initializeWorkers(): Promise<void> {
  if (!readinessState.redisOk || !isRedisAvailable()) {
    console.warn('[WARN] Redis not available - background workers disabled');
    readinessState.workersHealthy = !REQUIRE_REDIS_ON_STARTUP;
    readinessState.checkedAt = new Date().toISOString();
    return;
  }

  const workers: Array<[string, () => Promise<void>]> = [
    ['alertWorkers', initializeAlertWorkers],
    ['offlineDetector', initializeOfflineDetector],
    ['notificationDispatcher', initializeNotificationDispatcher],
    ['webhookDelivery', initializeWebhookDeliveryWorker],
    ['policyEvaluationWorker', initializePolicyEvaluationWorker],
    ['automationWorker', initializeAutomationWorker],
    ['securityPostureWorker', initializeSecurityPostureWorker],
    ['policyAlertBridge', initializePolicyAlertBridge],
    ['eventLogRetention', initializeEventLogRetention],
    ['agentLogRetention', initializeAgentLogRetention],
    ['discoveryWorker', initializeDiscoveryWorker],
    ['snmpWorker', initializeSnmpWorker],
    ['monitorWorker', initializeMonitorWorker],
    ['snmpRetention', initializeSnmpRetention],
    ['patchComplianceReportWorker', initializePatchComplianceReportWorker],
  ];

  await Promise.allSettled(
    workers.map(async ([name, init]) => {
      try {
        await init();
        workerStatus[name] = true;
      } catch (error) {
        workerStatus[name] = false;
        console.error(`[CRITICAL] Failed to initialize ${name}:`, error);
      }
    })
  );

  const failed = Object.entries(workerStatus).filter(([, ok]) => !ok).map(([n]) => n);
  readinessState.workersHealthy = failed.length === 0;
  readinessState.checkedAt = new Date().toISOString();

  if (failed.length === 0) {
    console.log('All background workers initialized');
  } else {
    console.error(`[WARN] ${failed.length} worker(s) failed to initialize: ${failed.join(', ')}`);
  }
}

async function checkDatabaseConnectivity(): Promise<boolean> {
  try {
    await runWithSystemDbAccess(async () => {
      await db.execute(sql`select 1`);
    });
    return true;
  } catch (error) {
    console.error('[startup] Database connectivity check failed:', error);
    return false;
  }
}

async function checkRedisConnectivity(): Promise<boolean> {
  try {
    const redis = getRedis();
    if (!redis) {
      return false;
    }

    await redis.ping();
    return true;
  } catch (error) {
    console.error('[startup] Redis connectivity check failed:', error);
    return false;
  }
}

async function runStartupChecks(): Promise<void> {
  const [dbOk, redisOk] = await Promise.all([
    checkDatabaseConnectivity(),
    checkRedisConnectivity()
  ]);

  readinessState.dbOk = dbOk;
  readinessState.redisOk = redisOk;
  readinessState.checkedAt = new Date().toISOString();

  if (REQUIRE_DB_ON_STARTUP && !dbOk) {
    throw new Error('Database is required at startup but is unreachable');
  }

  if (REQUIRE_REDIS_ON_STARTUP && !redisOk) {
    throw new Error('Redis is required at startup but is unreachable');
  }
}

async function shutdownRuntime(signal: NodeJS.Signals): Promise<void> {
  if (shutdownInProgress) {
    return;
  }

  shutdownInProgress = true;
  console.log(`[shutdown] Received ${signal}, shutting down gracefully...`);

  stopTransferCleanup();
  getWebhookWorker().stop();

  const shutdownTasks: Array<() => Promise<void>> = [
    shutdownPatchComplianceReportWorker,
    shutdownSnmpRetention,
    shutdownMonitorWorker,
    shutdownSnmpWorker,
    shutdownDiscoveryWorker,
    shutdownEventLogRetention,
    shutdownAgentLogRetention,
    shutdownSecurityPostureWorker,
    shutdownAutomationWorker,
    shutdownPolicyEvaluationWorker,
    shutdownNotificationDispatcher,
    shutdownOfflineDetector,
    shutdownAlertWorkers,
    async () => getEventBus().close(),
    closeRedis,
    async () => {
      const closeDb = dbModule.closeDb;
      if (typeof closeDb === 'function') {
        await closeDb();
      }
    }
  ];

  const shutdownResults = await Promise.allSettled(shutdownTasks.map((task) => task()));
  const shutdownFailures = shutdownResults.filter((result) => result.status === 'rejected');

  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  }

  if (shutdownFailures.length > 0) {
    console.error(`[shutdown] Completed with ${shutdownFailures.length} failure(s)`);
    process.exit(1);
    return;
  }

  console.log('[shutdown] Complete');
  process.exit(0);
}

function installSignalHandlers(): void {
  process.once('SIGINT', () => {
    void shutdownRuntime('SIGINT');
  });

  process.once('SIGTERM', () => {
    void shutdownRuntime('SIGTERM');
  });
}

async function bootstrap(): Promise<void> {
  console.log(`Breeze API starting on port ${port}...`);

  // Validate configuration before anything else — fail fast on missing/insecure secrets.
  // The validated config is stored as a singleton; retrieve later via getConfig().
  const config = validateConfig();
  console.log(`[config] Validated: NODE_ENV=${config.NODE_ENV}, port=${config.API_PORT}`);

  await runStartupChecks();

  // Auto-migrate schema and seed on first boot (set AUTO_MIGRATE=false to disable)
  if (process.env.AUTO_MIGRATE !== 'false') {
    await autoMigrate();
  }

  // Register local agent binaries in DB and optionally sync to S3 (BINARY_SOURCE=local only)
  try {
    await syncBinaries();
  } catch (err) {
    console.error('[startup] Binary sync failed (non-fatal):', err);
  }

  server = serve({
    fetch: app.fetch,
    port
  });

  injectWebSocket(server);

  console.log(`Breeze API running at http://localhost:${port}`);
  console.log(`WebSocket endpoint available at ws://localhost:${port}/api/v1/agent-ws/:id/ws`);

  await initializeWorkers();
  initializeTransferCleanup();
  installSignalHandlers();
}

void bootstrap().catch((error) => {
  console.error('[CRITICAL] API startup failed:', error);
  process.exit(1);
});
