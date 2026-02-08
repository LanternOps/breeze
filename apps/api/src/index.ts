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

import { authRoutes } from './routes/auth';
import { agentRoutes } from './routes/agents';
import { deviceRoutes } from './routes/devices';
import { scriptRoutes } from './routes/scripts';
import { scriptLibraryRoutes } from './routes/scriptLibrary';
import { automationRoutes } from './routes/automations';
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
import { aiRoutes } from './routes/ai';
import { mcpServerRoutes } from './routes/mcpServer';

// Workers
import { initializeAlertWorkers } from './jobs/alertWorker';
import { initializeOfflineDetector } from './jobs/offlineDetector';
import { initializeNotificationDispatcher } from './services/notificationDispatcher';
import { initializeEventLogRetention } from './jobs/eventLogRetention';
import { initializeDiscoveryWorker } from './jobs/discoveryWorker';
import { initializeSnmpWorker } from './jobs/snmpWorker';
import { initializeMonitorWorker } from './jobs/monitorWorker';
import { initializeSnmpRetention } from './jobs/snmpRetention';
import { initializePolicyEvaluationWorker } from './jobs/policyEvaluationWorker';
import { initializePolicyAlertBridge } from './services/policyAlertBridge';
import { getWebhookWorker, initializeWebhookDelivery } from './workers/webhookDelivery';
import { initializeTransferCleanup } from './workers/transferCleanup';
import { isRedisAvailable } from './services/redis';
import { writeAuditEvent } from './services/auditEvents';
import { db } from './db';
import { deviceGroups, devices, securityThreats, webhookDeliveries, webhooks as webhooksTable } from './db/schema';
import { and, eq, sql } from 'drizzle-orm';

const app = new Hono();

// Create WebSocket helpers (must be done before routes are registered)
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// Global middleware
app.use('*', logger());
app.use('*', secureHeaders());
app.use('*', prettyJSON());
app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowedOrigins = ['http://localhost:4321', 'http://localhost:4322', 'http://localhost:1420', 'tauri://localhost'];
      return allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'X-Request-Id'],
    maxAge: 86400
  })
);

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0'
  });
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
  '/devices',
  '/security',
  '/system-tools'
];

const FALLBACK_AUDIT_EXCLUDE_PATHS: RegExp[] = [
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
api.route('/ai', aiRoutes);
api.route('/mcp', mcpServerRoutes);

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

console.log(`Breeze API starting on port ${port}...`);

const server = serve({
  fetch: app.fetch,
  port
});

// Inject WebSocket support into the HTTP server
injectWebSocket(server);

console.log(`Breeze API running at http://localhost:${port}`);
console.log(`WebSocket endpoint available at ws://localhost:${port}/api/v1/agent-ws/:id/ws`);

// Initialize background workers (only if Redis is available)
const workerStatus: Record<string, boolean> = {};
export function areWorkersHealthy(): boolean {
  return Object.keys(workerStatus).length > 0 && Object.values(workerStatus).every(Boolean);
}
export function getWorkerStatus(): Record<string, boolean> { return { ...workerStatus }; }

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

  await initializeWebhookDelivery(
    async (orgId, eventType) => {
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
    },
    async (webhook, event) => {
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
    }
  );
}

async function initializeWorkers(): Promise<void> {
  if (!isRedisAvailable()) {
    console.warn('[WARN] Redis not available - background workers disabled');
    return;
  }

  const workers: Array<[string, () => Promise<void>]> = [
    ['alertWorkers', initializeAlertWorkers],
    ['offlineDetector', initializeOfflineDetector],
    ['notificationDispatcher', initializeNotificationDispatcher],
    ['webhookDelivery', initializeWebhookDeliveryWorker],
    ['policyEvaluationWorker', initializePolicyEvaluationWorker],
    ['policyAlertBridge', initializePolicyAlertBridge],
    ['eventLogRetention', initializeEventLogRetention],
    ['discoveryWorker', initializeDiscoveryWorker],
    ['snmpWorker', initializeSnmpWorker],
    ['monitorWorker', initializeMonitorWorker],
    ['snmpRetention', initializeSnmpRetention],
  ];

  for (const [name, init] of workers) {
    try {
      await init();
      workerStatus[name] = true;
    } catch (error) {
      workerStatus[name] = false;
      console.error(`[CRITICAL] Failed to initialize ${name}:`, error);
    }
  }

  const failed = Object.entries(workerStatus).filter(([, ok]) => !ok).map(([n]) => n);
  if (failed.length === 0) {
    console.log('All background workers initialized');
  } else {
    console.error(`[WARN] ${failed.length} worker(s) failed to initialize: ${failed.join(', ')}`);
  }
}

// Run worker initialization
initializeWorkers().catch((err) => {
  console.error('[CRITICAL] Worker initialization failed unexpectedly:', err);
});

// Transfer file cleanup (no Redis required)
initializeTransferCleanup();
