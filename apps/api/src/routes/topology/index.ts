import { Hono } from 'hono';

import { authMiddleware } from '../../middleware/auth';
import { topologySettingsRoutes } from './settings';

export { requireTopologySiteCapability } from './middleware';

/**
 * Authenticated topology route hub. Milestone leaves mount relative
 * `/sites/:siteId/...` paths here as they land.
 */
export function createTopologyRoutes(): Hono {
  const routes = new Hono();
  routes.use('*', authMiddleware);
  routes.route('/', topologySettingsRoutes);
  return routes;
}

export const topologyRoutes = createTopologyRoutes();
