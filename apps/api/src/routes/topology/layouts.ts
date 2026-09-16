import { Hono } from 'hono';
import { layoutPatchSchema, topologyViewSchema } from '@breeze/shared';
import { saveTopologyLayout } from '../../services/topology/layouts';
import { expectedRevisionSchema, parseWrite } from '../../services/topology/writes';
import { requireTopologySiteCapability } from './middleware';
import { topologyMutation } from './mutations';

export const topologyLayoutRoutes = new Hono();
topologyLayoutRoutes.patch('/sites/:siteId/layouts/:view', requireTopologySiteCapability('write'), topologyMutation((c, body) =>
  saveTopologyLayout(c.get('topologyContext'), parseWrite(topologyViewSchema, c.req.param('view')), parseWrite(layoutPatchSchema.extend({ expectedRevision: expectedRevisionSchema }), body))));
