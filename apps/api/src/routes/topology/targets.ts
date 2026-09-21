import { Hono } from 'hono';
import { requireTopologySiteCapability } from './middleware';
import { siteScopedQuery } from './query';
import { topologyOperation } from './operations';
import {
  upsertTopologyProbeTarget,
  listTopologyConfigurationObjects,
  deleteTopologyConfigurationObject,
  topologyTargetWriteSchema,
  topologyConfigurationDeleteSchema,
  topologyConfigurationPageSchema,
} from '../../services/topology/configurationObjects';
export const topologyTargetRoutes = new Hono();
const base = '/sites/:siteId/targets';
topologyTargetRoutes.get(
  base,
  requireTopologySiteCapability('read'),
  topologyOperation((c) =>
    listTopologyConfigurationObjects(
      c.get('topologyContext'),
      'targets',
      topologyConfigurationPageSchema.parse(siteScopedQuery(c)),
    ),
  ),
);
topologyTargetRoutes.post(
  base,
  requireTopologySiteCapability('configure'),
  topologyOperation(
    (c, body) =>
      upsertTopologyProbeTarget(
        c.get('topologyContext'),
        topologyTargetWriteSchema.parse(body),
      ),
    { mutation: true, status: 201 },
  ),
);
topologyTargetRoutes.patch(
  `${base}/:id`,
  requireTopologySiteCapability('configure'),
  topologyOperation(
    (c, body) =>
      upsertTopologyProbeTarget(
        c.get('topologyContext'),
        topologyTargetWriteSchema.parse(body),
        c.req.param('id')!,
      ),
    { mutation: true },
  ),
);
topologyTargetRoutes.delete(
  `${base}/:id`,
  requireTopologySiteCapability('configure'),
  topologyOperation(
    (c, body) =>
      deleteTopologyConfigurationObject(
        c.get('topologyContext'),
        'targets',
        c.req.param('id')!,
        topologyConfigurationDeleteSchema.parse(body),
      ),
    { mutation: true },
  ),
);
