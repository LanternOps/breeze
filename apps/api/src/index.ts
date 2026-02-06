import 'dotenv/config';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
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
import { auditRoutes } from './routes/audit';
import { auditLogRoutes } from './routes/auditLogs';
import { backupRoutes } from './routes/backup';
import { reportRoutes } from './routes/reports';
import { remoteRoutes } from './routes/remote';
import { apiKeyRoutes } from './routes/apiKeys';
import { ssoRoutes } from './routes/sso';
import { docsRoutes } from './routes/docs';
import { accessReviewRoutes } from './routes/accessReviews';
import { webhookRoutes } from './routes/webhooks';
import { policyRoutes } from './routes/policies';
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
import { softwareRoutes } from './routes/software';
import { systemToolsRoutes } from './routes/systemTools';
import { notificationRoutes } from './routes/notifications';
import { metricsRoutes } from './routes/metrics';
import { groupRoutes } from './routes/groups';
import { tagRoutes } from './routes/tags';
import { customFieldRoutes } from './routes/customFields';
import { filterRoutes } from './routes/filters';
import { deploymentRoutes } from './routes/deployments';
import { createAgentWsRoutes } from './routes/agentWs';
import { createTerminalWsRoutes } from './routes/terminalWs';
import { agentVersionRoutes } from './routes/agentVersions';

// Workers
import { initializeAlertWorkers } from './jobs/alertWorker';
import { initializeOfflineDetector } from './jobs/offlineDetector';
import { initializeNotificationDispatcher } from './services/notificationDispatcher';
import { initializeEventLogRetention } from './jobs/eventLogRetention';
import { isRedisAvailable } from './services/redis';

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
      const allowedOrigins = ['http://localhost:4321', 'http://localhost:4322'];
      return allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
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
api.route('/audit', auditRoutes);
api.route('/audit-logs', auditLogRoutes);
api.route('/backup', backupRoutes);
api.route('/reports', reportRoutes);
api.route('/remote/sessions', createTerminalWsRoutes(upgradeWebSocket)); // WebSocket routes first (no auth middleware)
api.route('/remote', remoteRoutes);
api.route('/api-keys', apiKeyRoutes);
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
api.route('/software', softwareRoutes);
api.route('/system-tools', systemToolsRoutes);
api.route('/notifications', notificationRoutes);
api.route('/groups', groupRoutes);
api.route('/tags', tagRoutes);
api.route('/custom-fields', customFieldRoutes);
api.route('/filters', filterRoutes);
api.route('/deployments', deploymentRoutes);
api.route('/metrics', metricsRoutes);
api.route('/agent-ws', createAgentWsRoutes(upgradeWebSocket));
api.route('/agent-versions', agentVersionRoutes);

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
let workersHealthy = false;
export function areWorkersHealthy(): boolean { return workersHealthy; }

async function initializeWorkers(): Promise<void> {
  if (!isRedisAvailable()) {
    console.warn('[WARN] Redis not available - background workers disabled');
    return;
  }

  try {
    await initializeAlertWorkers();
    await initializeOfflineDetector();
    await initializeNotificationDispatcher();
    await initializeEventLogRetention();
    workersHealthy = true;
    console.log('Background workers initialized');
  } catch (error) {
    workersHealthy = false;
    console.error('[CRITICAL] Failed to initialize background workers:', error);
  }
}

// Run worker initialization
initializeWorkers();
