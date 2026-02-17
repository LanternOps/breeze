import { Hono } from 'hono';
import { agentAuthMiddleware } from '../../middleware/agentAuth';
import { downloadRoutes } from './download';
import { enrollRoutes } from './enroll';
import { heartbeatRoutes } from './heartbeat';
import { securityRoutes } from './security';
import { commandResultsRoutes } from './commandResults';
import { inventoryRoutes } from './inventory';
import { stateReportingRoutes } from './stateReporting';
import { sessionsRoutes } from './sessions';
import { patchesRoutes } from './patches';
import { logsRoutes } from './logs';
import { mtlsRoutes } from './mtls';
import { quarantineRoutes } from './quarantine';

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
  // Check if the sub-path is an admin endpoint that uses user JWT auth
  const path = c.req.path;
  if (path.endsWith('/approve') || path.endsWith('/deny')) {
    return next();
  }
  return agentAuthMiddleware(c, next);
});

// Mount fixed-path routes first (before /:id wildcards)
agentRoutes.route('/', downloadRoutes);
agentRoutes.route('/', enrollRoutes);
agentRoutes.route('/', mtlsRoutes);
agentRoutes.route('/', quarantineRoutes);

// Mount /:id/* routes
agentRoutes.route('/', heartbeatRoutes);
agentRoutes.route('/', securityRoutes);
agentRoutes.route('/', commandResultsRoutes);
agentRoutes.route('/', inventoryRoutes);
agentRoutes.route('/', stateReportingRoutes);
agentRoutes.route('/', sessionsRoutes);
agentRoutes.route('/', patchesRoutes);
agentRoutes.route('/', logsRoutes);

// Re-export helpers and schemas for potential use elsewhere
export * from './helpers';
export * from './schemas';
