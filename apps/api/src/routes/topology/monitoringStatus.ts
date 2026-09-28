import { Hono } from 'hono';
import { getTopologyMonitoringStatus } from '../../services/topology/monitoringStatus';
import { requireTopologySiteCapability } from './middleware';
import { topologyOperation } from './operations';

/** Read-only monitoring status (M3-D12): served to humans and to the `get_topology_monitoring_status` tool. */
export const topologyMonitoringStatusRoutes = new Hono();

topologyMonitoringStatusRoutes.get(
  '/sites/:siteId/monitoring',
  requireTopologySiteCapability('read'),
  topologyOperation((c) => getTopologyMonitoringStatus(c.get('topologyContext'))),
);
