import { Hono } from 'hono';
import { agentAuthMiddleware } from '../../middleware/agentAuth';
import { downloadRoutes } from './download';
import { enrollmentRoutes } from './enrollment';
import { heartbeatRoutes } from './heartbeat';
import { commandsRoutes } from './commands';
import { agentSecurityRoutes } from './security';
import { inventoryRoutes } from './inventory';
import { stateRoutes } from './state';
import { sessionsRoutes } from './sessions';
import { patchesRoutes } from './patches';
import { connectionsRoutes } from './connections';
import { eventLogsRoutes } from './eventlogs';
import { logsRoutes } from './logs';
import { mtlsRoutes } from './mtls';

export const agentRoutes = new Hono();

// Apply agent auth to all parameterized routes.
// Skip for endpoints that handle their own authentication:
// - /enroll, /renew-cert, /quarantined (special endpoints matched as /:id)
// - /org/* (org settings, uses user JWT auth)
// - /:id/approve, /:id/deny (admin endpoints, use user JWT auth)
agentRoutes.use('/:id/*', async (c, next) => {
  const id = c.req.param('id');
  if (id === 'enroll' || id === 'renew-cert' || id === 'quarantined' || id === 'org' || id === 'download') {
    return next();
  }
  const path = c.req.path;
  if (path.endsWith('/approve') || path.endsWith('/deny')) {
    return next();
  }
  return agentAuthMiddleware(c, next);
});

// Mount static/public routes first
agentRoutes.route('/', downloadRoutes);

// Mount mTLS routes (special paths like /renew-cert, /quarantined, /org/*)
agentRoutes.route('/', mtlsRoutes);

// Mount enrollment
agentRoutes.route('/', enrollmentRoutes);

// Mount all `:id/*` routes
agentRoutes.route('/', heartbeatRoutes);
agentRoutes.route('/', commandsRoutes);
agentRoutes.route('/', agentSecurityRoutes);
agentRoutes.route('/', inventoryRoutes);
agentRoutes.route('/', stateRoutes);
agentRoutes.route('/', sessionsRoutes);
agentRoutes.route('/', patchesRoutes);
agentRoutes.route('/', connectionsRoutes);
agentRoutes.route('/', eventLogsRoutes);
agentRoutes.route('/', logsRoutes);

