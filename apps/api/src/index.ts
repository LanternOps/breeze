import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
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

const app = new Hono();

// Global middleware
app.use('*', logger());
app.use('*', secureHeaders());
app.use('*', prettyJSON());
app.use(
  '*',
  cors({
    origin: ['http://localhost:4321'],
    credentials: true
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

app.route('/api/v1', api);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found', path: c.req.path }, 404);
});

// Error handler
app.onError((err, c) => {
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

serve({
  fetch: app.fetch,
  port
});

console.log(`Breeze API running at http://localhost:${port}`);
