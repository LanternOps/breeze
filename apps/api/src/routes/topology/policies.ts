import { Hono } from 'hono';
import { requireTopologySiteCapability } from './middleware';
import { siteScopedQuery } from './query';
import { topologyOperation } from './operations';
import {
  upsertTopologyMonitoringPolicy,
  listTopologyConfigurationObjects,
  deleteTopologyConfigurationObject,
  topologyPolicyWriteSchema,
  topologyConfigurationDeleteSchema,
  topologyConfigurationPageSchema,
} from '../../services/topology/configurationObjects';
export const topologyPolicyRoutes = new Hono();
const base = '/sites/:siteId/policies';
topologyPolicyRoutes.get(
  base,
  requireTopologySiteCapability('read'),
  topologyOperation((c) =>
    listTopologyConfigurationObjects(
      c.get('topologyContext'),
      'policies',
      topologyConfigurationPageSchema.parse(siteScopedQuery(c)),
    ),
  ),
);
topologyPolicyRoutes.post(
  base,
  requireTopologySiteCapability('configure'),
  topologyOperation(
    (c, body) =>
      upsertTopologyMonitoringPolicy(
        c.get('topologyContext'),
        topologyPolicyWriteSchema.parse(body),
      ),
    { mutation: true, status: 201 },
  ),
);
topologyPolicyRoutes.patch(
  `${base}/:id`,
  requireTopologySiteCapability('configure'),
  topologyOperation(
    (c, body) =>
      upsertTopologyMonitoringPolicy(
        c.get('topologyContext'),
        topologyPolicyWriteSchema.parse(body),
        c.req.param('id')!,
      ),
    { mutation: true },
  ),
);
topologyPolicyRoutes.delete(
  `${base}/:id`,
  requireTopologySiteCapability('configure'),
  topologyOperation(
    (c, body) =>
      deleteTopologyConfigurationObject(
        c.get('topologyContext'),
        'policies',
        c.req.param('id')!,
        topologyConfigurationDeleteSchema.parse(body),
      ),
    { mutation: true },
  ),
);
