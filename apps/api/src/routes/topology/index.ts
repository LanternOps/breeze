import { Hono } from 'hono';

import { authMiddleware } from '../../middleware/auth';
import { topologyDiagnosticRoutes } from './diagnostics';
import { topologyTargetRoutes } from './targets';
import { topologyPolicyRoutes } from './policies';
import { topologyTemplateApplicationRoutes } from './templateApplications';
import { topologyTemplateRoutes } from './templates';
import { topologySettingsRoutes } from './settings';
import { topologyGraphRoutes } from './graphs';
import { topologyHistoryRoutes } from './history';
import { topologyInvestigationRoutes } from './investigation';
import { topologyManualRoutes } from './manual';
import { topologyExclusionRoutes } from './exclusions';
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
  routes.route('/', topologyHistoryRoutes);
  routes.route('/', topologyInvestigationRoutes);
  routes.route('/', topologyManualRoutes);
  routes.route('/', topologyExclusionRoutes);
  routes.route('/', topologyLayoutRoutes);
  routes.route('/', topologyDiagnosticRoutes);
  return routes;
}

export const topologyRoutes = createTopologyRoutes();
