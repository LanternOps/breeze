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
import { bootPerformanceRoutes } from './bootPerformance';
import { reliabilityRoutes } from './reliability';
import { changesRoutes } from './changes';
import { peripheralRoutes } from './peripherals';
import { tokenRoutes } from './token';
import { elevationRequestsRoutes } from './elevationRequests';

export const agentRoutes = new Hono();

// Sub-paths under /:id/* that handle their own (user-JWT) auth and skip agent-token auth.
export const AGENT_AUTH_SKIP_ID_SEGMENTS = new Set([
  'enroll', 'renew-cert', 'quarantined', 'org', 'download',
]);
// Routes of the exact shape /:id/<action> that use user JWT auth.
export const AGENT_AUTH_SKIP_ACTIONS = new Set(['approve', 'deny']);

export function shouldSkipAgentAuth(path: string, id: string): boolean {
  if (AGENT_AUTH_SKIP_ID_SEGMENTS.has(id)) return true;
  const segments = path.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const secondLast = segments[segments.length - 2] ?? '';
  // Only the EXACT shape .../<id>/<action> skips — never a deeper nested path.
  return secondLast === id && AGENT_AUTH_SKIP_ACTIONS.has(last);
}

agentRoutes.use('/:id/*', async (c, next) => {
  if (shouldSkipAgentAuth(c.req.path, c.req.param('id') ?? '')) return next();
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
agentRoutes.route('/', tokenRoutes);
agentRoutes.route('/', patchesRoutes);
agentRoutes.route('/', connectionsRoutes);
agentRoutes.route('/', eventLogsRoutes);
agentRoutes.route('/', logsRoutes);
agentRoutes.route('/', bootPerformanceRoutes);
agentRoutes.route('/', reliabilityRoutes);
agentRoutes.route('/', changesRoutes);
agentRoutes.route('/', peripheralRoutes);
agentRoutes.route('/', elevationRequestsRoutes);
