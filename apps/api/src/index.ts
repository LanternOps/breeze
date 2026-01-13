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
import { automationRoutes } from './routes/automations';
import { alertRoutes } from './routes/alerts';
import { orgRoutes } from './routes/orgs';
import { userRoutes } from './routes/users';
import { auditRoutes } from './routes/audit';
import { reportRoutes } from './routes/reports';
import { remoteRoutes } from './routes/remote';

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
api.route('/automations', automationRoutes);
api.route('/alerts', alertRoutes);
api.route('/orgs', orgRoutes);
api.route('/users', userRoutes);
api.route('/audit', auditRoutes);
api.route('/reports', reportRoutes);
api.route('/remote', remoteRoutes);

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
