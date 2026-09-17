import { Hono } from 'hono';

import { authMiddleware } from '../../middleware/auth';
import { topologyTargetRoutes } from './targets';
import { topologyPolicyRoutes } from './policies';
import { topologyTemplateApplicationRoutes } from './templateApplications';
import { topologyTemplateRoutes } from './templates';
import { topologySettingsRoutes } from './settings';
import { topologyGraphRoutes } from './graphs';
import { topologyManualRoutes } from './manual';
import { topologyLayoutRoutes } from './layouts';

export { requireTopologySiteCapability } from './middleware';

/**
 * Authenticated topology route hub. Milestone leaves mount relative
 * `/sites/:siteId/...` paths here as they land.
 */
export function createTopologyRoutes(): Hono {
  const routes = new Hono();
  routes.use('*', authMiddleware);
  routes.route('/', topologyTemplateRoutes);
  routes.route('/', topologyTemplateApplicationRoutes);
  routes.route('/', topologyTargetRoutes);
  routes.route('/', topologyPolicyRoutes);
  routes.route('/', topologySettingsRoutes);
  routes.route('/', topologyGraphRoutes);
  routes.route('/', topologyManualRoutes);
  routes.route('/', topologyLayoutRoutes);
  return routes;
}

export const topologyRoutes = createTopologyRoutes();
